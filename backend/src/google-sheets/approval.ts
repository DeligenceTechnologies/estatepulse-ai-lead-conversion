import { LeadStatus, Prisma } from '@prisma/client';
import type { AuditService } from '@/audit/audit.service';
import { CRM_IMPORT_REVIEW_REASONS } from '@/crm/crm-records';
import { enqueueOutreach } from '@/outreach/batches';
import { summaryOf, type OutreachRequest, type OutreachSummary } from '@/outreach/schedule';
import { FILE_IMPORT_REVIEW_REASON, IMPORT_REVIEW_REASON } from './sheet-rows';

/** Every reason an import starts with (a sheet, a file, each connected CRM); a decision spends whichever one the lead carries. */
export const IMPORT_REASONS_SPENT_ON_DECISION: string[] = [IMPORT_REVIEW_REASON, FILE_IMPORT_REVIEW_REASON, ...CRM_IMPORT_REVIEW_REASONS];

export type HoldReason = 'DO_NOT_CONTACT' | 'NO_DIALABLE_PHONE' | 'STATUS_CHANGED';

export interface ApprovalResult {
  approved: number;
  released: number;
  held: { rowId: string; leadId: string; reason: HoldReason }[];
  skipped: string[];
  /** Scheduling on: the releasable leads were queued on this outreach batch instead of released. */
  outreach?: OutreachSummary;
}

/** Whether an imported lead (aliased `l`) may start outreach; the outreach runner re-checks it at release. */
export const RELEASABLE_LEAD = Prisma.sql`l.automation_paused AND NOT l.dnc_status AND l.status = 'new' AND l.normalized_phone IS NOT NULL`;

/**
 * Approves imported rows still pending review. A lead is released to the
 * outreach strategy only when it is still new, has a dialable phone and is
 * not do-not-contact; anything else is approved but held, with the reason.
 * With an outreach request the releasable leads stay paused and are queued on
 * its batch instead, for the outreach runner to release at the batch's time.
 * `by.userId` null: a sync approved on its own, recorded as the system.
 */
export async function approveTrackingRows(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  orgId: string,
  rowIds: string[],
  by: { userId: string | null },
  outreach?: OutreachRequest,
): Promise<ApprovalResult> {
  if (rowIds.length === 0) return { approved: 0, released: 0, held: [], skipped: [] };

  const decided = await tx.$queryRaw<{ id: string; lead_id: string | null }[]>`
    UPDATE sheet_import_rows
       SET review_state = 'approved', reviewed_by = ${by.userId}::uuid, reviewed_at = now(), updated_at = now()
     WHERE organization_id = ${orgId}::uuid AND id = ANY(${rowIds}::uuid[]) AND review_state = 'pending'
    RETURNING id, lead_id`;
  const leadIds = decided.map((d) => d.lead_id).filter((id): id is string => !!id);
  if (leadIds.length === 0) return { approved: 0, released: 0, held: [], skipped: notDecided(rowIds, decided) };

  await tx.$executeRaw`
    UPDATE leads
       SET review_reasons = ARRAY(SELECT r FROM unnest(review_reasons) WITH ORDINALITY AS u(r, n)
                                   WHERE r <> ALL(${IMPORT_REASONS_SPENT_ON_DECISION}::text[]) ORDER BY n),
           needs_review = EXISTS (SELECT 1 FROM unnest(review_reasons) AS u(r) WHERE r <> ALL(${IMPORT_REASONS_SPENT_ON_DECISION}::text[])),
           updated_at = now()
     WHERE organization_id = ${orgId}::uuid AND id = ANY(${leadIds}::uuid[])`;

  const released = outreach
    ? await tx.$queryRaw<{ id: string }[]>`
        SELECT l.id FROM leads AS l
         WHERE l.organization_id = ${orgId}::uuid AND l.id = ANY(${leadIds}::uuid[]) AND ${RELEASABLE_LEAD}`
    : await tx.$queryRaw<{ id: string }[]>`
        UPDATE leads AS l
           SET automation_paused = false, updated_at = now()
         WHERE l.organization_id = ${orgId}::uuid AND l.id = ANY(${leadIds}::uuid[]) AND ${RELEASABLE_LEAD}
        RETURNING l.id`;
  const releasedIds = new Set(released.map((r) => r.id));
  const heldIds = leadIds.filter((id) => !releasedIds.has(id));
  if (outreach) await enqueueOutreach(tx, audit, orgId, outreach, [...releasedIds], heldIds.length);
  const held = heldIds.length
    ? await tx.lead.findMany({
        where: { orgId, id: { in: heldIds } },
        select: { id: true, dncStatus: true, status: true },
      })
    : [];

  await audit.recordMany(
    decided
      .filter((d) => d.lead_id)
      .map((d) => ({
        orgId,
        actorType: by.userId ? ('user' as const) : ('system' as const),
        actorId: by.userId,
        action: 'sheet_import.approved',
        entityType: 'lead',
        entityId: d.lead_id,
        payload: outreach
          ? { rowId: d.id, released: false, outreachBatchId: releasedIds.has(d.lead_id!) ? (outreach.batchId ?? null) : null }
          : { rowId: d.id, released: releasedIds.has(d.lead_id!) },
      })),
    tx,
  );

  const rowOf = new Map(decided.map((d) => [d.lead_id, d.id]));
  return {
    approved: decided.length,
    released: outreach ? 0 : releasedIds.size,
    held: held.map((l) => ({ rowId: rowOf.get(l.id)!, leadId: l.id, reason: holdReason(l) })),
    skipped: notDecided(rowIds, decided),
    ...(outreach?.batchId ? { outreach: summaryOf(outreach) } : {}),
  };
}

function holdReason(lead: { dncStatus: boolean; status: LeadStatus }): HoldReason {
  if (lead.dncStatus) return 'DO_NOT_CONTACT';
  if (lead.status !== LeadStatus.new) return 'STATUS_CHANGED';
  return 'NO_DIALABLE_PHONE';
}

export function notDecided(rowIds: string[], decided: { id: string }[]): string[] {
  const done = new Set(decided.map((d) => d.id));
  return rowIds.filter((id) => !done.has(id));
}
