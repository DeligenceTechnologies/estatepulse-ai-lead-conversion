import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '@/audit/audit.service';
import { PrismaService } from '@/common/prisma/prisma.service';
import { approveTrackingRows, notDecided } from './approval';
import type { ChangesQueryDto } from './dto/sheets.dto';
import type { SessionIdentity } from './google-connections.service';
import { leadValuesRow, type ChangedValues } from './sheet-import.service';
import { FILE_IMPORT_REVIEW_REASON, IMPORT_REVIEW_REASON } from './sheet-rows';

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
  ) {}

  approve(who: SessionIdentity, rowIds: string[]) {
    return this.prisma.$transaction((tx) => approveTrackingRows(tx, this.audit, who.organizationId, rowIds, { userId: who.userId }));
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
                 review_reasons = array_remove(array_remove(review_reasons, ${IMPORT_REVIEW_REASON}), ${FILE_IMPORT_REVIEW_REASON}),
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
        const diff = DIFF_FIELDS.map(([field, column]) => ({
          field,
          current: normalize(current?.[column]),
          incoming: normalize(incoming?.[field]),
        })).filter((d) => JSON.stringify(d.current) !== JSON.stringify(d.incoming));
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

      if (action === 'apply' && withLead.length) {
        const values = withLead.map((f) =>
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
      await tx.$executeRaw`
        UPDATE sheet_import_rows
           SET content_hash = changed_values->>'hash', changed_values = NULL, changed_after_review_at = NULL, updated_at = now()
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

function normalize(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Prisma.Decimal) return Number(value);
  return value;
}
