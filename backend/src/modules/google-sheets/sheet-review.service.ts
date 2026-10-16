import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { LeadStatus } from '../../common/domain';
import { newId } from '../../common/ids';
import { TENANT_PRISMA, type GuardedPrisma } from '../../prisma/prisma.service';
import { CRM_INBOUND_FIELDS, NO_NAME_REASON_PREFIX } from '../crm/crm-records';
import { IMPORT_REASONS_SPENT_ON_DECISION, approveTrackingRows, type Tx } from './approval';
import type { SessionIdentity } from './google-connections.service';
import { leadValuesRow, type ChangedValues } from './sheet-import.service';
import type { ChangesQuery } from './schemas';

export const REJECTED_REASON = 'Rejected at import review';

export type { HoldReason } from './approval';

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

  /** The owner's approval. The same rules as a clean row approved on import — see approval.ts. */
  async approve(who: SessionIdentity, rowIds: string[]) {
    return this.prisma.$transaction((tx) => approveTrackingRows(tx, who.organizationId, rowIds, { userId: who.userId }));
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
                 review_reasons = ARRAY(SELECT r FROM unnest(review_reasons) WITH ORDINALITY AS u(r, n)
                                         WHERE r <> ALL(${IMPORT_REASONS_SPENT_ON_DECISION}::text[]) ORDER BY n),
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
        const changed = r.changed_values as unknown as ChangedValues | null;
        const incoming = changed?.lead;
        const current = r.leads as Record<string, unknown> | null;
        // A CRM change only ever writes the CRM's fields (see resolve), so only
        // those are a difference worth showing — and only its own custom keys.
        const prefix = changed?.crmPrefix;
        const fields: readonly string[] = prefix ? [...CRM_INBOUND_FIELDS, 'custom_fields'] : DIFF_FIELDS;
        const diff = fields
          .map((field) => ({
            field,
            current: normalize(prefix && field === 'custom_fields' ? ownCustom(current?.[field], prefix) : current?.[field]),
            incoming: normalize((incoming as Record<string, unknown> | undefined)?.[field]),
          }))
          .filter((d) => JSON.stringify(d.current) !== JSON.stringify(d.incoming));
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
      const fromSheets = withLead.filter((f) => !f.changed_values.crmPrefix);
      const fromCrm = withLead.filter((f) => f.changed_values.crmPrefix);
      if (action === 'apply' && fromCrm.length) await applyCrmChanges(tx, org, fromCrm);
      if (action === 'apply' && fromSheets.length) {
        const values = fromSheets.map((f) =>
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

      // Either way the CRM's values at the time of the flag become the base of
      // the next three-way merge (crmMerge): "keep" acknowledges them without
      // applying them, so only a LATER change in the CRM is raised again.
      await tx.$executeRaw`
        UPDATE sheet_import_rows
           SET content_hash = changed_values->>'hash',
               synced_values = CASE WHEN changed_values ? 'crmPrefix' THEN jsonb_build_object(
                                 'first_name', changed_values->'lead'->'first_name', 'last_name', changed_values->'lead'->'last_name',
                                 'email', changed_values->'lead'->'email',
                                 'phone', COALESCE(NULLIF(changed_values->'lead'->'normalized_phone', 'null'::jsonb), changed_values->'lead'->'phone'),
                                 'custom', COALESCE(changed_values->'lead'->'custom_fields', '{}'::jsonb))
                               ELSE synced_values END,
               changed_values = NULL, changed_after_review_at = NULL, updated_at = now()
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

/**
 * Apply CRM changes to leads — a flagged change the owner applies, or a clean
 * one the sync applies itself: the CRM's own fields only. Unlike a sheet row, a
 * CRM contact may have been LINKED to a lead that already existed (matched by
 * email), whose budget, location and other answers came from somewhere else —
 * a form, a call. So:
 *  - nothing EstatePulse owns is written;
 *  - an empty CRM value never clears one (COALESCE): a CRM read cannot tell a
 *    deliberate clear from an absent value, and losing a phone number is worse
 *    than keeping a stale one;
 *  - the lead's other custom fields are kept; only the CRM's prefixed keys are
 *    replaced, since those mirror the CRM;
 *  - review reasons are added to, never replaced, and "no name" is not added
 *    to a lead that has one;
 *  - a DNC flag is never cleared, and a newly applied phone that cannot be
 *    dialled pauses the lead, as on a sheet.
 */
export function applyCrmChanges(
  db: Tx | GuardedPrisma,
  org: string,
  rows: { lead_id: string | null; changed_values: ChangedValues }[],
): Prisma.PrismaPromise<number> {
  const values = rows.map((f) => {
    const l = f.changed_values.lead;
    return Prisma.sql`(${f.lead_id}::uuid, ${l.first_name}::varchar, ${l.last_name}::varchar, ${l.email}::varchar,
      ${l.normalized_email}::varchar, ${l.email_valid}::boolean, ${l.phone}::varchar, ${l.normalized_phone}::varchar,
      ${l.phone_valid}::boolean, ${JSON.stringify(l.custom_fields)}::jsonb, ${f.changed_values.crmPrefix!}::text,
      ${f.changed_values.externalId}::varchar, ${f.changed_values.reviewReasons}::text[], ${f.changed_values.dnc}::boolean)`;
  });
  return db.$executeRaw`
    UPDATE leads AS l
       SET first_name = COALESCE(v.first_name, l.first_name), last_name = COALESCE(v.last_name, l.last_name),
           email = COALESCE(v.email, l.email),
           normalized_email = CASE WHEN v.email IS NULL THEN l.normalized_email ELSE v.normalized_email END,
           email_valid = CASE WHEN v.email IS NULL THEN l.email_valid ELSE v.email_valid END,
           phone = COALESCE(v.phone, l.phone),
           normalized_phone = CASE WHEN v.phone IS NULL THEN l.normalized_phone ELSE v.normalized_phone END,
           phone_valid = CASE WHEN v.phone IS NULL THEN l.phone_valid ELSE v.phone_valid END,
           custom_fields = COALESCE((SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(l.custom_fields) AS e
                                      WHERE left(e.key, length(v.prefix)) <> v.prefix), '{}'::jsonb) || v.custom,
           external_lead_id = COALESCE(l.external_lead_id, v.external_lead_id),
           review_reasons = l.review_reasons || ARRAY(
             SELECT r FROM unnest(v.review_reasons) AS r
              WHERE r <> ALL(l.review_reasons)
                AND NOT (left(r, length(${NO_NAME_REASON_PREFIX})) = ${NO_NAME_REASON_PREFIX}
                         AND COALESCE(v.first_name, l.first_name, v.last_name, l.last_name) IS NOT NULL)),
           needs_review = l.needs_review OR EXISTS (
             SELECT 1 FROM unnest(v.review_reasons) AS r
              WHERE NOT (left(r, length(${NO_NAME_REASON_PREFIX})) = ${NO_NAME_REASON_PREFIX}
                         AND COALESCE(v.first_name, l.first_name, v.last_name, l.last_name) IS NOT NULL)),
           dnc_status = l.dnc_status OR v.dnc,
           automation_paused = l.automation_paused OR (v.phone IS NOT NULL AND v.normalized_phone IS NULL) OR v.dnc,
           updated_at = now()
      FROM (VALUES ${Prisma.join(values)}) AS v(id, first_name, last_name, email, normalized_email, email_valid,
           phone, normalized_phone, phone_valid, custom, prefix, external_lead_id, review_reasons, dnc)
     WHERE l.id = v.id AND l.organization_id = ${org}::uuid`;
}

/** A lead's custom fields that belong to the CRM with this prefix, for a like-for-like diff. */
function ownCustom(custom: unknown, prefix: string): Record<string, unknown> {
  if (!custom || typeof custom !== 'object') return {};
  return Object.fromEntries(Object.entries(custom as Record<string, unknown>).filter(([k]) => k.startsWith(prefix)));
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

