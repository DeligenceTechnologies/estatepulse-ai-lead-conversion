import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { AssistantActionStatus, AssistantRole, Prisma, type AssistantAction } from '@prisma/client';
import { AuditService } from '@/audit/audit.service';
import type { AuthContext } from '@/auth/auth.types';
import { AppError } from '@/common/errors/app-error';
import { TENANT_PRISMA, type GuardedPrisma } from '@/common/prisma/prisma.service';
import { AssistantRefService } from './assistant-ref.service';
import { AssistantThreadService } from './assistant-thread.service';
import type { StoredBlock, ToolCall } from './providers/model-provider';
import type { ActionPreview, AssistantTool, ToolContext } from './tools/tool';
import { ToolRegistry } from './tools/tool-registry.service';

const PROPOSAL_TTL_MS = 10 * 60_000;
/** A write still "executing" after this long died mid-run; its outcome is unknown. */
const EXECUTING_STALE_MS = 2 * 60_000;
const MAX_RESULT_CHARS = 20_000;

type ToolResult = Extract<StoredBlock, { type: 'tool_result' }>;

const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;

const truncate = (s: string) => (s.length > MAX_RESULT_CHARS ? `${s.slice(0, MAX_RESULT_CHARS)}… (truncated)` : s);

/** A message fit for the model and the user: ours as written, anything unexpected as a generic line. */
function reasonOf(error: unknown, logger: Logger, tool: string): string {
  if (error instanceof AppError) return error.message;
  if (error instanceof HttpException) {
    const body = error.getResponse() as { error?: { message?: string }; message?: string | string[] };
    const message = body?.error?.message ?? body?.message;
    return Array.isArray(message) ? message.join('; ') : (message ?? error.message);
  }
  logger.error(`tool ${tool} failed: ${(error as Error)?.stack ?? String(error)}`);
  return 'Something went wrong running this step.';
}

@Injectable()
export class AssistantActionService {
  private readonly logger = new Logger(AssistantActionService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma,
    private readonly registry: ToolRegistry,
    private readonly threads: AssistantThreadService,
    private readonly audit: AuditService,
    private readonly refs: AssistantRefService,
  ) {}

  /** What a tool runs with: the user, and the refs of the chat the call came from. */
  private context(auth: AuthContext, threadId: string): ToolContext {
    return { auth, refs: this.refs.forThread(auth, threadId) };
  }

  /** Runs a read at once; turns a write into a proposal the user must confirm. */
  async handle(auth: AuthContext, threadId: string, messageId: string, call: ToolCall): Promise<AssistantAction> {
    const base = { orgId: auth.organizationId, userId: auth.userId, threadId, messageId, toolUseId: call.id, toolName: call.name, input: json(call.input) };
    const tool = this.registry.get(call.name);

    if (!tool || !this.registry.allows(auth, tool)) {
      return this.prisma.assistantAction.create({
        data: { ...base, tier: tool?.tier ?? 'read', status: 'failed', error: 'This tool is not available to this user.' },
      });
    }

    const parsed = tool.input.safeParse(call.input);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
      return this.prisma.assistantAction.create({ data: { ...base, tier: tool.tier, status: 'failed', error: `Invalid input. ${issues}` } });
    }

    if (tool.tier === 'read') {
      try {
        const result = await tool.run(this.context(auth, threadId), parsed.data);
        return this.prisma.assistantAction.create({ data: { ...base, tier: 'read', status: 'executed', result: json(result), decidedAt: new Date() } });
      } catch (error) {
        return this.prisma.assistantAction.create({ data: { ...base, tier: 'read', status: 'failed', error: reasonOf(error, this.logger, tool.name) } });
      }
    }

