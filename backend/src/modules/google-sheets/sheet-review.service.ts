import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { LeadStatus } from '../../common/domain';
import { newId } from '../../common/ids';
import { TENANT_PRISMA, type GuardedPrisma } from '../../prisma/prisma.service';
import type { SessionIdentity } from './google-connections.service';
import { leadValuesRow, type ChangedValues } from './sheet-import.service';
import { IMPORT_REVIEW_REASON } from './sheet-rows';
import type { ChangesQuery } from './schemas';

export const REJECTED_REASON = 'Rejected at import review';

/** Why an approved lead stays paused. Approval never overrides any of these. */
export type HoldReason = 'DO_NOT_CONTACT' | 'NO_DIALABLE_PHONE' | 'STATUS_CHANGED' | 'HUMAN_TAKEOVER';

/** Lead fields a "change" may carry, in the order they are shown. */
const DIFF_FIELDS = [
  'first_name',
  'last_name',
  'phone',
  'email',
  'location',
  'min_budget',
  'max_budget',
  'bedrooms',
  'motivation',
  'custom_fields',
] as const;

/**
 * The owner's decisions on imported leads.
 *
 * Approval only lifts the import's own pause. It never calls the outreach
 * engine: the lead becomes eligible, and the existing watcher picks it up on
 * its own schedule, re-checking every policy it always checks (pause, DNC,
 * status) at enrolment and before each step.
 *
 * Each action is a handful of set-based statements in one transaction, however
 * many rows it covers, and each is idempotent: a row is decided once, and a
 * second click finds nothing pending.
 */
@Injectable()
export class SheetReviewService {
  constructor(@Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma) {}

  async approve(who: SessionIdentity, rowIds: string[]) {
    const org = who.organizationId;
    return this.prisma.$transaction(async (tx) => {
      const decided = await tx.$queryRaw<{ id: string; lead_id: string | null }[]>`
        UPDATE sheet_import_rows
           SET review_state = 'approved', reviewed_by = ${who.userId}::uuid, reviewed_at = now(), updated_at = now()
         WHERE organization_id = ${org}::uuid AND id = ANY(${rowIds}::uuid[]) AND review_state = 'pending'
        RETURNING id, lead_id`;
      const leadIds = decided.map((d) => d.lead_id).filter((id): id is string => !!id);
      if (leadIds.length === 0) return { approved: 0, released: 0, held: [], skipped: notDecided(rowIds, decided) };

      // The import's reason is spent; any other review reason stays visible.
      await tx.$executeRaw`
        UPDATE leads
           SET review_reasons = array_remove(review_reasons, ${IMPORT_REVIEW_REASON}),
               needs_review = cardinality(array_remove(review_reasons, ${IMPORT_REVIEW_REASON})) > 0,
               updated_at = now()
         WHERE organization_id = ${org}::uuid AND id = ANY(${leadIds}::uuid[])`;

      // Lift the pause only when nothing else holds the lead back.
      const released = await tx.$queryRaw<{ id: string }[]>`
        UPDATE leads
           SET automation_paused = false, updated_at = now()
         WHERE organization_id = ${org}::uuid AND id = ANY(${leadIds}::uuid[])
           AND automation_paused AND NOT dnc_status AND status = ${LeadStatus.NEW}
           AND takeover_user_id IS NULL AND normalized_phone IS NOT NULL
        RETURNING id`;
      const releasedIds = new Set(released.map((r) => r.id));

      const heldIds = leadIds.filter((id) => !releasedIds.has(id));
      const held = heldIds.length
        ? await tx.leads.findMany({
            where: { organization_id: org, id: { in: heldIds } },
            select: { id: true, dnc_status: true, status: true, takeover_user_id: true, normalized_phone: true },
          })
        : [];

      await tx.audit_logs.createMany({
        data: decided
          .filter((d) => d.lead_id)
          .map((d) => ({
            id: newId(),
            organization_id: org,
            actor_type: 'user',
            actor_id: who.userId,
            action: 'sheet_import.approved',
            entity_type: 'lead',
            entity_id: d.lead_id,
            payload: { rowId: d.id, released: releasedIds.has(d.lead_id!) },
          })),
      });

      const rowOf = new Map(decided.map((d) => [d.lead_id, d.id]));
      return {
        approved: decided.length,
        released: releasedIds.size,
        held: held.map((l) => ({ rowId: rowOf.get(l.id)!, leadId: l.id, reason: holdReason(l) })),
        skipped: notDecided(rowIds, decided),
      };
    });
  }

