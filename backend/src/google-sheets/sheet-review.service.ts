import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { AuditService } from '@/audit/audit.service';
import { PrismaService } from '@/common/prisma/prisma.service';
import type { IntegrationEnv } from '@/common/utils/interface';
import { CRM_INBOUND_FIELDS, NO_NAME_REASON_PREFIX } from '@/crm/crm-records';
import { outreachRequest, type OutreachChoice } from '@/outreach/batches';
import { IMPORT_REASONS_SPENT_ON_DECISION, approveTrackingRows, notDecided } from './approval';
import type { ChangesQueryDto } from './dto/sheets.dto';
import type { SessionIdentity } from './google-connections.service';
import { leadValuesRow, type ChangedValues } from './sheet-import.service';

export const REJECTED_REASON = 'Rejected at import review';

const DIFF_FIELDS = [
  ['first_name', 'firstName'],
  ['last_name', 'lastName'],
  ['phone', 'phone'],
  ['email', 'email'],
  ['location', 'location'],
  ['min_budget', 'minBudget'],
  ['max_budget', 'maxBudget'],
  ['bedrooms', 'bedrooms'],
  ['motivation', 'motivation'],
  ['custom_fields', 'customFields'],
] as const;

/** The owner's decisions on imported rows: approve, reject, and accept or ignore later changes in the sheet. */
@Injectable()
export class SheetReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<IntegrationEnv, true>,
  ) {}

  /** With scheduling on, the approved leads launch through an outreach batch: now, or at the owner's chosen time. */
  async approve(who: SessionIdentity, rowIds: string[], choice?: OutreachChoice) {
    const by = { userId: who.userId };
    const enabled = this.config.get('OUTREACH_SCHEDULING_ENABLED', { infer: true });
    const outreach = await outreachRequest(this.prisma, enabled, who.organizationId, by, choice);
    return this.prisma.$transaction((tx) => approveTrackingRows(tx, this.audit, who.organizationId, rowIds, by, outreach));
  }

  /** A rejected row's lead is closed and kept paused; the row keeps its key, so the next sync does not bring it back. */
  reject(who: SessionIdentity, rowIds: string[]) {
    const orgId = who.organizationId;
    return this.prisma.$transaction(async (tx) => {
      const decided = await tx.$queryRaw<{ id: string; lead_id: string | null }[]>`
        UPDATE sheet_import_rows
           SET review_state = 'rejected', reviewed_by = ${who.userId}::uuid, reviewed_at = now(), updated_at = now()
         WHERE organization_id = ${orgId}::uuid AND id = ANY(${rowIds}::uuid[]) AND review_state = 'pending'
        RETURNING id, lead_id`;
      const leadIds = decided.map((d) => d.lead_id).filter((id): id is string => !!id);
      if (leadIds.length) {
        await tx.$executeRaw`
          UPDATE leads
             SET status = 'closed',
                 lost_reason = ${REJECTED_REASON},
                 automation_paused = true,
                 review_reasons = ARRAY(SELECT r FROM unnest(review_reasons) WITH ORDINALITY AS u(r, n)
                                         WHERE r <> ALL(${IMPORT_REASONS_SPENT_ON_DECISION}::text[]) ORDER BY n),
                 needs_review = false,
                 updated_at = now()
           WHERE organization_id = ${orgId}::uuid AND id = ANY(${leadIds}::uuid[])`;
        await this.audit.recordMany(
          decided
            .filter((d) => d.lead_id)
            .map((d) => ({
              orgId,
              actorType: 'user' as const,
              actorId: who.userId,
              action: 'sheet_import.rejected',
              entityType: 'lead',
              entityId: d.lead_id,
              payload: { rowId: d.id },
            })),
          tx,
        );
      }
      return { rejected: decided.length, skipped: notDecided(rowIds, decided) };
    });
  }

  async changes(orgId: string, q: ChangesQueryDto) {
    const rows = await this.prisma.sheetImportRow.findMany({
      where: { orgId, leadSourceId: q.sourceId, changedAfterReviewAt: { not: null } },
      orderBy: [{ changedAfterReviewAt: 'desc' }, { id: 'desc' }],
      take: q.limit ?? 50,
      select: {
        id: true,
        rowNumber: true,
        reviewState: true,
        changedAfterReviewAt: true,
        changedValues: true,
        lead: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phone: true,
            email: true,
            location: true,
            minBudget: true,
            maxBudget: true,
            bedrooms: true,
            motivation: true,
            customFields: true,
          },
        },
      },
    });
    return {
      items: rows.map((r) => {
        const changed = r.changedValues as unknown as ChangedValues | null;
        const incoming = changed?.lead as unknown as Record<string, unknown> | undefined;
        const current = r.lead as Record<string, unknown> | null;
        // A CRM change only ever writes the CRM's fields (see applyCrmChanges), so only those are a difference worth showing.
        const prefix = changed?.crmPrefix;
        const fields = prefix ? DIFF_FIELDS.filter(([f]) => f === 'custom_fields' || (CRM_INBOUND_FIELDS as readonly string[]).includes(f)) : DIFF_FIELDS;
        const diff = fields
          .map(([field, column]) => ({
            field,
            current: normalize(prefix && field === 'custom_fields' ? ownCustom(current?.[column], prefix) : current?.[column]),
            incoming: normalize(incoming?.[field]),
          }))
          .filter((d) => JSON.stringify(d.current) !== JSON.stringify(d.incoming));
        return {
          rowId: r.id,
          rowNumber: r.rowNumber,
          reviewState: r.reviewState,
          changedAt: r.changedAfterReviewAt,
          lead: r.lead ? { id: r.lead.id, firstName: r.lead.firstName, lastName: r.lead.lastName } : null,
          incomingDoNotContact: changed?.dnc ?? false,
          diff,
        };
      }),
    };
  }

  resolve(who: SessionIdentity, rowIds: string[], action: 'apply' | 'keep') {
    const orgId = who.organizationId;
    return this.prisma.$transaction(async (tx) => {
      const flagged = await tx.$queryRaw<{ id: string; lead_id: string | null; changed_values: ChangedValues }[]>`
        SELECT id, lead_id, changed_values FROM sheet_import_rows
         WHERE organization_id = ${orgId}::uuid AND id = ANY(${rowIds}::uuid[]) AND changed_after_review_at IS NOT NULL
         FOR UPDATE`;
      if (flagged.length === 0) return { resolved: 0, skipped: rowIds };
      const withLead = flagged.filter((f) => f.lead_id);
      const fromSheets = withLead.filter((f) => !f.changed_values.crmPrefix);
      const fromCrm = withLead.filter((f) => f.changed_values.crmPrefix);

      if (action === 'apply' && fromCrm.length) await applyCrmChanges(tx, orgId, fromCrm);
      if (action === 'apply' && fromSheets.length) {
        const values = fromSheets.map((f) =>
          leadValuesRow(f.lead_id!, f.changed_values.lead, f.changed_values.externalId, f.changed_values.reviewReasons, f.changed_values.dnc),
        );
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
           WHERE l.id = v.id AND l.organization_id = ${orgId}::uuid`;
      }
      // For a CRM row the CRM's values at the time of the flag become the base of the next
      // three-way merge either way: "keep" acknowledges them, so only a later change is raised again.
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
         WHERE organization_id = ${orgId}::uuid AND id = ANY(${flagged.map((f) => f.id)}::uuid[])`;
      await this.audit.recordMany(
        withLead.map((f) => ({
          orgId,
          actorType: 'user' as const,
          actorId: who.userId,
          action: action === 'apply' ? 'sheet_import.change_applied' : 'sheet_import.change_kept',
          entityType: 'lead',
          entityId: f.lead_id,
          payload: { rowId: f.id },
        })),
        tx,
      );
      return { resolved: flagged.length, skipped: rowIds.filter((id) => !flagged.some((f) => f.id === id)) };
    });
  }
}

/**
 * Apply CRM changes to leads (a flagged change the owner applies, or a clean one the sync
 * applies itself): the CRM's own fields only. Nothing EstatePulse owns is written, an empty
 * CRM value never clears one, the lead's other custom fields are kept, review reasons are
 * only added to, and a DNC flag is never cleared.
 */
export function applyCrmChanges(
  db: Prisma.TransactionClient | PrismaService,
  orgId: string,
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
     WHERE l.id = v.id AND l.organization_id = ${orgId}::uuid`;
}

/** A lead's custom fields that belong to the CRM with this prefix, for a like-for-like diff. */
function ownCustom(custom: unknown, prefix: string): Record<string, unknown> {
  if (!custom || typeof custom !== 'object') return {};
  return Object.fromEntries(Object.entries(custom as Record<string, unknown>).filter(([k]) => k.startsWith(prefix)));
}

function normalize(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Prisma.Decimal) return Number(value);
  return value;
}
