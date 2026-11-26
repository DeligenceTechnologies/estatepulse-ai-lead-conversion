import { Injectable } from '@nestjs/common';
import { EnrollmentStatus, Prisma } from '@prisma/client';
import { AuditService } from '@/audit/audit.service';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { EventsBus } from '@/events/events.bus';
import { type Actor, LeadStateService } from '@/lead/lead-state.service';
import { MERGE_LEAD_SELECT, resolveMerge, restoreFromSnapshot, snapshotForUndo } from './merge-rules';

type Tx = Prisma.TransactionClient;

/** Child tables whose rows simply follow the person: moved to the survivor, moved back on undo. */
const MOVABLE = ['message', 'call', 'leadEvent', 'callTransfer', 'calendarMeeting', 'leadSubmission', 'sequenceEnrollment'] as const;
type Movable = (typeof MOVABLE)[number];
type MovedRows = Partial<Record<Movable | 'outreachBatchLead', string[]>> & { mergedLeads?: string[] };

/** What a merge took away or changed beyond moving rows, so undo can put it back. */
interface RemovedRows {
  /** The merged lead's columns the merge cleared (its keys, holds, pending callbacks). */
  mergedLead?: Record<string, unknown>;
  /** Live enrollments stopped because the survivor already had one: id -> status before. */
  stoppedEnrollments?: { id: string; status: EnrollmentStatus }[];
  /** Outreach rows deleted because the survivor was already in the same batch. */
  outreachRows?: Prisma.OutreachBatchLeadCreateManyInput[];
}

const LIVE: EnrollmentStatus[] = [EnrollmentStatus.active, EnrollmentStatus.paused];
const MERGED_LEAD_CLEARED = ['normalizedPhone', 'normalizedEmail', 'automationPaused', 'needsReview', 'callbackAt', 'textBackAt', 'takenOverById', 'takenOverAt'] as const;

export interface MergeResult {
  mergeId: string;
  survivorId: string;
  mergedId: string;
}

/**
 * Folds one lead into another: the same person, two records. Everything that happened with the
 * merged lead (texts, calls, events, meetings, transfers, sources, enrollments, outreach) moves to the
 * survivor; the survivor's fields win and its blanks are filled (merge-rules.resolveMerge). The merged
 * lead is kept, hidden, with mergedIntoId pointing at where the person now lives: a phone or email it
 * shares with the survivor is cleared from it, and a different one is kept so a text, call or new
 * submission from it is redirected to the survivor (merged-redirect.ts). A LeadMerge row holds
 * everything needed to undo it.
 */
