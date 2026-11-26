import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { AssistantActionStatus, AssistantRole, Prisma, type AssistantAction } from '@prisma/client';
import { AuditService } from '@/audit/audit.service';
import type { AuthContext } from '@/auth/auth.types';
import { AppError } from '@/common/errors/app-error';
import { TENANT_PRISMA, type GuardedPrisma } from '@/common/prisma/prisma.service';
import { PERMISSIONS } from '@/role/permissions';
import { AssistantBulkRunner } from './assistant-bulk.runner';
import { AssistantRefService } from './assistant-ref.service';
import { AssistantThreadService } from './assistant-thread.service';
import type { StoredBlock, ToolCall } from './providers/model-provider';
import { TYPED_CONFIRM_ABOVE } from './tools/bulk';
import type { ActionPreview, AssistantTool, ToolContext } from './tools/tool';
import { ToolRegistry } from './tools/tool-registry.service';

const PROPOSAL_TTL_MS = 10 * 60_000;
/** A write still "executing" after this long died mid-run; its outcome is unknown. */
const EXECUTING_STALE_MS = 2 * 60_000;
const MAX_RESULT_CHARS = 20_000;

type ToolResult = Extract<StoredBlock, { type: 'tool_result' }>;

export interface BulkProgress {
  actionId: string;
  /** queued, running, done, cancelled or stopped; null before approval. */
  status: string | null;
  total: number;
  done: number;
  failed: number;
  skipped: number;
  notAttempted: number;
  pending: number;
  /** The first leads that failed or were skipped, with why. */
  problems: { leadId: string; name: string; status: string; reason: string | null }[];
}

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

/** What the model hears when a tool is switched off (ASSISTANT_DISABLED_TOOLS). */
export const SWITCHED_OFF = 'This step is switched off for now while it is being fixed; nothing was done. Tell the user it is temporarily unavailable and suggest doing it from the app or trying later.';

@Injectable()
export class AssistantActionService {
  private readonly logger = new Logger(AssistantActionService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma,
    private readonly registry: ToolRegistry,
    private readonly threads: AssistantThreadService,
    private readonly audit: AuditService,
    private readonly refs: AssistantRefService,
    private readonly bulkRunner: AssistantBulkRunner,
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

    if (this.registry.switchedOff(tool.name)) {
      return this.prisma.assistantAction.create({ data: { ...base, tier: tool.tier, status: 'failed', error: SWITCHED_OFF } });
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
    const bulk = preview.bulk;
    if (bulk && bulk.leadIds.length > TYPED_CONFIRM_ABOVE && !auth.permissions.includes(PERMISSIONS.ASSISTANT_BULK)) {
      return this.prisma.assistantAction.create({
        data: {
          ...base,
          tier: 'write',
          status: 'failed',
          error: `This would act on ${bulk.leadIds.length} leads. More than ${TYPED_CONFIRM_ABOVE} at once needs the assistant.bulk permission; ask an owner, or narrow it to ${TYPED_CONFIRM_ABOVE}.`,
        },
      });
    }
    const action = await this.prisma.assistantAction.create({
      data: {
        ...base,
        tier: 'write',
        status: 'proposed',
        preview: json({
          title: preview.title,
          summary: preview.summary,
          changes: preview.changes,
          ...(bulk ? { bulk: { total: bulk.leadIds.length, sample: bulk.sample, skipped: bulk.skipped } } : {}),
        }),
        entityType: preview.entity?.type,
        entityId: preview.entity?.id,
        entityVersion: preview.entity?.version,
        expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS),
        ...(bulk ? { bulkTotal: bulk.leadIds.length } : {}),
      },
    });
    // The leads are frozen with the card: approving acts on exactly these.
    if (bulk) {
      await this.prisma.assistantActionItem.createMany({
        data: bulk.leadIds.map((leadId, position) => ({ orgId: auth.organizationId, actionId: action.id, leadId, position })),
      });
    }
    return action;
  }

  async require(auth: AuthContext, actionId: string): Promise<AssistantAction> {
    const action = await this.prisma.assistantAction.findFirst({ where: { id: actionId, orgId: auth.organizationId, userId: auth.userId } });
    if (!action) throw new AppError('NOT_FOUND', 'No such action.');
    return action;
  }

