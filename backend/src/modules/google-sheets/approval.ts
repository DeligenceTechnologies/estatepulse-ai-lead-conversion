import { Prisma } from '@prisma/client';
import { LeadStatus } from '../../common/domain';
import { newId } from '../../common/ids';
import type { GuardedPrisma } from '../../prisma/prisma.service';
import { CRM_IMPORT_REVIEW_REASONS } from '../crm/crm-records';
import { IMPORT_REVIEW_REASONS } from './sheet-rows';

/**
 * Every reason an import starts with — a sheet, a file, each connected CRM.
 * A decision (approve or reject) spends whichever one the lead carries; any
 * other review reason stays.
 */
export const IMPORT_REASONS_SPENT_ON_DECISION: string[] = [...IMPORT_REVIEW_REASONS, ...CRM_IMPORT_REVIEW_REASONS];

/** Why an approved lead stays paused. Approval never overrides any of these. */
export type HoldReason = 'DO_NOT_CONTACT' | 'NO_DIALABLE_PHONE' | 'STATUS_CHANGED' | 'HUMAN_TAKEOVER';

export interface ApprovalResult {
  approved: number;
  released: number;
  held: { rowId: string; leadId: string; reason: HoldReason }[];
  /** Rows asked about that were not pending (already decided) or not this organization's. */
  skipped: string[];
}

/** The client inside `prisma.$transaction(async (tx) => …)`. */
export type Tx = Parameters<Parameters<GuardedPrisma['$transaction']>[0]>[0];

/**
 * Approve tracking rows — the one place an imported lead's pause is lifted.
 *
 * Used by Import Review (the owner's click) and by the imports themselves (the
 * rows the owner ticked in the preview are approved as they land). Either way
 * the rules are the same: the import's reason is spent, and the pause is lifted
 * only where nothing else holds the lead back. The outreach
 * engine is never called here; the watcher picks eligible leads up on its own.
 *
 * Idempotent: a row is decided once, and a second call finds nothing pending.
 */
export async function approveTrackingRows(tx: Tx, organizationId: string, rowIds: string[], by: { userId: string }): Promise<ApprovalResult> {
  if (rowIds.length === 0) return { approved: 0, released: 0, held: [], skipped: [] };
  const decided = await tx.$queryRaw<{ id: string; lead_id: string | null }[]>`
    UPDATE sheet_import_rows
       SET review_state = 'approved', reviewed_by = ${by.userId}::uuid, reviewed_at = now(), updated_at = now()
     WHERE organization_id = ${organizationId}::uuid AND id = ANY(${rowIds}::uuid[]) AND review_state = 'pending'
    RETURNING id, lead_id`;
  const leadIds = decided.map((d) => d.lead_id).filter((id): id is string => !!id);
  if (leadIds.length === 0) return { approved: 0, released: 0, held: [], skipped: notDecided(rowIds, decided) };

  // The import's reason is spent; any other review reason stays visible.
  await tx.$executeRaw`
    UPDATE leads
       SET review_reasons = ARRAY(SELECT r FROM unnest(review_reasons) WITH ORDINALITY AS u(r, n)
                                   WHERE r <> ALL(${IMPORT_REASONS_SPENT_ON_DECISION}::text[]) ORDER BY n),
           needs_review = EXISTS (SELECT 1 FROM unnest(review_reasons) AS u(r) WHERE r <> ALL(${IMPORT_REASONS_SPENT_ON_DECISION}::text[])),
           updated_at = now()
     WHERE organization_id = ${organizationId}::uuid AND id = ANY(${leadIds}::uuid[])`;

  // Lift the pause only when nothing else holds the lead back.
  const released = await tx.$queryRaw<{ id: string }[]>`
    UPDATE leads
       SET automation_paused = false, updated_at = now()
     WHERE organization_id = ${organizationId}::uuid AND id = ANY(${leadIds}::uuid[])
       AND automation_paused AND NOT dnc_status AND status = ${LeadStatus.NEW}
       AND takeover_user_id IS NULL AND normalized_phone IS NOT NULL
    RETURNING id`;
  const releasedIds = new Set(released.map((r) => r.id));

  const heldIds = leadIds.filter((id) => !releasedIds.has(id));
  const held = heldIds.length
    ? await tx.leads.findMany({
        where: { organization_id: organizationId, id: { in: heldIds } },
        select: { id: true, dnc_status: true, status: true, takeover_user_id: true, normalized_phone: true },
      })
    : [];

  await tx.audit_logs.createMany({
    data: decided
      .filter((d) => d.lead_id)
      .map((d) => ({
        id: newId(),
        organization_id: organizationId,
        actor_type: 'user',
        actor_id: by.userId,
        action: 'sheet_import.approved',
        entity_type: 'lead',
        entity_id: d.lead_id,
        payload: { rowId: d.id, released: releasedIds.has(d.lead_id!) } as Prisma.InputJsonValue,
      })),
  });

  const rowOf = new Map(decided.map((d) => [d.lead_id, d.id]));
  return {
    approved: decided.length,
    released: releasedIds.size,
    held: held.map((l) => ({ rowId: rowOf.get(l.id)!, leadId: l.id, reason: holdReason(l) })),
    skipped: notDecided(rowIds, decided),
  };
}

function holdReason(l: { dnc_status: boolean; status: string; takeover_user_id: string | null; normalized_phone: string | null }): HoldReason {
  if (l.dnc_status) return 'DO_NOT_CONTACT';
  if (l.status !== LeadStatus.NEW) return 'STATUS_CHANGED';
  if (l.takeover_user_id) return 'HUMAN_TAKEOVER';
  return 'NO_DIALABLE_PHONE';
}

function notDecided(rowIds: string[], decided: { id: string }[]): string[] {
  const done = new Set(decided.map((d) => d.id));
  return rowIds.filter((id) => !done.has(id));
}