@Injectable()
export class LeadMergeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly state: LeadStateService,
    private readonly events: EventsBus,
  ) {}

  async merge(orgId: string, survivorId: string, mergedId: string, actor: Actor, reasons: string[] = []): Promise<MergeResult> {
    if (survivorId === mergedId) throw new AppError('VALIDATION_ERROR', 'A lead cannot be merged into itself.');
    const result = await this.prisma.$transaction((tx) => this.mergeIn(tx, orgId, survivorId, mergedId, actor, reasons), { timeout: 60_000 });
    this.events.publish({ organizationId: orgId, type: 'lead.updated', leadSourceId: null, leadId: survivorId });
    return result;
  }

  private async mergeIn(tx: Tx, orgId: string, survivorId: string, mergedId: string, actor: Actor, reasons: string[]): Promise<MergeResult> {
    await lockLeads(tx, [survivorId, mergedId]);
    const [survivor, merged] = await Promise.all([
      tx.lead.findFirst({ where: { id: survivorId, orgId }, select: MERGE_LEAD_SELECT }),
      tx.lead.findFirst({ where: { id: mergedId, orgId }, select: MERGE_LEAD_SELECT }),
    ]);
    if (!survivor || !merged) throw new AppError('NOT_FOUND', 'Lead not found.');
    if (survivor.mergedIntoId || merged.mergedIntoId) throw new AppError('CONFLICT', 'One of these leads was already merged into another lead.');

    const moved: MovedRows = {};
    const removed: RemovedRows = {};

    // Enrollments: one live enrollment per lead (a partial unique index). The survivor's carries on.
    const survivorLive = await tx.sequenceEnrollment.count({ where: { leadId: survivorId, status: { in: LIVE } } });
    if (survivorLive > 0) {
      const live = await tx.sequenceEnrollment.findMany({ where: { leadId: mergedId, status: { in: LIVE } }, select: { id: true, status: true } });
      if (live.length) {
        removed.stoppedEnrollments = live;
        await tx.sequenceEnrollment.updateMany({
          where: { id: { in: live.map((e) => e.id) } },
          data: { status: EnrollmentStatus.stopped, stoppedAt: new Date(), stoppedReason: 'merged' },
        });
      }
    }

    for (const table of MOVABLE) {
      const delegate = tx[table] as unknown as {
        findMany(args: object): Promise<{ id: string }[]>;
        updateMany(args: object): Promise<unknown>;
      };
      const rows = await delegate.findMany({ where: { leadId: mergedId }, select: { id: true } });
      if (!rows.length) continue;
      moved[table] = rows.map((r) => r.id);
      await delegate.updateMany({ where: { id: { in: moved[table] } }, data: { leadId: survivorId } });
    }

    // Outreach: (batch, lead) is the key, so a batch both are in keeps the survivor's row only.
    const outreach = await tx.outreachBatchLead.findMany({ where: { leadId: mergedId } });
    if (outreach.length) {
      const shared = new Set(
        (await tx.outreachBatchLead.findMany({ where: { leadId: survivorId, batchId: { in: outreach.map((o) => o.batchId) } }, select: { batchId: true } })).map(
          (o) => o.batchId,
        ),
      );
      const drop = outreach.filter((o) => shared.has(o.batchId));
      const keep = outreach.filter((o) => !shared.has(o.batchId));
      if (drop.length) {
        removed.outreachRows = drop.map(({ updatedAt: _u, ...row }) => row);
        await tx.outreachBatchLead.deleteMany({ where: { leadId: mergedId, batchId: { in: drop.map((o) => o.batchId) } } });
      }
      if (keep.length) {
        moved.outreachBatchLead = keep.map((o) => o.batchId);
        await tx.outreachBatchLead.updateMany({ where: { leadId: mergedId, batchId: { in: moved.outreachBatchLead } }, data: { leadId: survivorId } });
      }
    }

    // Leads merged into this one earlier now point at where the person lives.
    const earlier = await tx.lead.findMany({ where: { mergedIntoId: mergedId }, select: { id: true } });
    if (earlier.length) {
      moved.mergedLeads = earlier.map((l) => l.id);
      await tx.lead.updateMany({ where: { id: { in: moved.mergedLeads } }, data: { mergedIntoId: survivorId } });
    }

    const update = resolveMerge(survivor, merged);
    // The person's keys now live on the survivor. A second number or address they used stays on the merged
    // lead, where texts, calls and new submissions from it are redirected to the survivor (merged-redirect.ts).
    const survivorPhone = survivor.normalizedPhone ?? merged.normalizedPhone;
    const survivorEmail = survivor.normalizedEmail ?? merged.normalizedEmail;
    const survivorBefore = snapshotForUndo(survivor, update);
    await tx.lead.update({ where: { id: survivorId }, data: update });

    removed.mergedLead = JSON.parse(
      JSON.stringify(Object.fromEntries(MERGED_LEAD_CLEARED.map((k) => [k, (merged as Record<string, unknown>)[k] ?? null]))),
    ) as Record<string, unknown>;
    await tx.lead.update({
      where: { id: mergedId },
      data: {
        mergedIntoId: survivorId,
        mergedAt: new Date(),
        // A key the survivor now has is cleared, so lookups find the survivor itself, not this record.
        ...(merged.normalizedPhone === survivorPhone ? { normalizedPhone: null } : {}),
        ...(merged.normalizedEmail === survivorEmail ? { normalizedEmail: null } : {}),
        automationPaused: true,
        needsReview: false,
        callbackAt: null,
        textBackAt: null,
        takenOverById: null,
        takenOverAt: null,
      },
    });

    await this.settleCandidates(tx, orgId, survivorId, mergedId, actor);

    const log = await tx.leadMerge.create({
      data: {
        orgId,
        survivorId,
        mergedId,
        actorType: actor.type,
        actorId: actor.id ?? null,
        reasons,
        survivorBefore: survivorBefore as Prisma.InputJsonValue,
        movedRows: moved as Prisma.InputJsonValue,
        removedRows: removed as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });

    const name = [merged.firstName, merged.lastName].filter(Boolean).join(' ') || merged.phone || merged.email || 'another lead';
    await this.state.record(
      {
        orgId,
        leadId: survivorId,
        type: 'merged',
        source: actor.type === 'user' ? 'agent' : 'dedup',
        actor,
        reason: `Merged with ${name}; their texts, calls and history are now here`,
        payload: { mergeId: log.id, mergedId, moved: Object.fromEntries(Object.entries(moved).map(([k, v]) => [k, v?.length ?? 0])) },
      },
      tx,
    );
    await this.audit.record(
      {
        orgId,
        actorType: actor.type,
        actorId: actor.id ?? null,
        action: 'lead.merged',
        entityType: 'lead',
        entityId: survivorId,
        payload: { mergeId: log.id, mergedId, reasons },
      },
      tx,
    );
    return { mergeId: log.id, survivorId, mergedId };
  }

  /** The pair is settled; any other pair the merged lead was in carries over to the survivor. */
  private async settleCandidates(tx: Tx, orgId: string, survivorId: string, mergedId: string, actor: Actor): Promise<void> {
    const resolved = { resolvedById: actor.type === 'user' ? (actor.id ?? null) : null, resolvedAt: new Date() };
    const [a, b] = survivorId < mergedId ? [survivorId, mergedId] : [mergedId, survivorId];
    await tx.duplicateCandidate.updateMany({ where: { leadAId: a, leadBId: b }, data: { status: 'merged', ...resolved } });

    const others = await tx.duplicateCandidate.findMany({
      where: { OR: [{ leadAId: mergedId }, { leadBId: mergedId }], NOT: { leadAId: a, leadBId: b } },
    });
    for (const c of others) {
      const other = c.leadAId === mergedId ? c.leadBId : c.leadAId;
      await tx.duplicateCandidate.delete({ where: { id: c.id } });
      if (other === survivorId) continue;
      const [x, y] = survivorId < other ? [survivorId, other] : [other, survivorId];
      await tx.duplicateCandidate.upsert({
        where: { leadAId_leadBId: { leadAId: x, leadBId: y } },
        create: { orgId, leadAId: x, leadBId: y, score: c.score, reasons: c.reasons, status: c.status },
        update: {},
      });
    }
    // The possible-duplicate note on the survivor is answered.
    await tx.$executeRaw`
      UPDATE leads SET review_reasons = ARRAY(SELECT r FROM unnest(review_reasons) AS r WHERE r NOT LIKE 'Possible duplicate%'),
                       needs_review = EXISTS (SELECT 1 FROM unnest(review_reasons) AS r WHERE r NOT LIKE 'Possible duplicate%'),
                       updated_at = now()
       WHERE id = ${survivorId}::uuid AND EXISTS (SELECT 1 FROM unnest(review_reasons) AS r WHERE r LIKE 'Possible duplicate%')`;
  }

  /**
   * Puts a merge back: the rows it moved go back to the merged lead, the survivor's changed columns
   * are restored and the merged lead is visible and reachable again. Latest merge first: a survivor
   * that was merged again since, or merged into someone else, has to be undone in that order. Texts and
   * calls that happened after the merge stay with the survivor, where they happened.
   */
  async unmerge(orgId: string, mergeId: string, actor: Actor): Promise<{ survivorId: string; mergedId: string }> {
    const out = await this.prisma.$transaction(
      async (tx) => {
        const log = await tx.leadMerge.findFirst({ where: { id: mergeId, orgId } });
        if (!log) throw new AppError('NOT_FOUND', 'Merge not found.');
        if (log.undoneAt) throw new AppError('CONFLICT', 'This merge was already undone.');
        await lockLeads(tx, [log.survivorId, log.mergedId]);

        const [survivor, merged] = await Promise.all([
          tx.lead.findUnique({ where: { id: log.survivorId }, select: { mergedIntoId: true } }),
          tx.lead.findUnique({ where: { id: log.mergedId }, select: { mergedIntoId: true } }),
        ]);
        if (!survivor || !merged) throw new AppError('NOT_FOUND', 'One of the leads no longer exists.');
        if (survivor.mergedIntoId) throw new AppError('CONFLICT', 'This lead was merged into another lead since; undo that merge first.');
        if (merged.mergedIntoId !== log.survivorId) throw new AppError('CONFLICT', 'The merged lead has changed since; this merge cannot be undone.');
        const later = await tx.leadMerge.count({ where: { survivorId: log.survivorId, undoneAt: null, createdAt: { gt: log.createdAt } } });
        if (later > 0) throw new AppError('CONFLICT', 'This lead was merged with another lead since; undo the latest merge first.');

        const moved = (log.movedRows ?? {}) as MovedRows;
        const removed = (log.removedRows ?? {}) as RemovedRows;

        for (const table of MOVABLE) {
          const ids = moved[table];
          if (!ids?.length) continue;
          const delegate = tx[table] as unknown as { updateMany(args: object): Promise<unknown> };
          await delegate.updateMany({ where: { id: { in: ids }, leadId: log.survivorId }, data: { leadId: log.mergedId } });
        }
        if (moved.outreachBatchLead?.length) {
          await tx.outreachBatchLead.updateMany({
            where: { leadId: log.survivorId, batchId: { in: moved.outreachBatchLead } },
            data: { leadId: log.mergedId },
          });
        }
        if (removed.outreachRows?.length) await tx.outreachBatchLead.createMany({ data: removed.outreachRows, skipDuplicates: true });
        for (const e of removed.stoppedEnrollments ?? []) {
          await tx.sequenceEnrollment.updateMany({
            where: { id: e.id, stoppedReason: 'merged' },
            data: { status: e.status, stoppedAt: null, stoppedReason: null },
          });
        }
        if (moved.mergedLeads?.length) {
          await tx.lead.updateMany({ where: { id: { in: moved.mergedLeads }, mergedIntoId: log.survivorId }, data: { mergedIntoId: log.mergedId } });
        }

        await tx.lead.update({ where: { id: log.survivorId }, data: restoreFromSnapshot(log.survivorBefore as Record<string, unknown>) });
        await tx.lead.update({
          where: { id: log.mergedId },
          data: { ...restoreFromSnapshot(removed.mergedLead ?? {}), mergedIntoId: null, mergedAt: null },
        });

        const [a, b] = log.survivorId < log.mergedId ? [log.survivorId, log.mergedId] : [log.mergedId, log.survivorId];
        await tx.duplicateCandidate.upsert({
          where: { leadAId_leadBId: { leadAId: a, leadBId: b } },
          // Dismissed, not open: someone just decided these are two people.
          create: { orgId, leadAId: a, leadBId: b, score: 0, reasons: log.reasons, status: 'dismissed', resolvedAt: new Date() },
          update: { status: 'dismissed', resolvedAt: new Date(), resolvedById: actor.type === 'user' ? (actor.id ?? null) : null },
        });
        await tx.leadMerge.update({ where: { id: log.id }, data: { undoneAt: new Date(), undoneById: actor.type === 'user' ? (actor.id ?? null) : null } });

        for (const leadId of [log.survivorId, log.mergedId]) {
          await this.state.record(
            { orgId, leadId, type: 'unmerged', source: 'agent', actor, reason: 'A merge was undone; the two leads are separate again', payload: { mergeId } },
            tx,
          );
        }
        await this.audit.record(
          { orgId, actorType: actor.type, actorId: actor.id ?? null, action: 'lead.unmerged', entityType: 'lead', entityId: log.survivorId, payload: { mergeId, mergedId: log.mergedId } },
          tx,
        );
        return { survivorId: log.survivorId, mergedId: log.mergedId };
      },
      { timeout: 60_000 },
    );
    this.events.publish({ organizationId: orgId, type: 'lead.updated', leadSourceId: null, leadId: out.survivorId });
    this.events.publish({ organizationId: orgId, type: 'lead.updated', leadSourceId: null, leadId: out.mergedId });
    return out;
  }
}

/** One merge or undo per lead at a time; ids sorted so two merges never wait on each other in a circle. */
async function lockLeads(tx: Tx, ids: string[]): Promise<void> {
  for (const id of [...ids].sort()) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`lead-merge:${id}`}))`;
}
