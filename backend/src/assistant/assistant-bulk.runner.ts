import { HttpException, Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import type { AuthContext } from '@/auth/auth.types';
import { AppError } from '@/common/errors/app-error';
import { PrismaService, TENANT_PRISMA, type GuardedPrisma } from '@/common/prisma/prisma.service';
import { TenantContext } from '@/common/prisma/tenant-context';
import { OUTSIDE_IMPORT_REVIEW, visibleLeads } from '@/lead/lead-scope';
import { PERMISSIONS, effectivePermissions } from '@/role/permissions';
import { AssistantRefService } from './assistant-ref.service';
import { TYPED_CONFIRM_ABOVE } from './tools/bulk';
import type { AssistantTool, ToolContext, WriteTool } from './tools/tool';
import { ToolRegistry } from './tools/tool-registry.service';

/** Leads per chunk: Stop and the approver's permission are looked at again between chunks. */
export const BULK_CHUNK = 25;
/** An outside service down this many times in a row stops the job rather than failing hundreds of leads. */
export const MAX_UPSTREAM_IN_A_ROW = 3;
/** How often this server looks for jobs nobody is running. */
const SWEEP_MS = 60_000;
/** A job approved this long ago and still queued was never started (the server stopped first). */
const QUEUED_STALE_MS = 60_000;
/** A running job with no lead finished for this long belonged to a server that stopped. */
const RUNNING_STALE_MS = 5 * 60_000;

/** Refusals that are about one lead (already done, at a cap, not allowed); the job carries on. */
const REFUSALS = new Set(['NOT_FOUND', 'CONFLICT', 'VALIDATION_ERROR', 'FORBIDDEN']);

type ItemOutcome = { status: 'succeeded' | 'skipped' | 'failed'; reason: string | null; upstream?: boolean };

const messageOf = (error: unknown): string => {
  if (error instanceof HttpException) {
    const body = error.getResponse() as { error?: { message?: string }; message?: string | string[] };
    const message = body?.error?.message ?? body?.message;
    return Array.isArray(message) ? message.join('; ') : (message ?? error.message);
  }
  return error instanceof Error ? error.message : String(error);
};

/**
 * Runs approved bulk actions in the server process, one lead at a time, inside the action's office
 * (the tenant guard needs it, and there is no request). The database is the queue: a job is claimed
 * by moving it from queued to running, so only one server runs it, and each lead's row is its
 * progress, so a job picked up again after a restart carries on with the leads still pending.
 * It needs no Redis connection of its own (the shared Redis has a connection cap).
 *
 * Before each lead it checks the approver may still see it; before each chunk, that the approver
 * still has the permissions and has not pressed Stop.
 */
@Injectable()
export class AssistantBulkRunner implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AssistantBulkRunner.name);
  /** Jobs this process is running now. */
  private readonly running = new Set<string>();
  private sweeper: NodeJS.Timeout | null = null;

  constructor(
    @Inject(TENANT_PRISMA) private readonly db: GuardedPrisma,
    private readonly prisma: PrismaService,
    private readonly registry: ToolRegistry,
    private readonly refs: AssistantRefService,
  ) {}

  onApplicationBootstrap(): void {
    this.sweeper = setInterval(() => void this.sweep(), SWEEP_MS);
    this.sweeper.unref?.();
    void this.sweep();
  }

  onModuleDestroy(): void {
    if (this.sweeper) clearInterval(this.sweeper);
  }

  /** Starts an approved action's job in this process and returns at once. */
  start(orgId: string, actionId: string): void {
    setImmediate(() => void this.launch(orgId, actionId));
  }

  private async launch(orgId: string, actionId: string): Promise<void> {
    if (this.running.has(actionId)) return;
    this.running.add(actionId);
    try {
      await TenantContext.run(orgId, () => this.runAction(orgId, actionId));
    } catch (error) {
      this.logger.error(`bulk ${actionId}: ${(error as Error)?.stack ?? String(error)}`);
    } finally {
      this.running.delete(actionId);
    }
  }

  /**
   * Jobs nobody is running: approved over a minute ago and still queued, or running with no lead
   * finished for five minutes (their server stopped). Those are set back to queued and started here.
   */
  async sweep(now = Date.now()): Promise<void> {
    try {
      const open = await this.prisma.assistantAction.findMany({
        where: { bulkStatus: { in: ['queued', 'running'] }, decidedAt: { lt: new Date(now - QUEUED_STALE_MS) } },
        select: { id: true, orgId: true, bulkStatus: true, decidedAt: true },
        take: 50,
      });
      for (const a of open) {
        if (this.running.has(a.id)) continue;
        if (a.bulkStatus === 'running') {
          const last = await this.prisma.assistantActionItem.findFirst({ where: { actionId: a.id, finishedAt: { not: null } }, orderBy: { finishedAt: 'desc' }, select: { finishedAt: true } });
          const lastSign = last?.finishedAt ?? a.decidedAt!;
          if (now - lastSign.getTime() < RUNNING_STALE_MS) continue;
          await this.prisma.assistantAction.updateMany({ where: { id: a.id, bulkStatus: 'running' }, data: { bulkStatus: 'queued' } });
          this.logger.warn(`bulk ${a.id}: picked up again; no lead had finished for ${Math.round((now - lastSign.getTime()) / 60_000)} min`);
        }
        this.start(a.orgId, a.id);
      }
    } catch (error) {
      this.logger.error(`bulk sweep: ${(error as Error).message}`);
    }
  }

  /** Public for tests: the whole job for one action, if this call wins the claim. */
  async runAction(orgId: string, actionId: string): Promise<void> {
    const action = await this.db.assistantAction.findFirst({ where: { id: actionId } });
    if (!action || action.bulkTotal === null) return;
    if (action.bulkStatus === 'cancelled') return this.closeRest(actionId, 'Stopped by the user before this lead');
    if (action.bulkStatus !== 'queued') return;
    const claimed = await this.db.assistantAction.updateMany({ where: { id: actionId, bulkStatus: 'queued' }, data: { bulkStatus: 'running' } });
    if (claimed.count === 0) return;

    const tool = this.registry.get(action.toolName);
    if (!tool || tool.tier !== 'write' || !tool.bulk) return this.giveUp(actionId, 'This step can no longer run in bulk.');
    const parsed = tool.input.safeParse(action.input);
    if (!parsed.success) return this.giveUp(actionId, 'This step was prepared by an older version of the assistant.');

    let upstreamInARow = 0;
    for (;;) {
      const now = await this.db.assistantAction.findFirst({ where: { id: actionId }, select: { bulkStatus: true } });
      if (now?.bulkStatus === 'cancelled') return this.closeRest(actionId, 'Stopped by the user before this lead');
      const auth = await this.approver(orgId, action.userId);
      if (!auth || !this.mayRun(auth, tool, action.bulkTotal)) return this.giveUp(actionId, 'The person who approved it can no longer do this');

      const items = await this.db.assistantActionItem.findMany({ where: { actionId, status: 'pending' }, orderBy: { position: 'asc' }, take: BULK_CHUNK });
      if (items.length === 0) break;
      const ctx: ToolContext = { auth, refs: this.refs.forThread(auth, action.threadId) };
      for (const item of items) {
        const outcome = await this.runOne(ctx, tool, parsed.data, item.leadId);
        upstreamInARow = outcome.upstream ? upstreamInARow + 1 : 0;
        await this.db.assistantActionItem.update({
          where: { id: item.id },
          data: { status: outcome.status, reason: outcome.reason?.slice(0, 500) ?? null, finishedAt: new Date() },
        });
        if (upstreamInARow >= MAX_UPSTREAM_IN_A_ROW) return this.giveUp(actionId, `Stopped after ${MAX_UPSTREAM_IN_A_ROW} errors in a row from an outside service`);
      }
    }
    await this.db.assistantAction.updateMany({ where: { id: actionId, bulkStatus: 'running' }, data: { bulkStatus: 'done' } });
  }

  private mayRun(auth: AuthContext, tool: AssistantTool, total: number): boolean {
    return this.registry.allows(auth, tool) && (total <= TYPED_CONFIRM_ABOVE || auth.permissions.includes(PERMISSIONS.ASSISTANT_BULK));
  }

  /** One lead: still visible to the approver, then the tool's own step. */
  private async runOne(ctx: ToolContext, tool: WriteTool, input: unknown, leadId: string): Promise<ItemOutcome> {
    const lead = await this.db.lead.findFirst({ where: { id: leadId, ...visibleLeads(ctx.auth), ...OUTSIDE_IMPORT_REVIEW }, select: { id: true } });
    if (!lead) return { status: 'skipped', reason: 'No longer visible to the approver (reassigned, merged or deleted)' };
    try {
      const result = await tool.bulk!.runOne(ctx, input, leadId);
      return result?.skipped ? { status: 'skipped', reason: result.skipped } : { status: 'succeeded', reason: null };
    } catch (error) {
      if (error instanceof AppError && error.code === 'UPSTREAM_ERROR') return { status: 'failed', reason: error.message, upstream: true };
      if (error instanceof AppError && REFUSALS.has(error.code)) return { status: 'skipped', reason: error.message };
      if (error instanceof HttpException && error.getStatus() < 500) return { status: 'skipped', reason: messageOf(error) };
      this.logger.error(`bulk lead ${leadId}: ${(error as Error)?.stack ?? String(error)}`);
      return { status: 'failed', reason: 'Something went wrong with this lead.' };
    }
  }

  /** The approver as a request would see them now, or null once they are inactive or gone. */
  private async approver(orgId: string, userId: string): Promise<AuthContext | null> {
    const user = await this.db.user.findFirst({
      where: { id: userId, status: 'active' },
      select: { roles: { select: { role: { select: { id: true, isSystem: true, permissions: true } } } } },
    });
    if (!user) return null;
    const roles = user.roles.map(({ role }) => role);
    return { userId, organizationId: orgId, sessionId: 'bulk', roleIds: roles.map((r) => r.id), permissions: effectivePermissions(roles) };
  }

  private async closeRest(actionId: string, reason: string): Promise<void> {
    await this.db.assistantActionItem.updateMany({ where: { actionId, status: 'pending' }, data: { status: 'not_attempted', reason, finishedAt: new Date() } });
  }

  /** Ends the job early: what is left is not attempted, and the card says it stopped. */
  private async giveUp(actionId: string, reason: string): Promise<void> {
    await this.closeRest(actionId, reason);
    await this.db.assistantAction.updateMany({ where: { id: actionId, bulkStatus: { in: ['queued', 'running'] } }, data: { bulkStatus: 'stopped' } });
  }
}