  async reject(who: SessionIdentity, rowIds: string[]) {
    const org = who.organizationId;
    return this.prisma.$transaction(async (tx) => {
      const decided = await tx.$queryRaw<{ id: string; lead_id: string | null }[]>`
        UPDATE sheet_import_rows
           SET review_state = 'rejected', reviewed_by = ${who.userId}::uuid, reviewed_at = now(), updated_at = now()
         WHERE organization_id = ${org}::uuid AND id = ANY(${rowIds}::uuid[]) AND review_state = 'pending'
        RETURNING id, lead_id`;
      const leadIds = decided.map((d) => d.lead_id).filter((id): id is string => !!id);
      if (leadIds.length) {
        // 'closed' is the lead lifecycle's own manual exit. An opt-out lives in
        // dnc_status, which is not touched; the pause stays either way.
        await tx.$executeRaw`
          UPDATE leads
             SET status = ${LeadStatus.CLOSED},
                 lost_reason = ${REJECTED_REASON},
                 automation_paused = true,
                 review_reasons = array_remove(review_reasons, ${IMPORT_REVIEW_REASON}),
                 needs_review = false,
                 updated_at = now()
           WHERE organization_id = ${org}::uuid AND id = ANY(${leadIds}::uuid[])`;
        await tx.audit_logs.createMany({
          data: decided
            .filter((d) => d.lead_id)
            .map((d) => ({
              id: newId(),
              organization_id: org,
              actor_type: 'user',
              actor_id: who.userId,
              action: 'sheet_import.rejected',
              entity_type: 'lead',
              entity_id: d.lead_id,
              payload: { rowId: d.id },
            })),
        });
      }
      return { rejected: decided.length, skipped: notDecided(rowIds, decided) };
    });
  }

