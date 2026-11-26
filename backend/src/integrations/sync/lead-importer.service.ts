import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConsentStatus, LeadStatus, LeadTemperature, Prisma } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';
import { DUPLICATE_REASON } from '@/lead/duplicates/duplicate-reasons';
import { isSuppressed } from '@/lead/contact-suppression';
import { normalizeEmail, normalizePhone } from '@/lead/duplicates/identity';
import { mergeObjects } from '@/lead/duplicates/merge-rules';
import { LeadStateService } from '@/lead/lead-state.service';
import { LeadIntakeService, type SubmissionChannel } from '@/lead/duplicates/lead-intake.service';
import { PHONE_UNPARSED_REASON } from '@/lead/review-reasons';
import type { ImportedRecord } from '../adapters/adapter.interface';
import {
  leadValues,
  mergeInbound,
  planOutbound,
  readState,
  recordValues,
  stateJson,
  type SyncField,
  type SyncState,
  type SyncValues,
} from './two-way';

const DNC_REASON = 'This phone or email is on the do-not-contact list from an earlier lead';

/** On every imported lead: nobody consented to EstatePulse calling them, so a person approves first. */
export const importReviewReason = (providerName: string) => `Imported from ${providerName} — awaiting owner approval`;

export type ImportOutcome = 'created' | 'attached' | 'unchanged' | 'skipped';

/** Two-way sync is on for this connection: linked leads follow the provider's changes field by field. */
export interface TwoWayImport {
  fields: readonly SyncField[];
  /** When the page holding this record was read; a record written back after that is not merged from it. */
  fetchedAt: Date;
}

export interface KnownRecord {
  hash: string;
  leadId: string | null;
  hasState: boolean;
}

export interface ImportResult {
  outcome: ImportOutcome;
  leadId: string | null;
  /** A lead change still has to be written back to this record (EstatePulse won a conflict, or a baseline found one). */
  pushRecordId?: string;
}

/** The lead columns two-way sync reads and writes. */
const LEAD_SYNC_SELECT = {
  id: true,
  orgId: true,
  mergedIntoId: true,
  dncStatus: true,
  customFields: true,
  updatedAt: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  location: true,
  timeline: true,
  motivation: true,
  minBudget: true,
  maxBudget: true,
  bedrooms: true,
} satisfies Prisma.LeadSelect;

const recordKey = (objectType: string, externalId: string) => `${objectType}\u0000${externalId.slice(0, 255)}`;

export interface ImportTarget {
  orgId: string;
  connectionId: string;
  leadSourceId: string | null;
  /** "Airtable · Buyers", for the lead's history. */
  sourceName: string;
  /** "Airtable", for the review reason. */
  providerName: string;
  channel: SubmissionChannel;
}

