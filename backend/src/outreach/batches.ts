import { OutreachItemState, type OutreachBatchStatus, type Prisma } from '@prisma/client';
import type { AuditService } from '@/audit/audit.service';
import { httpError } from '@/common/errors/app-error';
import type { PrismaService } from '@/common/prisma/prisma.service';
import { scheduledStart, type OutreachMode, type OutreachRequest } from './schedule';

export interface OutreachChoice {
  mode: OutreachMode;
  date?: string;
  time?: string;
  timeZone?: string;
}

/**
 * With scheduling on, every import approval launches through a batch: "call
 * now" unless the owner picked a time. Off, there is no request and approval
 * releases leads at once, as it always has.
 */
export async function outreachRequest(
  db: Pick<PrismaService, 'organizationSetting'>,
  enabled: boolean,
  orgId: string,
  by: { userId: string },
  choice?: OutreachChoice,
  now = new Date(),
): Promise<OutreachRequest | undefined> {
  if (!enabled) return undefined;
  if (choice?.mode === 'scheduled') {
    if (!choice.date || !choice.time || !choice.timeZone) throw httpError(400, 'INVALID_SCHEDULE', 'Pick a date, a time and a time zone.');
    return { mode: 'scheduled', startAt: scheduledStart(choice.date, choice.time, choice.timeZone, now), timeZone: choice.timeZone, by };
  }
  const settings = await db.organizationSetting.findUnique({ where: { orgId }, select: { timezone: true } });
  return { mode: 'now', startAt: now, timeZone: settings?.timezone ?? 'UTC', by };
}

/**
 * Queues approved, releasable leads on the request's batch, creating it on the
 * first lead. A later chunk reopens a batch the runner already finished, and
 * joins a cancelled one as cancelled, so no lead waits on a batch that will
 * never release it.
 */
export async function enqueueOutreach(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  orgId: string,
  req: OutreachRequest,
  leadIds: string[],
  held: number,
): Promise<void> {
  req.held = (req.held ?? 0) + held;
  if (!req.batchId) {
    if (leadIds.length === 0) return;
    const batch = await tx.outreachBatch.create({
      data: {
        orgId,
        mode: req.mode,
        startAt: req.startAt,
        timezone: req.timeZone,
        total: leadIds.length,
        heldAtApproval: req.held,
        createdBy: req.by.userId,
      },
      select: { id: true },
    });
    req.batchId = batch.id;
    await tx.outreachBatchLead.createMany({ data: leadIds.map((leadId) => ({ batchId: batch.id, leadId, orgId })) });
    await audit.record(
      {
        orgId,
        actorType: 'user',
        actorId: req.by.userId,
        action: 'outreach_batch.created',
        entityType: 'outreach_batch',
        entityId: batch.id,
        payload: { mode: req.mode, startAt: req.startAt.toISOString(), timeZone: req.timeZone, queued: leadIds.length, held: req.held },
      },
      tx,
    );
  } else {
    const [batch] = await tx.$queryRaw<{ status: OutreachBatchStatus }[]>`
      UPDATE outreach_batches
         SET total = total + ${leadIds.length}, held_at_approval = held_at_approval + ${held},
             status = CASE WHEN status = 'completed' THEN 'running'::outreach_batch_status ELSE status END,
             completed_at = CASE WHEN status = 'completed' THEN NULL ELSE completed_at END,
             updated_at = now()
       WHERE id = ${req.batchId}::uuid AND organization_id = ${orgId}::uuid
      RETURNING status`;
    const state = batch?.status === 'cancelled' ? OutreachItemState.cancelled : OutreachItemState.queued;
    if (leadIds.length) {
      await tx.outreachBatchLead.createMany({ data: leadIds.map((leadId) => ({ batchId: req.batchId!, leadId, orgId, state })), skipDuplicates: true });
    }
  }
  req.queued = (req.queued ?? 0) + leadIds.length;
}