  /** Reviewed rows the sheet has changed since, with what would change on the lead. */
  async changes(organizationId: string, q: ChangesQuery) {
    const rows = await this.prisma.sheet_import_rows.findMany({
      where: { organization_id: organizationId, lead_source_id: q.sourceId, changed_after_review_at: { not: null } },
      orderBy: [{ changed_after_review_at: 'desc' }, { id: 'desc' }],
      take: q.limit,
      select: {
        id: true,
        row_number: true,
        review_state: true,
        changed_after_review_at: true,
        changed_values: true,
        leads: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            phone: true,
            email: true,
            location: true,
            min_budget: true,
            max_budget: true,
            bedrooms: true,
            motivation: true,
            custom_fields: true,
          },
        },
      },
    });
    return {
      items: rows.map((r) => {
        const incoming = (r.changed_values as unknown as ChangedValues | null)?.lead;
        const current = r.leads as Record<string, unknown> | null;
        const diff = DIFF_FIELDS.map((field) => ({
          field,
          current: normalize(current?.[field]),
          incoming: normalize((incoming as Record<string, unknown> | undefined)?.[field]),
        })).filter((d) => JSON.stringify(d.current) !== JSON.stringify(d.incoming));
        return {
          rowId: r.id,
          rowNumber: r.row_number,
          reviewState: r.review_state,
          changedAt: r.changed_after_review_at,
          lead: r.leads ? { id: r.leads.id, firstName: r.leads.first_name, lastName: r.leads.last_name } : null,
          incomingDoNotContact: (r.changed_values as unknown as ChangedValues | null)?.dnc ?? false,
          diff,
        };
      }),
    };
  }

  /**
   * Resolve flagged changes: 'apply' copies the sheet's new values onto the
   * lead; 'keep' leaves the lead as reviewed. Either way the flag clears and the
   * row's hash moves to the sheet's current content, so the same change is not
   * raised again.
   */
  async resolve(who: SessionIdentity, rowIds: string[], action: 'apply' | 'keep') {
    const org = who.organizationId;
    return this.prisma.$transaction(async (tx) => {
      const flagged = await tx.$queryRaw<{ id: string; lead_id: string | null; changed_values: ChangedValues }[]>`
        SELECT id, lead_id, changed_values FROM sheet_import_rows
         WHERE organization_id = ${org}::uuid AND id = ANY(${rowIds}::uuid[]) AND changed_after_review_at IS NOT NULL
         FOR UPDATE`;
      if (flagged.length === 0) return { resolved: 0, skipped: rowIds };

      const withLead = flagged.filter((f) => f.lead_id);
      if (action === 'apply' && withLead.length) {
        const values = withLead.map((f) =>
          leadValuesRow(f.lead_id!, f.changed_values.lead, f.changed_values.externalId, f.changed_values.reviewReasons, f.changed_values.dnc),
        );
        // Never clears a DNC flag, and re-pauses a lead whose new phone cannot
        // be dialled. Status, assignment, temperature and score are untouched.
        await tx.$executeRaw`
          UPDATE leads AS l
             SET first_name = v.first_name, last_name = v.last_name,
                 email = v.email, normalized_email = v.normalized_email, email_valid = v.email_valid,
                 phone = v.phone, normalized_phone = v.normalized_phone, phone_valid = v.phone_valid,
                 location = v.location, min_budget = v.min_budget, max_budget = v.max_budget,
                 bedrooms = v.bedrooms, motivation = v.motivation, custom_fields = v.custom_fields,
                 external_lead_id = v.external_lead_id,
                 review_reasons = v.review_reasons, needs_review = cardinality(v.review_reasons) > 0,
                 dnc_status = l.dnc_status OR v.dnc,
                 automation_paused = l.automation_paused OR v.normalized_phone IS NULL OR v.dnc,
                 updated_at = now()
            FROM (VALUES ${Prisma.join(values)}) AS v(id, first_name, last_name, email, normalized_email, email_valid,
                 phone, normalized_phone, phone_valid, location, min_budget, max_budget, bedrooms, motivation,
                 custom_fields, external_lead_id, review_reasons, dnc)
           WHERE l.id = v.id AND l.organization_id = ${org}::uuid`;
      }

      await tx.$executeRaw`
        UPDATE sheet_import_rows
           SET content_hash = changed_values->>'hash', changed_values = NULL, changed_after_review_at = NULL, updated_at = now()
         WHERE organization_id = ${org}::uuid AND id = ANY(${flagged.map((f) => f.id)}::uuid[])`;

      if (withLead.length) {
        await tx.audit_logs.createMany({
          data: withLead.map((f) => ({
            id: newId(),
            organization_id: org,
            actor_type: 'user',
            actor_id: who.userId,
            action: action === 'apply' ? 'sheet_import.change_applied' : 'sheet_import.change_kept',
            entity_type: 'lead',
            entity_id: f.lead_id,
            payload: { rowId: f.id },
          })),
        });
      }
      return { resolved: flagged.length, skipped: rowIds.filter((id) => !flagged.some((f) => f.id === id)) };
    });
  }
}

function holdReason(l: { dnc_status: boolean; status: string; takeover_user_id: string | null; normalized_phone: string | null }): HoldReason {
  if (l.dnc_status) return 'DO_NOT_CONTACT';
  if (l.status !== LeadStatus.NEW) return 'STATUS_CHANGED';
  if (l.takeover_user_id) return 'HUMAN_TAKEOVER';
  return 'NO_DIALABLE_PHONE';
}

/** Rows asked about that were not pending (already decided) or not this organization's. */
function notDecided(rowIds: string[], decided: { id: string }[]): string[] {
  const done = new Set(decided.map((d) => d.id));
  return rowIds.filter((id) => !done.has(id));
}

function normalize(v: unknown): unknown {
  if (v === undefined || v === null || v === '') return null;
  if (v instanceof Prisma.Decimal) return Number(v);
  return v;
}

