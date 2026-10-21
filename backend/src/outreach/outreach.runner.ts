import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutreachBatchStatus } from '@prisma/client';
import { AuditService } from '@/audit/audit.service';
import { PrismaService } from '@/common/prisma/prisma.service';
import type { IntegrationEnv } from '@/common/utils/interface';
import { inQuietHours, type QuietHours } from '@/common/utils/quiet-hours';
import { RELEASABLE_LEAD } from '@/google-sheets/approval';
import { CallSlots } from '@/telnyx/calls/call-slots';
import { DEFAULT_CALL_LIMIT } from '@/telnyx/calls/call.types';
import { StrategyStoreService, type Strategy } from '@/telnyx/strategy-store.service';
import { awaitingWindowMs, releaseCapacity } from './schedule';

const BATCHES_PER_TICK = 50;
/** One release is ~9 round trips; Prisma's 5 s default is tight against a remote database. A timed-out batch is retried next tick. */
const RELEASE_TX = { maxWait: 10_000, timeout: 15_000 };

interface OrgRules {
  timeZone: string;
  quiet?: QuietHours;
  maxConcurrent: number;
  reserved: number;
  steps: Strategy['steps'];
}

/**
 * Releases outreach batches whose time has come: unpauses their queued leads,
 * for the lead watcher to enroll as it does any new lead, as many as the org's
 * free call slots allow and never inside quiet hours. The limit and the live
 * calls are the call worker's own (org_settings.max_concurrent_calls and its
 * Redis slots), less the slots the org keeps free for calls outside a batch;
 * the worker still enforces the limit on every call it places. A lead that stopped being
 * releasable since approval (opted out, taken over, phone gone) is skipped.
 * State lives only in the database and each batch is released in its own
 * transaction under FOR UPDATE SKIP LOCKED, so instances share the work and a
 * restart loses nothing. Like the follow-up runner it sweeps every tenant by
 * design, hence the unguarded PrismaService; each statement is scoped by the
 * batch's own organization.
 */