  async confirm(auth: AuthContext, actionId: string, opts: { count?: number } = {}): Promise<AssistantAction> {
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
    if (this.registry.switchedOff(tool.name)) {
      await this.close(action.id, 'failed', SWITCHED_OFF);
      throw new AppError('TOOL_SWITCHED_OFF', 'This step is switched off for now, so nothing was changed. Try again later.', undefined, 409);
    }
    // Valid when proposed; a deploy since then can change the tool's input shape.
    const parsed = tool.input.safeParse(action.input);
    if (!parsed.success) {
      await this.close(action.id, 'failed', 'This step was prepared by an older version of the assistant. Ask again.');
      throw new AppError('ACTION_STALE', 'This card is out of date. Ask the assistant again.', undefined, 409);
    }
    const input = parsed.data;
    const ctx = this.context(auth, action.threadId);

    if (action.bulkTotal !== null && tool.bulk) return this.startBulk(auth, action, tool.name, opts.count);

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

  /**
   * Approving a bulk card: above TYPED_CONFIRM_ABOVE leads the user typed the count, and still holds
   * assistant.bulk. The card is claimed (so a retried approve cannot start it twice), closed for the
   * chat with "started", and its job started in this process.
   */
  private async startBulk(auth: AuthContext, action: AssistantAction, toolName: string, count: number | undefined): Promise<AssistantAction> {
    const total = action.bulkTotal!;
    if (total > TYPED_CONFIRM_ABOVE) {
      if (!auth.permissions.includes(PERMISSIONS.ASSISTANT_BULK)) {
        throw new AppError('FORBIDDEN', `Approving an action on more than ${TYPED_CONFIRM_ABOVE} leads needs the assistant.bulk permission.`);
      }
      if (count !== total) throw new AppError('BULK_COUNT_MISMATCH', `Type the number of leads, ${total}, to approve.`, undefined, 422);
    }
    const claimed = await this.prisma.assistantAction.updateMany({
      where: { id: action.id, orgId: auth.organizationId, status: 'proposed' },
      data: {
        status: 'executed',
        decidedAt: new Date(),
        bulkStatus: 'queued',
        result: json({ started: true, total, note: 'Running in the background. The card shows progress; the user can stop it there.' }),
      },
    });
    if (claimed.count === 0) throw new AppError('ACTION_DECIDED', 'This action was already handled.', undefined, 409);
    this.bulkRunner.start(auth.organizationId, action.id);
    this.audit.quietly({
      orgId: auth.organizationId,
      actorType: 'ai',
      actorId: auth.userId,
      action: `assistant.${toolName}`,
      entityType: 'assistant_action',
      entityId: action.id,
      payload: { assistantActionId: action.id, threadId: action.threadId, leads: total },
    });
    return this.require(auth, action.id);
  }

  /** Stop on a running bulk card: the job finishes the lead it is on, and the rest are not attempted. */
  async stopBulk(auth: AuthContext, actionId: string): Promise<BulkProgress> {
    const action = await this.require(auth, actionId);
    if (action.bulkTotal === null) throw new AppError('NOT_FOUND', 'No such action.');
    await this.prisma.assistantAction.updateMany({
      where: { id: action.id, orgId: auth.organizationId, bulkStatus: { in: ['queued', 'running'] } },
      data: { bulkStatus: 'cancelled' },
    });
    return this.bulkProgress(auth, actionId);
  }

  /** Where a bulk card's job is: counts by outcome, and the first leads that failed or were skipped. */
  async bulkProgress(auth: AuthContext, actionId: string): Promise<BulkProgress> {
    const action = await this.require(auth, actionId);
    if (action.bulkTotal === null) throw new AppError('NOT_FOUND', 'No such action.');
    const [groups, problems] = await Promise.all([
      this.prisma.assistantActionItem.groupBy({ by: ['status'], where: { actionId }, _count: { _all: true } }),
      this.prisma.assistantActionItem.findMany({
        where: { actionId, status: { in: ['failed', 'skipped'] } },
        orderBy: { position: 'asc' },
        take: 10,
        select: { leadId: true, status: true, reason: true },
      }),
    ]);
    const count = (status: string) => groups.find((g) => g.status === status)?._count._all ?? 0;
    const named = problems.length
      ? await this.prisma.lead.findMany({ where: { id: { in: problems.map((p) => p.leadId) } }, select: { id: true, firstName: true, lastName: true } })
      : [];
    const names = new Map(named.map((l) => [l.id, [l.firstName, l.lastName].filter(Boolean).join(' ') || 'Unnamed lead']));
    return {
      actionId,
      status: action.bulkStatus,
      total: action.bulkTotal,
      done: count('succeeded'),
      failed: count('failed'),
      skipped: count('skipped'),
      notAttempted: count('not_attempted'),
      pending: count('pending'),
      problems: problems.map((p) => ({ leadId: p.leadId, name: names.get(p.leadId) ?? 'A lead', status: p.status, reason: p.reason })),
    };
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