/** The fields whose change means "import this record again". Order-stable, so the hash is too. */
function contentHash(record: ImportedRecord): string {
  // `meta` is bookkeeping for write-back, not content: it must not make every record look changed.
  const { objectType: _o, externalId: _e, customFields, meta: _m, ...values } = record;
  const sortedCustom = Object.fromEntries(Object.entries(customFields ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  const sortedValues = Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256').update(JSON.stringify([sortedValues, sortedCustom])).digest('hex');
}

const cap = (v: string | null | undefined, max: number) => (v ? v.slice(0, max) : null);

/**
 * Turns records read from a provider into leads, idempotently:
 * - a record already imported with the same content is skipped (`unchanged`),
 *   so re-running a sync costs reads, not writes;
 * - a new or changed record goes through LeadIntakeService, so a person who is
 *   already a lead (same phone or email, from any source) is attached to that
 *   lead with blanks filled — never duplicated, never overwritten;
 * - a new lead is held for review and paused: the provider gives no consent to
 *   be called, so the owner approves before any outreach.
 */
@Injectable()
export class LeadImporterService {
  private readonly logger = new Logger(LeadImporterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly intake: LeadIntakeService,
    private readonly state: LeadStateService,
  ) {}

  /** Existing record hashes for one page, in one query. */
  async knownHashes(connectionId: string, records: ImportedRecord[]): Promise<Map<string, KnownRecord>> {
    if (!records.length) return new Map();
    const rows = await this.prisma.integrationRecord.findMany({
      where: { connectionId, OR: records.map((r) => ({ objectType: r.objectType, externalId: r.externalId.slice(0, 255) })) },
      select: { objectType: true, externalId: true, contentHash: true, leadId: true, syncState: true },
    });
    return new Map(
      rows.map((r) => [recordKey(r.objectType, r.externalId), { hash: r.contentHash, leadId: r.leadId, hasState: r.syncState !== null }]),
    );
  }

  async importRecord(target: ImportTarget, record: ImportedRecord, known: Map<string, KnownRecord>, twoWay: TwoWayImport | null = null): Promise<ImportResult> {
    const hash = contentHash(record);
    const prior = known.get(recordKey(record.objectType, record.externalId));
    // Same content as last time: nothing to write (a contact-less record stays skipped).
    // With two-way on, a record linked before two-way existed still needs its base.
    if (prior && prior.hash === hash && !(twoWay && prior.leadId && !prior.hasState)) {
      return { outcome: prior.leadId ? 'unchanged' : 'skipped', leadId: prior.leadId };
    }

    // Already linked to a lead and two-way is on: merge field by field instead of filling blanks.
    if (twoWay && prior?.leadId) {
      const merged = await this.mergeLinked(target, record, hash, prior.leadId, twoWay);
      if (merged) return merged;
      // The lead is gone: import the record as if new.
    }

    const rawPhone = record.phone?.trim() || null;
    const normalizedPhone = normalizePhone(rawPhone);
    const normalizedEmail = normalizeEmail(record.email);
    // Nobody to contact and nothing to match on: not a lead.
    if (!rawPhone && !normalizedEmail) {
      await this.remember(target, record, hash, prior?.leadId ?? null);
      return { outcome: 'skipped', leadId: null };
    }

    const dnc =
      (await this.prisma.lead.count({
        where: {
          orgId: target.orgId,
          dncStatus: true,
          OR: [...(normalizedPhone ? [{ normalizedPhone }] : []), ...(normalizedEmail ? [{ normalizedEmail }] : [])],
        },
      })) > 0;

    const now = new Date();
    const values = {
      firstName: cap(record.firstName, 100),
      lastName: cap(record.lastName, 100),
      email: cap(record.email?.trim(), 255),
      phone: cap(rawPhone, 50),
      location: cap(record.location, 255),
      timeline: cap(record.timeline, 100),
      motivation: record.motivation ?? null,
      minBudget: record.minBudget ?? null,
      maxBudget: record.maxBudget ?? null,
      bedrooms: record.bedrooms ?? null,
    };

    const result = await this.intake.intake(
      {
        orgId: target.orgId,
        leadSourceId: target.leadSourceId,
        sourceName: target.sourceName,
        channel: target.channel,
        normalizedPhone,
        normalizedEmail,
        values,
        customFields: record.customFields,
        submittedAt: now,
        actor: { type: 'system' },
      },
      async (tx, conflictWith) => {
        const reasons = [
          importReviewReason(target.providerName),
          ...(rawPhone && !normalizedPhone ? [PHONE_UNPARSED_REASON] : []),
          ...(dnc ? [DNC_REASON] : []),
          ...(conflictWith.length ? [DUPLICATE_REASON] : []),
        ];
        const created = await tx.lead.create({
          data: {
            orgId: target.orgId,
            leadSourceId: target.leadSourceId,
            externalLeadId: cap(record.externalId, 255),
            ...values,
            minBudget: values.minBudget === null ? null : new Prisma.Decimal(values.minBudget),
            maxBudget: values.maxBudget === null ? null : new Prisma.Decimal(values.maxBudget),
            normalizedEmail,
            emailValid: Boolean(normalizedEmail),
            normalizedPhone,
            phoneValid: Boolean(normalizedPhone),
            status: LeadStatus.new,
            temperature: LeadTemperature.cold,
            score: 0,
            customFields: (record.customFields ?? {}) as Prisma.InputJsonValue,
            consentStatus: ConsentStatus.pending,
            dncStatus: dnc,
            automationPaused: true,
            needsReview: true,
            reviewReasons: reasons,
            lastSubmissionAt: now,
          },
          select: { id: true },
        });
        return created.id;
      },
    );

    if (!twoWay) {
      await this.remember(target, record, hash, result.leadId);
      return { outcome: result.matchedBy ? 'attached' : 'created', leadId: result.leadId };
    }
    // Two-way: this is the record's first link, so what both sides hold now is the base.
    await this.linkWithBase(target, record, hash, result.leadId, twoWay.fields);
    return { outcome: result.matchedBy ? 'attached' : 'created', leadId: result.leadId };
  }

  /**
   * Three-way merge of a changed provider record into the lead it is linked
   * to (rules in two-way.ts). Runs under a lock on the record row, so a
   * write-back of the same record never interleaves with it. Returns null when
   * the lead no longer exists.
   */
  private async mergeLinked(target: ImportTarget, record: ImportedRecord, hash: string, leadId: string, twoWay: TwoWayImport): Promise<ImportResult | null> {
    const externalId = record.externalId.slice(0, 255);
    return this.prisma.$transaction(
      async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM integration_records
          WHERE connection_id = ${target.connectionId}::uuid AND object_type = ${record.objectType} AND external_id = ${externalId}
          FOR UPDATE`;
        if (!locked.length) return null;
        const row = await tx.integrationRecord.findUniqueOrThrow({
          where: { id: locked[0].id },
          select: { id: true, syncState: true, pushedAt: true },
        });
        // Read before our own last write-back reached the provider: this copy is stale. The next sync sees the new one.
        if (row.pushedAt && row.pushedAt > twoWay.fetchedAt) return { outcome: 'unchanged', leadId };

        let lead = await tx.lead.findUnique({ where: { id: leadId }, select: LEAD_SYNC_SELECT });
        // Merged into another lead since: the record follows the person.
        if (lead?.mergedIntoId) lead = await tx.lead.findUnique({ where: { id: lead.mergedIntoId }, select: LEAD_SYNC_SELECT });
        if (!lead || lead.mergedIntoId) return null;

        const state = readState(row.syncState);
        const localNow = leadValues(lead, twoWay.fields);
        const merge = mergeInbound(twoWay.fields, recordValues(record, twoWay.fields), localNow, state, record.meta ?? {});
        const changed = Object.keys(merge.apply) as SyncField[];

        const data = await this.leadUpdate(tx, lead.orgId, merge.apply, lead.dncStatus);
        if (record.customFields && Object.keys(record.customFields).length) {
          // The provider's latest labels (lifecycle stage...) win; keys only EstatePulse has stay.
          const custom = mergeObjects(record.customFields, lead.customFields);
          if (JSON.stringify(custom) !== JSON.stringify(lead.customFields ?? {})) data.customFields = custom as Prisma.InputJsonValue;
        }
        let leadVersion = lead.updatedAt;
        if (Object.keys(data).length) {
          const updated = await tx.lead.update({ where: { id: lead.id }, data, select: { updatedAt: true } });
          leadVersion = updated.updatedAt;
          if (changed.length) {
            await this.state.record(
              {
                orgId: lead.orgId,
                leadId: lead.id,
                type: 'integration_synced',
                source: 'integration',
                reason: `Updated from ${target.sourceName}: ${changed.join(', ')}`,
                payload: { connectionId: target.connectionId, fields: changed, keptEstatePulse: merge.conflicts },
              },
              tx,
            );
          }
        }

        const localAfter: SyncValues = { ...localNow, ...merge.apply };
        const pending = Object.keys(planOutbound(twoWay.fields, twoWay.fields, localAfter, merge.next).changes).length > 0;
        await tx.integrationRecord.update({
          where: { id: row.id },
          data: {
            contentHash: hash,
            lastSeenAt: new Date(),
            leadId: lead.id,
            syncState: stateJson(merge.next),
            // A lead change still to be written back keeps the record due for a push.
            ...(pending ? {} : { localCheckedAt: leadVersion }),
          },
        });
        return { outcome: changed.length ? 'attached' : 'unchanged', leadId: lead.id, ...(pending ? { pushRecordId: row.id } : {}) };
      },
      { timeout: 20_000 },
    );
  }

  /** First link under two-way: remember the record with both sides' current values as the base. */
  private async linkWithBase(target: ImportTarget, record: ImportedRecord, hash: string, leadId: string, fields: readonly SyncField[]): Promise<void> {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId }, select: LEAD_SYNC_SELECT });
    if (!lead) {
      await this.remember(target, record, hash, leadId);
      return;
    }
    const localNow = leadValues(lead, fields);
    const empty: SyncState = { v: 1, local: {}, remote: {}, meta: {} };
    // Intake already filled the lead's blanks; this only records where both sides stand.
    const { next } = mergeInbound(fields, recordValues(record, fields), localNow, empty, record.meta ?? {});
    // Values that already differ stay as they are on both sides until one of them changes.
    next.local = { ...localNow };
    await this.remember(target, record, hash, leadId, { syncState: stateJson(next), localCheckedAt: lead.updatedAt });
  }

  /** The lead columns for provider values being applied, with the identity columns derived from them. */
  private async leadUpdate(tx: Prisma.TransactionClient, orgId: string, apply: SyncValues, dnc: boolean): Promise<Prisma.LeadUncheckedUpdateInput> {
    const data: Prisma.LeadUncheckedUpdateInput = {};
    for (const [field, value] of Object.entries(apply) as [SyncField, string | number | null][]) {
      if (field === 'minBudget' || field === 'maxBudget') data[field] = value === null ? null : new Prisma.Decimal(value);
      else if (field === 'bedrooms') data.bedrooms = value === null ? null : Math.round(Number(value));
      else data[field] = value === null ? null : String(value);
    }
    if ('email' in apply) {
      const normalizedEmail = normalizeEmail(apply.email === null ? null : String(apply.email));
      data.normalizedEmail = normalizedEmail;
      data.emailValid = Boolean(normalizedEmail);
    }
    if ('phone' in apply) {
      const normalizedPhone = normalizePhone(apply.phone === null ? null : String(apply.phone));
      data.normalizedPhone = normalizedPhone;
      data.phoneValid = Boolean(normalizedPhone);
      // A number that opted out stays out, whichever lead it arrives on.
      if (!dnc && normalizedPhone && (await isSuppressed(tx, orgId, normalizedPhone))) {
        data.dncStatus = true;
        data.automationPaused = true;
      }
    }
    return data;
  }

  private async remember(
    target: ImportTarget,
    record: ImportedRecord,
    hash: string,
    leadId: string | null,
    twoWay: { syncState: Prisma.InputJsonValue; localCheckedAt: Date } | null = null,
  ): Promise<void> {
    const now = new Date();
    await this.prisma.integrationRecord.upsert({
      where: {
        connectionId_objectType_externalId: {
          connectionId: target.connectionId,
          objectType: record.objectType,
          externalId: record.externalId.slice(0, 255),
        },
      },
      create: {
        orgId: target.orgId,
        connectionId: target.connectionId,
        objectType: record.objectType,
        externalId: record.externalId.slice(0, 255),
        leadId,
        contentHash: hash,
        ...(twoWay ?? {}),
      },
      update: { contentHash: hash, lastSeenAt: now, ...(leadId ? { leadId } : {}), ...(twoWay ?? {}) },
      select: { id: true },
    });
  }
}