@Injectable()
export class OutreachRunner implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutreachRunner.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<IntegrationEnv, true>,
    private readonly strategies: StrategyStoreService,
    private readonly audit: AuditService,
    private readonly slots: CallSlots,
  ) {}

  onModuleInit(): void {
    if (!this.config.get('OUTREACH_SCHEDULING_ENABLED', { infer: true })) return;
    this.timer = setInterval(() => void this.tick(), this.config.get('OUTREACH_POLL_MS', { infer: true }));
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass over every due batch. `now` is injectable for tests. */
  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const due = await this.prisma.outreachBatch.findMany({
        where: { status: { in: [OutreachBatchStatus.pending, OutreachBatchStatus.running] }, startAt: { lte: now } },
        orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
        take: BATCHES_PER_TICK,
        select: { id: true, orgId: true },
      });
      const rules = new Map<string, OrgRules>();
      for (const { id, orgId } of due) {
        try {
          if (!rules.has(orgId)) rules.set(orgId, await this.rulesFor(orgId));
          await this.release(id, rules.get(orgId)!, now);
        } catch (error) {
          this.logger.error(`outreach batch ${id}: ${(error as Error).message}`);
        }
      }
    } catch (error) {
      this.logger.error(`outreach tick failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** Read before the batch's transaction opens, so it never holds a second pool connection. */
  private async rulesFor(orgId: string): Promise<OrgRules> {
    const [settings, strategy] = await Promise.all([
      this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { timezone: true, maxConcurrentCalls: true, reservedCallSlots: true } }),
      this.strategies.getStrategy(orgId),
    ]);
    const guard = (strategy.guardrails ?? {}) as { respectQuietHours?: boolean; quietHours?: QuietHours };
    return {
      timeZone: settings?.timezone ?? 'UTC',
      quiet: guard.respectQuietHours === false ? undefined : guard.quietHours,
      maxConcurrent: settings?.maxConcurrentCalls ?? DEFAULT_CALL_LIMIT,
      reserved: settings?.reservedCallSlots ?? 1,
      steps: strategy.steps,
    };
  }

  private async release(batchId: string, rules: OrgRules, now: Date): Promise<void> {
    const at = now.toISOString();
    await this.prisma.$transaction(async (tx) => {
      const [batch] = await tx.$queryRaw<{ id: string; organization_id: string; status: OutreachBatchStatus; total: number }[]>`
        SELECT id, organization_id, status, total FROM outreach_batches
         WHERE id = ${batchId}::uuid AND status IN ('pending', 'running') AND start_at <= ${at}::timestamptz
         FOR UPDATE SKIP LOCKED`;
      if (!batch) return;
      const orgId = batch.organization_id;
      // Every batch of one org draws on one call budget, whichever instance releases it.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`outreach:${orgId}`}))`;

      const skipped = await tx.$executeRaw`
        UPDATE outreach_batch_leads AS i
           SET state = 'skipped', updated_at = now(),
               skip_reason = CASE WHEN l.dnc_status THEN 'DO_NOT_CONTACT'
                                  WHEN l.status <> 'new' THEN 'STATUS_CHANGED'
                                  WHEN l.normalized_phone IS NULL THEN 'NO_DIALABLE_PHONE'
                                  ELSE 'ALREADY_RELEASED' END
          FROM leads AS l
         WHERE i.batch_id = ${batch.id}::uuid AND i.state = 'queued'
           AND l.id = i.lead_id AND l.organization_id = ${orgId}::uuid AND NOT (${RELEASABLE_LEAD})`;

      let released = 0;
      if (!inQuietHours(rules.timeZone, rules.quiet, now)) {
        const awaitingSince = new Date(now.getTime() - awaitingWindowMs(rules.steps)).toISOString();
        // Released leads whose first call is not on record yet: queued for a slot, or not yet enrolled.
        const [load] = await tx.$queryRaw<{ awaiting: number }[]>`
          SELECT count(*)::int AS awaiting FROM outreach_batch_leads AS i
           WHERE i.organization_id = ${orgId}::uuid AND i.state = 'released' AND i.released_at > ${awaitingSince}::timestamptz
             AND NOT EXISTS (SELECT 1 FROM calls AS c
                              WHERE c.organization_id = i.organization_id AND c.lead_id = i.lead_id
                                AND c.created_at >= i.released_at)`;
        const capacity = releaseCapacity({
          maxConcurrent: rules.maxConcurrent,
          reserved: rules.reserved,
          activeCalls: await this.slots.inUse(orgId),
          awaitingCall: load.awaiting,
        });
        if (capacity > 0) {
          released = await tx.$executeRaw`
            WITH picked AS (
              SELECT lead_id FROM outreach_batch_leads
               WHERE batch_id = ${batch.id}::uuid AND state = 'queued'
               ORDER BY created_at, lead_id
               LIMIT ${capacity}
            ), freed AS (
              UPDATE leads AS l SET automation_paused = false, updated_at = now()
                FROM picked
               WHERE l.id = picked.lead_id AND l.organization_id = ${orgId}::uuid AND ${RELEASABLE_LEAD}
              RETURNING l.id
            )
            UPDATE outreach_batch_leads AS i SET state = 'released', released_at = ${at}::timestamptz, updated_at = now()
              FROM freed
             WHERE i.batch_id = ${batch.id}::uuid AND i.lead_id = freed.id`;
        }
      }

      const left = await tx.outreachBatchLead.count({ where: { batchId: batch.id, state: 'queued' } });
      const starting = batch.status === OutreachBatchStatus.pending && (released > 0 || skipped > 0 || left === 0);
      const done = left === 0;
      if (!starting && !done) return;
      await tx.outreachBatch.updateMany({
        where: { id: batch.id, orgId },
        data: {
          ...(starting ? { status: OutreachBatchStatus.running, startedAt: now } : {}),
          ...(done ? { status: OutreachBatchStatus.completed, completedAt: now } : {}),
        },
      });
      const entry = { orgId, actorType: 'system' as const, entityType: 'outreach_batch', entityId: batch.id };
      if (starting) await this.audit.record({ ...entry, action: 'outreach_batch.started', payload: { released, skipped } }, tx);
      if (done) await this.audit.record({ ...entry, action: 'outreach_batch.completed', payload: { total: batch.total } }, tx);
    }, RELEASE_TX);
  }
}