    let preview: ActionPreview;
    try {
      preview = await tool.preview(this.context(auth, threadId), parsed.data);
    } catch (error) {
      return this.prisma.assistantAction.create({ data: { ...base, tier: 'write', status: 'failed', error: reasonOf(error, this.logger, tool.name) } });
    }
    return this.prisma.assistantAction.create({
      data: {
        ...base,
        tier: 'write',
        status: 'proposed',
        preview: json({ title: preview.title, summary: preview.summary, changes: preview.changes }),
        entityType: preview.entity?.type,
        entityId: preview.entity?.id,
        entityVersion: preview.entity?.version,
        expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS),
      },
    });
  }

  async require(auth: AuthContext, actionId: string): Promise<AssistantAction> {
    const action = await this.prisma.assistantAction.findFirst({ where: { id: actionId, orgId: auth.organizationId, userId: auth.userId } });
    if (!action) throw new AppError('NOT_FOUND', 'No such action.');
    return action;
  }

  async confirm(auth: AuthContext, actionId: string): Promise<AssistantAction> {
    const action = await this.require(auth, actionId);
    this.assertOpen(action);

    if (action.expiresAt && action.expiresAt.getTime() < Date.now()) {
      await this.close(action.id, 'expired', 'Not confirmed in time; nothing was changed.');
      throw new AppError('ACTION_EXPIRED', 'This confirmation expired. Ask the assistant again.', undefined, 410);
    }

    const tool = this.registry.get(action.toolName);
    if (!tool || tool.tier !== 'write' || !this.registry.allows(auth, tool)) {
      await this.close(action.id, 'failed', 'This tool is no longer available to this user.');
      throw new AppError('FORBIDDEN', 'You no longer have permission for this action.');
    }
    // Valid when proposed; a deploy since then can change the tool's input shape.
    const parsed = tool.input.safeParse(action.input);
    if (!parsed.success) {
      await this.close(action.id, 'failed', 'This step was prepared by an older version of the assistant. Ask again.');
      throw new AppError('ACTION_STALE', 'This card is out of date. Ask the assistant again.', undefined, 409);
    }
    const input = parsed.data;
    const ctx = this.context(auth, action.threadId);

    await this.assertFresh(ctx, action, tool, input);

    const claimed = await this.prisma.assistantAction.updateMany({
      where: { id: action.id, orgId: auth.organizationId, status: 'proposed' },
      data: { status: 'executing', decidedAt: new Date() },
    });
    if (claimed.count === 0) throw new AppError('ACTION_DECIDED', 'This action was already handled.', undefined, 409);

    try {
      const result = await tool.run(ctx, input);
      this.audit.quietly({
        orgId: auth.organizationId,
        actorType: 'ai',
        actorId: auth.userId,
        action: `assistant.${tool.name}`,
        entityType: action.entityType ?? 'assistant_action',
        entityId: action.entityId ?? action.id,
        payload: { assistantActionId: action.id, threadId: action.threadId },
      });
      return this.prisma.assistantAction.update({ where: { id: action.id, orgId: auth.organizationId }, data: { status: 'executed', result: json(result) } });
    } catch (error) {
      return this.prisma.assistantAction.update({
        where: { id: action.id, orgId: auth.organizationId },
        data: { status: 'failed', error: reasonOf(error, this.logger, tool.name) },
      });
    }
  }

  async reject(auth: AuthContext, actionId: string): Promise<AssistantAction> {
    const action = await this.require(auth, actionId);
    this.assertOpen(action);
    const closed = await this.close(action.id, 'rejected', 'The user declined this action. Nothing was changed. Do not retry unless asked.');
    if (!closed) throw new AppError('ACTION_DECIDED', 'This action was already handled.', undefined, 409);
    return this.require(auth, actionId);
  }

  /**
   * True while the chat ends in tool calls that have no results yet, for example a write that was
   * still running when the server stopped. A new message then would break the history: the model
   * API refuses a tool call that is not followed by its result.
   */
  async awaitingResults(orgId: string, threadId: string): Promise<boolean> {
    const last = await this.threads.lastMessage(orgId, threadId);
    if (!last || last.role !== AssistantRole.assistant) return false;
    return (last.content as unknown as StoredBlock[]).some((b) => b.type === 'tool_use');
  }

  /** True once every tool call of the message has an outcome. */
  async settled(orgId: string, messageId: string): Promise<boolean> {
    const open = await this.prisma.assistantAction.count({ where: { orgId, messageId, status: { in: ['proposed', 'executing'] } } });
    return open === 0;
  }

  /**
   * If the thread ends in tool calls, closes whatever is still open and appends their results,
   * so the history is valid to send again. Returns true when results were appended.
   * `supersede` is set when the user moved on: open proposals are then declined.
   */
  async closeOpenCalls(auth: AuthContext, threadId: string, supersede: boolean): Promise<boolean> {
    const orgId = auth.organizationId;
    const last = await this.threads.lastMessage(orgId, threadId);
    if (!last || last.role !== AssistantRole.assistant) return false;
    const calls = (last.content as unknown as StoredBlock[]).filter((b): b is Extract<StoredBlock, { type: 'tool_use' }> => b.type === 'tool_use');
    if (calls.length === 0) return false;

    const actions = await this.prisma.assistantAction.findMany({ where: { orgId, messageId: last.id } });
    const byUse = new Map(actions.map((a) => [a.toolUseId, a]));
    const now = Date.now();

    for (const a of actions) {
      if (a.status === 'proposed' && a.expiresAt && a.expiresAt.getTime() < now) {
        await this.close(a.id, 'expired', 'Not confirmed in time; nothing was changed.');
      } else if (a.status === 'proposed' && supersede) {
        await this.close(a.id, 'rejected', 'The user sent a new message instead of confirming. Nothing was changed.');
      } else if (a.status === 'proposed') {
        return false;
      } else if (a.status === 'executing') {
        if (!a.decidedAt || now - a.decidedAt.getTime() < EXECUTING_STALE_MS) return false;
        await this.prisma.assistantAction.updateMany({
          where: { id: a.id, orgId, status: 'executing' },
          data: { status: 'failed', error: 'The outcome of this step is unknown. Check the record before retrying.' },
        });
      }
    }
    for (const call of calls) {
      if (!byUse.has(call.id)) {
        await this.prisma.assistantAction.create({
          data: {
            orgId,
            userId: auth.userId,
            threadId,
            messageId: last.id,
            toolUseId: call.id,
            toolName: call.name,
            tier: this.registry.get(call.name)?.tier ?? 'read',
            input: json(call.input),
            status: 'failed',
            error: 'This step did not run.',
          },
        });
      }
    }

    const final = await this.prisma.assistantAction.findMany({ where: { orgId, messageId: last.id } });
    const resultByUse = new Map(final.map((a) => [a.toolUseId, a]));
    const content: ToolResult[] = calls.map((call) => toToolResult(call.id, resultByUse.get(call.id)!));
    await this.threads.append(orgId, threadId, { role: AssistantRole.user, content });
    return true;
  }

  private assertOpen(action: AssistantAction): void {
    if (action.tier !== 'write') throw new AppError('NOT_FOUND', 'No such action.');
    if (action.status !== 'proposed') throw new AppError('ACTION_DECIDED', 'This action was already handled.', undefined, 409);
  }

  /** A card built on data that has since changed is refreshed and shown again rather than applied blind. */
  private async assertFresh(ctx: ToolContext, action: AssistantAction, tool: Extract<AssistantTool, { tier: 'write' }>, input: unknown): Promise<void> {
    const { auth } = ctx;
    if (!action.entityType || !action.entityId || !action.entityVersion) return;
    const current = await this.registry.entityVersion(auth.organizationId, { type: action.entityType, id: action.entityId });
    if (current && current.getTime() === action.entityVersion.getTime()) return;

    let preview: ActionPreview;
    try {
      preview = await tool.preview(ctx, input);
    } catch (error) {
      await this.close(action.id, 'failed', reasonOf(error, this.logger, tool.name));
      throw new AppError('ACTION_STALE', 'This record changed and the action no longer applies.', undefined, 409);
    }
    await this.prisma.assistantAction.updateMany({
      where: { id: action.id, orgId: auth.organizationId, status: 'proposed' },
      data: {
        preview: json({ title: preview.title, summary: preview.summary, changes: preview.changes }),
        entityVersion: preview.entity?.version ?? null,
        expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS),
      },
    });
    throw new AppError('ACTION_STALE', 'This record changed since the card was shown. Check the updated values and confirm again.', undefined, 409);
  }

  private async close(id: string, status: Extract<AssistantActionStatus, 'expired' | 'rejected' | 'failed'>, error: string): Promise<boolean> {
    const { count } = await this.prisma.assistantAction.updateMany({
      where: { id, status: 'proposed' },
      data: { status, error, decidedAt: new Date() },
    });
    return count > 0;
  }
}

function toToolResult(toolUseId: string, action: AssistantAction): ToolResult {
  if (action.status === 'executed') {
    return { type: 'tool_result', tool_use_id: toolUseId, content: truncate(JSON.stringify(action.result ?? null)) };
  }
  return { type: 'tool_result', tool_use_id: toolUseId, is_error: true, content: action.error ?? 'This step did not complete.' };
}
