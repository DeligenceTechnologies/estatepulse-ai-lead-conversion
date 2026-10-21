import { LeadStatus, type Prisma } from '@prisma/client';
import type { AuditService } from '@/audit/audit.service';
import { CRM_IMPORT_REVIEW_REASONS } from '@/crm/crm-records';
import { FILE_IMPORT_REVIEW_REASON, IMPORT_REVIEW_REASON } from './sheet-rows';

/** Every reason an import starts with (a sheet, a file, each connected CRM); a decision spends whichever one the lead carries. */
export const IMPORT_REASONS_SPENT_ON_DECISION: string[] = [IMPORT_REVIEW_REASON, FILE_IMPORT_REVIEW_REASON, ...CRM_IMPORT_REVIEW_REASONS];

export type HoldReason = 'DO_NOT_CONTACT' | 'NO_DIALABLE_PHONE' | 'STATUS_CHANGED';

export interface ApprovalResult {
  approved: number;
  released: number;
  held: { rowId: string; leadId: string; reason: HoldReason }[];
  skipped: string[];
}

/**
 * Approves imported rows still pending review. A lead is released to the
 * outreach strategy only when it is still new, has a dialable phone and is
 * not do-not-contact; anything else is approved but held, with the reason.
 * `by.userId` null: a sync approved on its own, recorded as the system.
 */
export async function approveTrackingRows(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  orgId: string,
  rowIds: string[],
  by: { userId: string | null },
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

  const released = await tx.$queryRaw<{ id: string }[]>`
    UPDATE leads
       SET automation_paused = false, updated_at = now()
     WHERE organization_id = ${orgId}::uuid AND id = ANY(${leadIds}::uuid[])
       AND automation_paused AND NOT dnc_status AND status = 'new' AND normalized_phone IS NOT NULL
    RETURNING id`;
  const releasedIds = new Set(released.map((r) => r.id));
  const heldIds = leadIds.filter((id) => !releasedIds.has(id));
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
        payload: { rowId: d.id, released: releasedIds.has(d.lead_id!) },
      })),
    tx,
  );

  const rowOf = new Map(decided.map((d) => [d.lead_id, d.id]));
  return {
    approved: decided.length,
    released: releasedIds.size,
    held: held.map((l) => ({ rowId: rowOf.get(l.id)!, leadId: l.id, reason: holdReason(l) })),
    skipped: notDecided(rowIds, decided),
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
