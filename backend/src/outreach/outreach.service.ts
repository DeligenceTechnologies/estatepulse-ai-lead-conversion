import { Injectable } from '@nestjs/common';
import { OutreachBatchStatus, type Prisma } from '@prisma/client';
import { AuditService } from '@/audit/audit.service';
import { httpError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import type { QuietHours } from '@/common/utils/quiet-hours';
import { StrategyStoreService } from '@/telnyx/strategy-store.service';
import type { RescheduleDto } from './outreach.dto';
import { scheduledStart } from './schedule';

interface Who {
  organizationId: string;
  userId: string;
}

interface Progress {
  batch_id: string;
  queued: number;
  skipped: number;
  cancelled: number;
  called: number;
  failed: number;
  awaiting: number;
}

/** The owner's view of outreach batches: what launches when, how far each got, and cancelling or moving one. */
@Injectable()
export class OutreachService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly strategies: StrategyStoreService,
    private readonly audit: AuditService,
  ) {}

  /** What the launch dialog shows: the org's zone, its contact window and its call limits. */
  async config(orgId: string) {
    const [settings, strategy] = await Promise.all([
      this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { timezone: true, maxConcurrentAiCalls: true, reservedCallSlots: true } }),
      this.strategies.getStrategy(orgId),
    ]);
    const guard = (strategy.guardrails ?? {}) as { respectQuietHours?: boolean; quietHours?: QuietHours };
    return {
      timeZone: settings?.timezone ?? 'UTC',
      quietHours: guard.respectQuietHours === false ? null : (guard.quietHours ?? null),
      maxConcurrentAiCalls: settings?.maxConcurrentAiCalls ?? 5,
      reservedCallSlots: settings?.reservedCallSlots ?? 1,
    };
  }

  /**
   * The latest batches with progress. A released lead counts as called once a
   * call to it is on record after its release, failed when every such call
   * failed, and pending until then.
   */
  async list(orgId: string) {
    const batches = await this.prisma.outreachBatch.findMany({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        mode: true,
        status: true,
        startAt: true,
        timezone: true,
        total: true,
        heldAtApproval: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
        cancelledAt: true,
      },
    });
    if (batches.length === 0) return { items: [] };
    const rows = await this.prisma.$queryRaw<Progress[]>`
      SELECT i.batch_id,
             count(*) FILTER (WHERE i.state = 'queued')::int AS queued,
             count(*) FILTER (WHERE i.state = 'skipped')::int AS skipped,
             count(*) FILTER (WHERE i.state = 'cancelled')::int AS cancelled,
             count(*) FILTER (WHERE i.state = 'released' AND c.ok)::int AS called,
             count(*) FILTER (WHERE i.state = 'released' AND NOT c.ok)::int AS failed,
             count(*) FILTER (WHERE i.state = 'released' AND c.ok IS NULL)::int AS awaiting
        FROM outreach_batch_leads AS i
        LEFT JOIN LATERAL (
          SELECT bool_or(ca.status <> 'failed') AS ok FROM calls AS ca
           WHERE ca.organization_id = i.organization_id AND ca.lead_id = i.lead_id AND ca.created_at >= i.released_at
        ) AS c ON true
       WHERE i.organization_id = ${orgId}::uuid AND i.batch_id = ANY(${batches.map((b) => b.id)}::uuid[])
       GROUP BY i.batch_id`;
    const byId = new Map(rows.map((r) => [r.batch_id, r]));
    return {
      items: batches.map(({ timezone, heldAtApproval, ...b }) => {
        const p = byId.get(b.id);
        // A deleted lead takes its batch entry with it (cascade); the batch keeps the count it launched with.
        const onRecord = p ? p.queued + p.skipped + p.cancelled + p.called + p.failed + p.awaiting : 0;
        return {
          ...b,
          timeZone: timezone,
          progress: {
            called: p?.called ?? 0,
            failed: p?.failed ?? 0,
            pending: (p?.queued ?? 0) + (p?.awaiting ?? 0),
            skipped: (p?.skipped ?? 0) + heldAtApproval,
            cancelled: p?.cancelled ?? 0,
            removed: Math.max(0, b.total - onRecord),
          },
        };
      }),
    };
  }

  /**
   * Stops a batch that has not finished. Leads not yet released stay paused;
   * released ones not yet called are paused again, so the strategy stops before
   * their call. A lead already called keeps its conversation.
   */
  cancel(who: Who, batchId: string) {
    const orgId = who.organizationId;
    return this.prisma.$transaction(async (tx) => {
      const batch = await this.lockBatch(tx, orgId, batchId);
      if (batch.status !== OutreachBatchStatus.pending && batch.status !== OutreachBatchStatus.running) {
        throw httpError(409, 'BATCH_NOT_CANCELLABLE', `This batch is already ${batch.status}.`);
      }
      const notStarted = await tx.$executeRaw`
        UPDATE outreach_batch_leads SET state = 'cancelled', updated_at = now()
         WHERE batch_id = ${batchId}::uuid AND organization_id = ${orgId}::uuid AND state = 'queued'`;
      const repaused = await tx.$executeRaw`
        WITH uncalled AS (
          UPDATE outreach_batch_leads AS i SET state = 'cancelled', updated_at = now()
           WHERE i.batch_id = ${batchId}::uuid AND i.organization_id = ${orgId}::uuid AND i.state = 'released'
             AND NOT EXISTS (SELECT 1 FROM calls AS c
                              WHERE c.organization_id = i.organization_id AND c.lead_id = i.lead_id AND c.created_at >= i.released_at)
          RETURNING i.lead_id
        )
        UPDATE leads AS l SET automation_paused = true, updated_at = now()
          FROM uncalled WHERE l.id = uncalled.lead_id AND l.organization_id = ${orgId}::uuid`;
      await tx.outreachBatch.updateMany({ where: { id: batchId, orgId }, data: { status: OutreachBatchStatus.cancelled, cancelledAt: new Date() } });
      await this.audit.record(
        {
          orgId,
          actorType: 'user',
          actorId: who.userId,
          action: 'outreach_batch.cancelled',
          entityType: 'outreach_batch',
          entityId: batchId,
          payload: { from: batch.status, notStarted, repaused },
        },
        tx,
      );
      return { cancelled: true as const, notStarted, repaused };
    });
  }

  /** Moves a batch that has not started yet to another time. */
  async reschedule(who: Who, batchId: string, dto: RescheduleDto) {
    const orgId = who.organizationId;
    const startAt = scheduledStart(dto.date, dto.time, dto.timeZone, new Date());
    return this.prisma.$transaction(async (tx) => {
      const batch = await this.lockBatch(tx, orgId, batchId);
      if (batch.status !== OutreachBatchStatus.pending) {
        throw httpError(409, 'BATCH_NOT_PENDING', 'Only a batch that has not started yet can be rescheduled.');
      }
      await tx.outreachBatch.updateMany({ where: { id: batchId, orgId }, data: { mode: 'scheduled', startAt, timezone: dto.timeZone } });
      await this.audit.record(
        {
          orgId,
          actorType: 'user',
          actorId: who.userId,
          action: 'outreach_batch.rescheduled',
          entityType: 'outreach_batch',
          entityId: batchId,
          payload: { from: batch.start_at.toISOString(), to: startAt.toISOString(), timeZone: dto.timeZone },
        },
        tx,
      );
      return { id: batchId, startAt, timeZone: dto.timeZone };
    });
  }

  private async lockBatch(tx: Prisma.TransactionClient, orgId: string, batchId: string) {
    const [batch] = await tx.$queryRaw<{ status: OutreachBatchStatus; start_at: Date }[]>`
      SELECT status, start_at FROM outreach_batches WHERE id = ${batchId}::uuid AND organization_id = ${orgId}::uuid FOR UPDATE`;
    if (!batch) throw httpError(404, 'BATCH_NOT_FOUND', 'No such outreach batch.');
    return batch;
  }
}
