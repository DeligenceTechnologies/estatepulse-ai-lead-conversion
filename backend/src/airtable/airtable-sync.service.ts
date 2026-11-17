import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationStatus, LeadSourceProvider, Prisma, ReviewState } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AuditService } from '@/audit/audit.service';
import { PrismaService } from '@/common/prisma/prisma.service';
import type { IntegrationEnv } from '@/common/utils/interface';
import { EventsBus } from '@/events/events.bus';
import { RunStats, SheetImportService } from '@/google-sheets/sheet-import.service';
import { SheetReviewService } from '@/google-sheets/sheet-review.service';
import type { BuiltRow, StoredMapping } from '@/google-sheets/sheet-rows';
import { AirtableClient } from './airtable.client';
import { AirtableConnectionsService } from './airtable-connections.service';
import {
  AIRTABLE_IMPORT_REVIEW_REASON,
  airtableRowKey,
  buildAirtableRow,
  outboundHash,
  rowContext,
  toAirtableFields,
  type OutboundLead,
} from './airtable-records';
import type { Approval } from '@/google-sheets/sheet-import.service';
import { readSyncConfig, readsIn, writesOut, type AirtableSyncConfig } from './sync-config';
import { WRITE_BACK_BY_KEY, writeBackValues, type WriteBackSource } from './write-back';
import { AirtableApiError, type AirtableField, type AirtableRecord } from './types';

/**
 * The Airtable synchronisation engine.
 *
 * One worker, the same shape as the CRM one: a source is claimed with a lease
 * (FOR UPDATE SKIP LOCKED), worked on for a slice, then released, so two API
 * instances never write the same table at once and one big table cannot starve
 * the others.
 *
 * Each slice does, in order:
 *   1. push  — leads changed in EstatePulse are written to Airtable
 *   2. pull  — records changed in Airtable are read back into EstatePulse
 *
 * Loop prevention is a fingerprint, not a timer. Every push stores the hash of
 * exactly what it wrote (pushed_hash); when that write comes back round as a
 * change, its fingerprint matches and it is recorded as seen and dropped. No
 * echo is ever written back, so no loop can form.
 */

/** A slice holds one source for at most this long, so organizations take turns. */
const SLICE_MS = 20_000;
/** A lease older than this is presumed dead (process killed mid-slice) and may be taken over. */
const LEASE_STUCK_SECONDS = 300;
/** Records pushed per slice. */
const PUSH_PER_SLICE = 200;
/** A push that keeps failing for a reason other than auth or rate limiting is parked after this many tries. */
const MAX_PUSH_ATTEMPTS = 8;
/** Base delay for a failed push; doubles each attempt. */
const PUSH_BACKOFF_MS = 30_000;
/** Pages of webhook payloads per slice (50 each), and pages of a full re-read. */
const MAX_PAYLOAD_PAGES = 20;
const MAX_RECONCILE_PAGES = 100;
/** Record ids re-read in one request. */
const READ_CHUNK = 50;

/**
 * The key a tracking row carries between "we are about to ask Airtable to
 * create this lead" and "Airtable told us which record it became".
 *
 * A settled key is the sha256 of a record id — 64 hex characters — so this can
 * never be mistaken for one.
 */
export const PENDING_PREFIX = 'pending:';
export const pendingRowKey = (leadId: string): string => `${PENDING_PREFIX}${leadId}`;

interface Claimed {
  id: string;
  organization_id: string;
  integration_id: string | null;
  external_form_id: string | null;
  default_consent_status: string;
  sync_config: Prisma.JsonValue | null;
  sync_next_at: Date | null;
}

interface Ctx {
  orgId: string;
  sourceId: string;
  credentialId: string;
  baseId: string;
  tableId: string;
  config: AirtableSyncConfig;
  defaultConsent: string;
  logTag: string;
}

export interface SyncCounts {
  pushedCreated: number;
  pushedUpdated: number;
  pushFailed: number;
  pulled: number;
  applied: number;
  /** Records clean enough to start outreach without anybody looking at them. */
  approved: number;
  conflicts: number;
  echoes: number;
  missing: number;
}

const zero = (): SyncCounts => ({ pushedCreated: 0, pushedUpdated: 0, pushFailed: 0, pulled: 0, applied: 0, approved: 0, conflicts: 0, echoes: 0, missing: 0 });

/**
 * A record that arrived during a sync and needs nobody to look at it.
 *
 * The owner approved this table once, when they set it up; records that turn
 * up afterwards are the same table doing what it was connected to do. Holding
 * every one of them would mean a two-way sync that stops dead until somebody
 * clicks, which is not a sync.
 *
 * So a record is approved only when there is nothing to decide about it: no
 * warning from the row builder, no collision with a lead already here, no
 * inherited do-not-contact, and a phone that can actually be dialled. Anything
 * else is a judgement, and judgements wait in Import Review.
 *
 * A dialable phone is part of "clean" rather than left to the release check
 * because approving without it would be worse than holding: the lead would
 * leave Import Review, never be called, and nobody would be told.
 *
 * by.userId is null, so the audit records the sync rather than crediting
 * whoever last signed in. No outreach request: a lead that arrives now is
 * released now, which is what the strategy is for.
 */
export const AUTO_APPROVE: Approval = {
  rule: (row, flags) => !flags.dnc && !flags.duplicate && row.reviewReasons.length === 0 && Boolean(row.lead?.normalized_phone),
  by: { userId: null },
};
const eventful = (c: SyncCounts): boolean => Object.values(c).some((n) => n > 0);

@Injectable()
export class AirtableSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('AirtableSync');
  private readonly instanceId = `airtable-${randomUUID()}`;
  private draining: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: AirtableConnectionsService,
    private readonly client: AirtableClient,
    private readonly importer: SheetImportService,
    private readonly reviews: SheetReviewService,
    private readonly audit: AuditService,
    private readonly events: EventsBus,
    private readonly config: ConfigService<IntegrationEnv, true>,
  ) {}

  onModuleInit(): void {
    if (!this.config.get('AIRTABLE_ENABLED', { infer: true })) {
      this.logger.log('Airtable sync disabled (set AIRTABLE_ENABLED=true)');
      return;
    }
    const pollMs = this.config.get('AIRTABLE_POLL_MS', { infer: true });
    if (pollMs <= 0) {
      this.logger.log('periodic Airtable sync off (AIRTABLE_POLL_MS=0); owner actions and webhooks still run it');
      return;
    }
    this.timer = setInterval(() => this.nudge(), pollMs);
    this.timer.unref?.();
    this.nudge();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Process due work soon, in the background. Never throws; never makes the caller wait. */
  nudge(): void {
    void this.drain();
  }

  drain(): Promise<void> {
    if (!this.config.get('AIRTABLE_ENABLED', { infer: true })) return Promise.resolve();
    if (this.draining) {
      this.again = true;
      return this.draining;
    }
    this.draining = this.loop().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  private async loop(): Promise<void> {
    try {
      do {
        this.again = false;
        for (;;) {
          if (this.stopped) return;
          const claimed = await this.claim();
          if (!claimed) break;
          await this.slice(claimed);
        }
      } while (this.again && !this.stopped);
    } catch (e) {
      this.logger.error(`Airtable sync loop failed: ${(e as Error).message}`);
    }
  }

  /**
   * A live Airtable source with due work and a free (or dead) lease. Claiming
   * and releasing bump updated_at, so the source worked least recently goes
   * first and one big table cannot starve the rest.
   */
  private async claim(): Promise<Claimed | null> {
    const rows = await this.prisma.$queryRaw<Claimed[]>`
      WITH due AS (
        SELECT s.id FROM lead_sources s
          JOIN integrations c ON c.id = s.integration_id AND c.organization_id = s.organization_id
         WHERE s.provider = 'AIRTABLE' AND s.connection_method = 'SYNC'
           AND s.archived_at IS NULL AND s.is_active
           AND c.status = 'active' AND c.revoked_at IS NULL
           AND (s.sync_locked_at IS NULL OR s.sync_locked_at < now() - make_interval(secs => ${LEASE_STUCK_SECONDS}))
           AND (
             s.sync_next_at <= now()
             OR EXISTS (SELECT 1 FROM sheet_import_rows r
                         WHERE r.lead_source_id = s.id AND r.push_available_at IS NOT NULL AND r.push_available_at <= now())
           )
         ORDER BY s.updated_at, s.id
         FOR UPDATE OF s SKIP LOCKED
         LIMIT 1
      )
      UPDATE lead_sources s
         SET sync_locked_at = now(), sync_locked_by = ${this.instanceId}, updated_at = now()
        FROM due
       WHERE s.id = due.id
      RETURNING s.id, s.organization_id, s.integration_id, s.external_form_id,
                s.default_consent_status::text AS default_consent_status, s.sync_config, s.sync_next_at`;
    return rows[0] ?? null;
  }

  /**
   * Holds one source for a job running in front of an owner, so the worker and
   * a second click both stay off it. Returns false when something else has it.
   *
   * The same lease columns the worker uses, so neither side needs to know about
   * the other: whoever holds it, holds it.
   */
  async hold(orgId: string, sourceId: string): Promise<boolean> {
    const n = await this.prisma.$executeRaw`
      UPDATE lead_sources
         SET sync_locked_at = now(), sync_locked_by = ${this.instanceId}
       WHERE id = ${sourceId}::uuid AND organization_id = ${orgId}::uuid
         AND (sync_locked_at IS NULL OR sync_locked_at < now() - make_interval(secs => ${LEASE_STUCK_SECONDS}))`;
    return n === 1;
  }

  /** Gives the hold back. Safe when it was already taken over as stale. */
  async releaseHold(orgId: string, sourceId: string): Promise<void> {
    await this.release({ orgId, sourceId });
  }

  private async heartbeat(ctx: { sourceId: string; orgId: string }): Promise<boolean> {
    const n = await this.prisma.$executeRaw`
      UPDATE lead_sources SET sync_locked_at = now()
       WHERE id = ${ctx.sourceId}::uuid AND organization_id = ${ctx.orgId}::uuid AND sync_locked_by = ${this.instanceId}`;
    return n === 1;
  }

  private async release(ctx: { sourceId: string; orgId: string }): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE lead_sources SET sync_locked_at = NULL, sync_locked_by = NULL, updated_at = now()
       WHERE id = ${ctx.sourceId}::uuid AND organization_id = ${ctx.orgId}::uuid AND sync_locked_by = ${this.instanceId}`;
  }

  /** Re-checked before every write: a disconnect mid-slice stops the slice. */
  private async stillLive(ctx: Ctx): Promise<boolean> {
    const n = await this.prisma.integration.count({
      where: { id: ctx.credentialId, orgId: ctx.orgId, status: IntegrationStatus.active, revokedAt: null },
    });
    return n === 1 && (await this.heartbeat(ctx));
  }

  private async slice(c: Claimed): Promise<void> {
    const [baseId = '', tableId = ''] = (c.external_form_id ?? '').split(':');
    const ctx: Ctx = {
      orgId: c.organization_id,
      sourceId: c.id,
      credentialId: c.integration_id ?? '',
      baseId,
      tableId,
      config: readSyncConfig(c.sync_config),
      defaultConsent: c.default_consent_status,
      logTag: `Airtable source ${c.id}`,
    };
    const counts = zero();
    try {
      if (!baseId || !tableId || !ctx.credentialId) return;
      const deadline = Date.now() + SLICE_MS;
      const source = await this.prisma.leadSource.findFirst({
        where: { id: ctx.sourceId, orgId: ctx.orgId },
        select: { externalWebhookId: true, syncRemoteVersion: true },
      });
      // Push first: a lead edited here should reach Airtable before we read it
      // back, so the read sees our own write and recognises it as an echo.
      let backlog = false;
      if (writesOut(ctx.config)) backlog = await this.pushChanges(ctx, counts, deadline);
      if (readsIn(ctx.config) && source) {
        await this.ensureWebhook(ctx, source);
        const fresh = await this.prisma.leadSource.findFirst({
          where: { id: ctx.sourceId, orgId: ctx.orgId },
          select: { externalWebhookId: true, syncRemoteVersion: true },
        });
        if (fresh) backlog = (await this.pullChanges(ctx, counts, fresh)) || backlog;
      }
      await this.prisma.leadSource.updateMany({
        where: { id: ctx.sourceId, orgId: ctx.orgId },
        data: {
          lastSuccessAt: new Date(),
          syncFailures: 0,
          remoteErrorCode: null,
          remoteErrorMessage: null,
          // Work left over comes straight back. Without this a table with more
          // changes than one slice can carry would drain one slice per
          // reconcile interval — an hour by default — and look stuck.
          syncNextAt: backlog ? new Date() : this.nextReconcileAt(),
        },
      });
      if (eventful(counts)) await this.record(ctx, 'airtable_sync.ran', counts);
      if (counts.applied > 0) this.events.publish({ organizationId: ctx.orgId, type: 'lead.updated', leadSourceId: ctx.sourceId });
    } catch (e) {
      await this.sliceFailed(ctx, e);
    } finally {
      await this.release(ctx);
    }
  }

  private nextReconcileAt(): Date {
    return new Date(Date.now() + this.config.get('AIRTABLE_RECONCILE_INTERVAL_MS', { infer: true }));
  }

  private async sliceFailed(ctx: Ctx, e: unknown): Promise<void> {
    const err = e instanceof AirtableApiError ? e : null;
    const transient = err?.transient ?? false;
    const wait = err?.retryAfterMs ?? (transient ? 60_000 : 300_000);
    await this.prisma.leadSource.updateMany({
      where: { id: ctx.sourceId, orgId: ctx.orgId },
      data: {
        lastFailureAt: new Date(),
        syncFailures: { increment: 1 },
        remoteErrorCode: (err?.kind ?? 'SYNC_FAILED').slice(0, 50),
        remoteErrorMessage: (e as Error).message?.slice(0, 500) ?? null,
        syncNextAt: new Date(Date.now() + wait),
      },
    });
    this.logger.error(`${ctx.logTag}: slice failed: ${(e as Error).message}`);
  }

  // -------------------------------------------------------------------------
  // EstatePulse -> Airtable
  // -------------------------------------------------------------------------

  /**
   * Writes leads that changed in EstatePulse out to Airtable.
   *
   * A lead already linked to a record is PATCHed, so Airtable columns
   * EstatePulse knows nothing about are left exactly as they are. A lead with
   * no record yet gets one created, and its record id is stored as the tracking
   * key — after which that lead and that record are the same thing forever.
   */
  async pushChanges(ctx: Ctx, counts: SyncCounts, deadline = Date.now() + SLICE_MS): Promise<boolean> {
    const { fields, mappings } = await this.schemaAndMapping(ctx);
    if (!mappings.length) return false;
    const fieldsById = new Map(fields.map((f) => [f.id, f]));
    // The same context the pull side builds its rows with, so a record Airtable
    // hands back after a write fingerprints exactly as it will when read again.
    //
    // Built from the INBOUND mappings alone. The write-back columns below are
    // one-way, and a row built as if they were readable would not match what a
    // later read produces.
    const rctx = rowContext(fields, mappings);

    // What the owner asked EstatePulse to report back, as outbound mappings.
    // toAirtableFields treats them like any other column — it only ever looks at
    // which lead key fills which Airtable field — so the fingerprinting, the
    // read-only type checks and the batching all apply unchanged.
    const writeBack = ctx.config.writeBack.filter((w) => fieldsById.has(w.fieldId));
    const outboundMappings: StoredMapping[] = [
      ...mappings,
      ...writeBack.map((w) => ({ source_field_key: w.fieldId, target_field: w.key, transform: { kind: 'text' as const } })),
    ];
    const wants = new Set(writeBack.map((w) => w.key));

    // Already linked, and the lead has moved since we last wrote it.
    //
    // The predicate is SQL because it compares two columns — leads.updated_at
    // against the tracking row's pushed_at — which the query builder cannot
    // express. Selecting rows that are already in step would not merely waste
    // the slice: the slice is CAPPED, so on a table with more rows than the cap
    // the same in-step rows would be re-read every run and everything past them
    // would never be written at all. Ordering by pushed_at, oldest first, is
    // what makes each slice carry on from where the last one stopped.
    const due = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT r.id FROM sheet_import_rows r
        JOIN leads l ON l.id = r.lead_id
       WHERE r.organization_id = ${ctx.orgId}::uuid
         AND r.lead_source_id = ${ctx.sourceId}::uuid
         AND r.missing_since IS NULL
         AND (r.push_available_at IS NULL OR r.push_available_at <= now())
         AND r.push_attempts < ${MAX_PUSH_ATTEMPTS}
         -- A claim waiting on an unanswered create has no record to write to.
         AND r.row_key NOT LIKE ${PENDING_PREFIX + '%'}
         AND (
           r.pushed_at IS NULL            -- never written
           OR r.pushed_hash IS NULL       -- fingerprint cleared on purpose: a conflict settled our way
           OR l.updated_at > r.pushed_at  -- the lead changed after we last wrote it
         )
       ORDER BY r.pushed_at ASC NULLS FIRST, r.id
       LIMIT ${PUSH_PER_SLICE}`;
    const linked = due.length
      ? await this.prisma.sheetImportRow.findMany({
          where: { id: { in: due.map((d) => d.id) }, orgId: ctx.orgId },
          select: { id: true, rowKey: true, pushedHash: true, pushedAt: true, lead: { select: LEAD_FIELDS } },
        })
      : [];


    // Call history, only when something chosen actually needs it. A transcript
    // runs to thousands of characters, and loading one per lead for a column
    // nobody asked for would be paid on every slice.
    const activity = await this.callActivity(ctx, wants, linked.map((r) => r.lead?.id));

    const updates: { rowId: string; recordId: string; fields: Record<string, unknown>; hash: string }[] = [];
    for (const row of linked) {
      if (!row.lead) continue;
      const recordId = recordIdOf(row.lead.externalLeadId, row.rowKey);
      if (!recordId) continue;
      const out = toAirtableFields(this.outboundFor(row.lead, activity), outboundMappings, fieldsById);
      const hash = outboundHash(out);
      // Nothing we own has changed since the last write: do not touch Airtable.
      if (hash === row.pushedHash) continue;
      updates.push({ rowId: row.id, recordId, fields: out, hash });
    }

    // Leads this Airtable table has never seen.
    //
    // The exclusion is "already owned by an Airtable table", not "has any
    // tracking row at all". A lead that arrived through a sheet, a CRM or a file
    // already carries a tracking row, so the broader test silently skipped every
    // one of those while letting form and webhook leads through — an arbitrary
    // split that had nothing to do with Airtable.
    const unlinked = await this.prisma.lead.findMany({
      where: {
        orgId: ctx.orgId,
        // The owner's choice. Publishing a customer's whole lead list into their
        // base is not something to assume, so the narrow scope is the default.
        ...(ctx.config.exportScope === 'all_leads' ? {} : { leadSourceId: ctx.sourceId }),
        sheetImportRows: { none: { leadSource: { provider: LeadSourceProvider.AIRTABLE } } },
      },
      select: LEAD_FIELDS,
      take: PUSH_PER_SLICE,
    });

    // Claims whose create Airtable refused, backed off far enough to try again.
    // They are not "unlinked" any more — the claim is exactly what stops a blind
    // second create — so they have to be collected deliberately.
    const retryable = await this.prisma.sheetImportRow.findMany({
      where: {
        orgId: ctx.orgId,
        leadSourceId: ctx.sourceId,
        rowKey: { startsWith: PENDING_PREFIX },
        pushAvailableAt: { lte: new Date() },
        pushAttempts: { lt: MAX_PUSH_ATTEMPTS },
      },
      select: { lead: { select: LEAD_FIELDS } },
      take: PUSH_PER_SLICE,
    });
    const creatable = [...unlinked, ...retryable.flatMap((r) => (r.lead ? [r.lead] : []))];

    // The leads about to be created need their history too, into the same map.
    for (const [leadId, a] of await this.callActivity(ctx, wants, creatable.map((l) => l.id))) activity.set(leadId, a);


    // A full slice means there is very likely more behind it, so the caller
    // comes straight back instead of waiting out the reconcile interval.
    const backlog = due.length >= PUSH_PER_SLICE || creatable.length >= PUSH_PER_SLICE;
    if (!updates.length && !creatable.length) return backlog;
    if (!(await this.stillLive(ctx))) return backlog;

    if (updates.length) {
      await this.withBatches(ctx, updates, deadline, async (batch) => {
        const written = await this.connections.withAccessToken(ctx.orgId, ctx.credentialId, (token) =>
          this.client.updateRecords(token, ctx.baseId, ctx.tableId, batch.map((u) => ({ id: u.recordId, fields: u.fields }))),
        );
        // Airtable returns each record as it now stands, Airtable's own
        // normalisation included. Fingerprinting THAT is what the pull side
        // will compute when this write comes back round, so recording it as
        // contentHash is what makes the echo recognisable.
        const settled = new Map(written.map((r) => [r.id, buildAirtableRow(r, 1, rctx).hash]));
        const now = new Date();
        for (const u of batch) {
          const echo = settled.get(u.recordId);
          await this.prisma.sheetImportRow.updateMany({
            where: { id: u.rowId, orgId: ctx.orgId },
            data: {
              pushedHash: u.hash,
              // Absent only if Airtable did not return a record we sent; the
              // next read then settles it as an ordinary change, once.
              ...(echo ? { contentHash: echo } : {}),
              pushedAt: now,
              pushAttempts: 0,
              pushAvailableAt: null,
              pushError: null,
              pushErrorCode: null,
            },
          });
        }
        counts.pushedUpdated += batch.length;
      });
    }

    if (creatable.length && (await this.stillLive(ctx))) {
      const payload = creatable.map((lead) => {
        const out = toAirtableFields(this.outboundFor(lead, activity), outboundMappings, fieldsById);
        return { rowId: undefined as string | undefined, lead, fields: out, hash: outboundHash(out) };
      });
      await this.withBatches(ctx, payload, deadline, async (batch) => {
        // Claim every lead BEFORE Airtable is asked to create anything.
        //
        // Airtable has no idempotency key, so when the answer to a create is
        // lost there is no way to ask whether it landed. A lead that still
        // looked unlinked would simply be written again on the next slice,
        // leaving a duplicate record in somebody else's base. The claim makes
        // that second write impossible: the worst case becomes a row that says,
        // visibly, that it does not know.
        const claimedAt = new Date();
        const claims = new Map<string, string>();
        for (const b of batch) {
          const key = pendingRowKey(b.lead.id);
          const row = await this.prisma.sheetImportRow.upsert({
            where: { leadSourceId_rowKey: { leadSourceId: ctx.sourceId, rowKey: key } },
            create: {
              orgId: ctx.orgId,
              leadSourceId: ctx.sourceId,
              rowKey: key,
              leadId: b.lead.id,
              contentHash: '',
              rowNumber: 1,
              reviewState: ReviewState.approved,
              reviewedAt: claimedAt,
              pushedHash: b.hash,
              // Carried from the start and cleared the moment Airtable answers,
              // so a claim that never settles shows up as a failed write rather
              // than sitting silently.
              pushErrorCode: 'AIRTABLE_CREATE_UNCONFIRMED',
              pushError: 'EstatePulse asked Airtable to create this record and got no answer. It may or may not exist in Airtable.',
            },
            update: { pushedHash: b.hash },
            select: { id: true },
          });
          claims.set(b.lead.id, row.id);
        }

        let created;
        try {
          created = await this.connections.withAccessToken(ctx.orgId, ctx.credentialId, (token) =>
            this.client.createRecords(token, ctx.baseId, ctx.tableId, batch.map((b) => ({ fields: b.fields }))),
          );
        } catch (e) {
          // A refusal is an answer: Airtable created nothing. The claim still
          // stays, because releasing it would make the lead look unlinked again
          // and the next slice would try at once, forever, with nothing slowing
          // it down. It backs off like any other failed write instead, and is
          // parked for a person after MAX_PUSH_ATTEMPTS.
          //
          // An UNANSWERED create is the one case left alone: nobody knows
          // whether that record exists, so it is never retried on its own.
          if (e instanceof AirtableApiError && e.kind !== 'UNAVAILABLE') {
            await this.pushFailed(
              ctx,
              [...claims.values()].map((rowId) => ({ rowId })),
              e,
            );
          }
          throw e;
        }

        if (created.length !== batch.length) {
          // Airtable answered with a different number of records than we sent.
          // Which record belongs to which lead is a guess now, and a wrong guess
          // writes one person's details into another person's record. Every
          // claim is left standing instead, which is the safe half of unsure.
          this.logger.error(
            `${ctx.logTag}: Airtable returned ${created.length} records for ${batch.length} creates; claims left unsettled`,
          );
          return;
        }

        // Airtable returns created records in the order they were sent.
        const now = new Date();
        for (const [i, record] of created.entries()) {
          const made = batch[i];
          const claimId = made && claims.get(made.lead.id);
          if (!made || !claimId) continue;
          await this.prisma.sheetImportRow.updateMany({
            where: { id: claimId, orgId: ctx.orgId },
            data: {
              // The claim becomes the real row: same row, settled key.
              rowKey: airtableRowKey(record.id),
              pushErrorCode: null,
              pushError: null,
              // The record as Airtable now holds it, in the pull side's own
              // fingerprint space. NOT made.hash: that is the outbound hash, a
              // different function over different data, which no read can match.
              // Empty only when the written record does not build into a usable
              // row at all; the next read then fills it in as an ordinary
              // change, once. contentHash is NOT NULL, so there is no third state.
              contentHash: buildAirtableRow(record, 1, rctx).hash ?? '',
              pushedHash: made.hash,
              pushedAt: now,
            },
          });
          await this.prisma.lead.updateMany({ where: { id: made.lead.id, orgId: ctx.orgId }, data: { externalLeadId: record.id } });
        }
        counts.pushedCreated += created.length;
      });
    }
    return backlog;
  }

  /**
   * Runs one write batch at a time, so a failure parks only the records in it.
   * A rate limit or an outage backs the whole slice off; anything else is that
   * batch's own problem and the rest of the table carries on.
   */
  private async withBatches<T extends { rowId?: string }>(
    ctx: Ctx,
    items: T[],
    deadline: number,
    run: (batch: T[]) => Promise<void>,
  ): Promise<void> {
    const size = 10; // Airtable's documented maximum for one write.
    for (let i = 0; i < items.length; i += size) {
      if (Date.now() > deadline || !(await this.stillLive(ctx))) return;
      const batch = items.slice(i, i + size);
      try {
        await run(batch);
      } catch (e) {
        if (e instanceof AirtableApiError && (e.transient || e.kind === 'REAUTH' || e.kind === 'UNAUTHORIZED')) throw e;
        await this.pushFailed(ctx, batch, e);
      }
    }
  }

  /** A batch Airtable refused: parked with its reason, retried later, never silently dropped. */
  private async pushFailed<T extends { rowId?: string }>(ctx: Ctx, batch: T[], e: unknown): Promise<void> {
    const err = e instanceof AirtableApiError ? e : null;
    const ids = batch.map((b) => b.rowId).filter((id): id is string => Boolean(id));
    if (!ids.length) {
      this.logger.warn(`${ctx.logTag}: creating ${batch.length} record(s) failed: ${(e as Error).message}`);
      return;
    }
    const rows = await this.prisma.sheetImportRow.findMany({ where: { id: { in: ids }, orgId: ctx.orgId }, select: { id: true, pushAttempts: true } });
    for (const row of rows) {
      const attempts = row.pushAttempts + 1;
      await this.prisma.sheetImportRow.updateMany({
        where: { id: row.id, orgId: ctx.orgId },
        data: {
          pushAttempts: attempts,
          // Bounded exponential backoff. At MAX_PUSH_ATTEMPTS the row stops being
          // picked up and stays visible as a failure for someone to retry by hand.
          pushAvailableAt: attempts >= MAX_PUSH_ATTEMPTS ? null : new Date(Date.now() + PUSH_BACKOFF_MS * 2 ** (attempts - 1)),
          pushErrorCode: (err?.kind ?? 'PUSH_FAILED').slice(0, 50),
          pushError: ((e as Error).message ?? 'Airtable refused the write').slice(0, 500),
        },
      });
    }
    this.logger.warn(`${ctx.logTag}: ${rows.length} record(s) failed to push: ${(e as Error).message}`);
  }

  // -------------------------------------------------------------------------
  // Airtable -> EstatePulse
  // -------------------------------------------------------------------------

  /**
   * Applies records that changed in Airtable.
   *
   * A record whose fingerprint matches what we last wrote is our own echo: it
   * is recorded as seen and goes no further, which is what stops a loop. A real
   * change is merged field by field against the values we last accepted; a
   * field that moved on both sides is a conflict and is left for the owner
   * rather than guessed at, because Airtable publishes no reliable
   * last-modified time to order the two edits by.
   */
  async applyRecords(ctx: Ctx, records: AirtableRecord[], counts: SyncCounts): Promise<void> {
    const { fields, mappings } = await this.schemaAndMapping(ctx);
    if (!mappings.length || !records.length) return;
    const rctx = rowContext(fields, mappings);

    const rows: BuiltRow[] = [];
    const keys = records.map((r) => airtableRowKey(r.id));
    const tracked = await this.prisma.sheetImportRow.findMany({
      where: { orgId: ctx.orgId, leadSourceId: ctx.sourceId, rowKey: { in: keys } },
      select: { id: true, rowKey: true, pushedAt: true, contentHash: true, leadId: true },
    });
    const byKey = new Map(tracked.map((t) => [t.rowKey, t]));

    for (const [i, record] of records.entries()) {
      const built = buildAirtableRow(record, i + 1, rctx);
      counts.pulled += 1;
      if (built.blank || built.issue || !built.key) continue;
      const known = byKey.get(built.key);
      // The record still holds exactly what we last recorded for it, so there is
      // nothing to apply. Where that record was last written BY us, this is our
      // own write coming back round — the echo — and dropping it here is what
      // stops a write/notify/write loop.
      //
      // Both sides of this comparison come from buildRow, so they fingerprint
      // the same thing the same way. pushedHash is deliberately NOT compared
      // here: it fingerprints the cells we sent OUT, keyed by Airtable field id,
      // which is a different function over different data and could never match
      // a row built from a read. It answers a different question — "have this
      // lead's values moved since the last push?" — and pushChanges is the only
      // place that asks it.
      // leadId matters as much as the fingerprint: an owner can delete a lead,
      // and its tracking row stays behind pointing at nothing. Skipping the
      // record as unchanged would strand it forever, because the import engine
      // knows how to relink an orphaned row to a new lead but never gets asked.
      if (known && known.leadId && known.contentHash === built.hash) {
        if (known.pushedAt) counts.echoes += 1;
        continue;
      }
      rows.push(built);
    }

    if (!rows.length) return;
    const stats = new RunStats(0);
    // The shared engine does the merge, the duplicate checks and the review
    // queue, and approves the records that arrived with nothing to decide.
    await this.importer.importRows(ctx.orgId, ctx.sourceId, ctx.defaultConsent as never, rows, stats, AIRTABLE_IMPORT_REVIEW_REASON, AUTO_APPROVE, {
      scopeToRows: true,
    });
    counts.applied += stats.inserted + stats.updated;
    counts.approved += stats.autoApproved;
    counts.conflicts += stats.flagged;
    if (stats.flagged > 0) await this.settleConflicts(ctx, rows, counts);
  }

  /**
   * An Airtable edit to a lead that is already past review.
   *
   * The import engine flags any such change instead of writing it, which is the
   * right default for a spreadsheet an owner is still curating. For a table
   * being SYNCED it is not: the owner asked for edits to flow, so the change is
   * applied here, immediately, through the very path the Import Review buttons
   * use — recorded as the system deciding, so the history still shows it.
   */
  private async settleConflicts(ctx: Ctx, rows: BuiltRow[], counts: SyncCounts): Promise<void> {
    const flagged = await this.prisma.sheetImportRow.findMany({
      where: {
        orgId: ctx.orgId,
        leadSourceId: ctx.sourceId,
        changedAfterReviewAt: { not: null },
        rowKey: { in: rows.map((r) => r.key!).filter(Boolean) },
      },
      select: { id: true },
    });
    if (!flagged.length) return;

    await this.reviews.resolve({ organizationId: ctx.orgId, userId: null }, flagged.map((f) => f.id), 'apply');
    counts.conflicts -= flagged.length;
    this.logger.log(`${ctx.logTag}: ${flagged.length} Airtable edit(s) applied to leads already past review`);
  }

  /**
   * Reads what changed in Airtable since last time.
   *
   * The incremental path is the webhook payload feed: Airtable's notification
   * carries no data, so the cursor is what actually moves the sync forward, and
   * every call also buys the webhook another 7 days of life. The payload says
   * only WHICH records changed — the records are then re-read, so a stale or
   * partial payload can never blank a lead.
   *
   * Without a webhook (webhook:manage not granted, or Airtable refused it) the
   * table is re-read in full, which is the Google Sheets behaviour: only rows
   * whose fingerprint moved are written, so a full read is cheap to apply even
   * when it is expensive to fetch.
   */
  async pullChanges(ctx: Ctx, counts: SyncCounts, source: { externalWebhookId: string | null; syncRemoteVersion: string | null }): Promise<boolean> {
    if (source.externalWebhookId) {
      const read = await this.pullByWebhook(ctx, counts, source.externalWebhookId, source.syncRemoteVersion);
      // A cursor Airtable no longer knows (the week of retention lapsed) falls back to a full read.
      if (read.usable) return read.more;
    }
    await this.reconcile(ctx, counts);
    return false;
  }

  /**
   * `usable` is false when the cursor could not be used and a full read is
   * needed instead. `more` says the feed still had payloads waiting when this
   * slice ran out of room, so the next run should not sit out the reconcile
   * interval before collecting them.
   */
  private async pullByWebhook(
    ctx: Ctx,
    counts: SyncCounts,
    webhookId: string,
    cursorText: string | null,
  ): Promise<{ usable: boolean; more: boolean }> {
    let cursor = cursorText ? Number(cursorText) : null;
    if (cursor !== null && !Number.isFinite(cursor)) cursor = null;

    const changed = new Set<string>();
    const destroyed = new Set<string>();
    let more = false;
    try {
      for (let page = 0; page < MAX_PAYLOAD_PAGES; page++) {
        const got = await this.connections.withAccessToken(ctx.orgId, ctx.credentialId, (token) =>
          this.client.webhookPayloads(token, ctx.baseId, webhookId, cursor),
        );
        for (const payload of got.payloads) {
          const table = payload.changedTablesById?.[ctx.tableId];
          if (!table) continue;
          for (const id of Object.keys(table.createdRecordsById ?? {})) changed.add(id);
          for (const id of Object.keys(table.changedRecordsById ?? {})) changed.add(id);
          for (const id of table.destroyedRecordIds ?? []) {
            destroyed.add(id);
            changed.delete(id);
          }
        }
        cursor = got.cursor;
        more = got.mightHaveMore;
        if (!more) break;
      }
    } catch (e) {
      if (e instanceof AirtableApiError && (e.kind === 'NOT_FOUND' || e.kind === 'BAD_REQUEST')) {
        this.logger.warn(`${ctx.logTag}: webhook ${webhookId} unusable (${e.message}); falling back to a full read`);
        await this.prisma.leadSource.updateMany({
          where: { id: ctx.sourceId, orgId: ctx.orgId },
          data: { externalWebhookId: null, remoteState: 'ERROR', syncRemoteVersion: null },
        });
        return { usable: false, more: false };
      }
      throw e;
    }

    if (changed.size) {
      const ids = [...changed];
      for (let i = 0; i < ids.length; i += READ_CHUNK) {
        if (!(await this.stillLive(ctx))) return { usable: true, more: true };
        const read = await this.connections.withAccessToken(ctx.orgId, ctx.credentialId, (token) =>
          this.client.readRecords(token, ctx.baseId, ctx.tableId, ids.slice(i, i + READ_CHUNK)),
        );
        await this.applyRecords(ctx, read.found, counts);
        // Changed, then deleted before we read it.
        await this.markMissing(ctx, read.missing, counts);
      }
    }
    if (destroyed.size) await this.markMissing(ctx, [...destroyed], counts);

    // The cursor moves only once its payloads have been applied, so a crash
    // mid-slice re-reads them rather than skipping them.
    await this.prisma.leadSource.updateMany({
      where: { id: ctx.sourceId, orgId: ctx.orgId },
      data: { syncRemoteVersion: cursor === null ? null : String(cursor).slice(0, 64), remoteState: 'INSTALLED' },
    });
    return { usable: true, more };
  }

  /** A complete re-read: the safety net for a lost webhook, and the only path without one. */
  private async reconcile(ctx: Ctx, counts: SyncCounts): Promise<void> {
    const seen = new Set<string>();
    let offset: string | null = null;
    for (let page = 0; page < MAX_RECONCILE_PAGES; page++) {
      if (!(await this.stillLive(ctx))) return;
      const got: { records: AirtableRecord[]; offset: string | null } = await this.connections.withAccessToken(ctx.orgId, ctx.credentialId, (token) =>
        this.client.listRecords(token, ctx.baseId, ctx.tableId, { offset }),
      );
      got.records.forEach((r) => seen.add(r.id));
      await this.applyRecords(ctx, got.records, counts);
      offset = got.offset;
      if (!offset) break;
    }
    if (!offset) await this.markVanished(ctx, seen, counts);
  }

  /** Tracked records that a complete read did not return have been deleted in Airtable. */
  private async markVanished(ctx: Ctx, seenRecordIds: Set<string>, counts: SyncCounts): Promise<void> {
    const keys = [...seenRecordIds].map(airtableRowKey);
    const gone = await this.prisma.sheetImportRow.updateMany({
      where: {
        orgId: ctx.orgId,
        leadSourceId: ctx.sourceId,
        missingSince: null,
        // A claim names no record yet, so a read that does not return it proves
        // nothing. Marking it missing would be a guess dressed up as a fact.
        rowKey: { notIn: keys.length ? keys : ['-'], not: { startsWith: PENDING_PREFIX } },
      },
      data: { missingSince: new Date(), pushAvailableAt: null },
    });
    counts.missing += gone.count;
  }

  /**
   * Makes sure the table is being watched, and keeps the watch alive.
   *
   * Airtable expires an OAuth-made webhook after 7 days, so every run refreshes
   * it. Without webhook:manage this does nothing and the sync reconciles
   * instead — a narrower grant loses the speed, not the feature.
   */
  async ensureWebhook(ctx: Ctx, source: { externalWebhookId: string | null }): Promise<void> {
    const permissions = await this.connections.permissions(ctx.orgId, ctx.credentialId);
    if (!permissions.manageWebhooks) return;

    if (source.externalWebhookId) {
      try {
        await this.connections.withAccessToken(ctx.orgId, ctx.credentialId, (token) =>
          this.client.refreshWebhook(token, ctx.baseId, source.externalWebhookId!),
        );
        return;
      } catch (e) {
        if (!(e instanceof AirtableApiError && e.kind === 'NOT_FOUND')) throw e;
        // Expired past recovery, or deleted in Airtable: make a new one.
      }
    }

    const url = this.notificationUrl();
    const made = await this.connections.withAccessToken(ctx.orgId, ctx.credentialId, (token) =>
      this.client.createWebhook(token, ctx.baseId, ctx.tableId, url),
    );
    await this.prisma.leadSource.updateMany({
      where: { id: ctx.sourceId, orgId: ctx.orgId },
      data: {
        externalWebhookId: made.id,
        remoteState: 'INSTALLED',
        remoteSyncedAt: new Date(),
        // Returned once and never again, so it is sealed now or lost.
        signingSecretEnc: this.connections.sealForSource(ctx.orgId, ctx.sourceId, made.macSecretBase64),
        // A new webhook starts the payload feed from the beginning.
        syncRemoteVersion: null,
      },
    });
    this.logger.log(`${ctx.logTag}: watching table ${ctx.tableId} (webhook ${made.id})`);
  }

  private notificationUrl(): string | null {
    const api = this.config.get('PUBLIC_API_URL', { infer: true }) as string | undefined;
    if (!api) return null;
    const base = api.replace(/\/+$/, '');
    // Airtable will not call an http:// URL, and localhost is unreachable from it.
    if (!base.startsWith('https://')) return null;
    return `${base}/ingest/v1/airtable/webhook`;
  }

  /** Records no longer in Airtable: marked, never deleted. */
  async markMissing(ctx: Ctx, recordIds: string[], counts: SyncCounts): Promise<void> {
    if (!recordIds.length) return;
    const changed = await this.prisma.sheetImportRow.updateMany({
      where: { orgId: ctx.orgId, leadSourceId: ctx.sourceId, rowKey: { in: recordIds.map(airtableRowKey) }, missingSince: null },
      data: { missingSince: new Date(), pushAvailableAt: null },
    });
    counts.missing += changed.count;
  }

  // -------------------------------------------------------------------------
  // Shared
  // -------------------------------------------------------------------------

  /**
   * The lead as Airtable should see it: the mapped contact details, plus
   * whatever the owner asked EstatePulse to report back about how the lead is
   * going. Keys a write-back column does not name are simply never read.
   */
  private outboundFor(lead: LeadRow, activity: Map<string, CallActivity>): OutboundLead {
    const a = activity.get(lead.id);
    return {
      ...outboundLead(lead),
      ...writeBackValues({
        status: lead.status,
        temperature: lead.temperature,
        score: lead.score === null ? null : Number(lead.score),
        buyingIntent: lead.buyingIntent,
        timeline: lead.timeline,
        financingStatus: lead.financingStatus,
        followUpReason: lead.followUpReason,
        lostReason: lead.lostReason,
        aiSummary: lead.aiSummary,
        memorySummary: lead.memorySummary,
        callsMade: a?.callsMade ?? 0,
        firstContactAt: lead.firstContactAt,
        firstResponseAt: lead.firstResponseAt,
        lastContactAt: lead.lastContactAt,
        callbackAt: lead.callbackAt,
        textBackAt: lead.textBackAt,
        lastCall: a?.lastCall ?? null,
        dncStatus: lead.dncStatus,
        needsReview: lead.needsReview,
        automationPaused: lead.automationPaused,
        consentStatus: lead.consentStatus,
        assignedTo: lead.assignedTo ? `${lead.assignedTo.firstName} ${lead.assignedTo.lastName}`.trim() : null,
        link: this.leadUrl(lead.id),
      } satisfies WriteBackSource),
    };
  }

  /**
   * The same link the "lead assigned" email sends, so both land in the same
   * place: the leads list with that lead's dossier already open (AppContext
   * reads `?lead=` and then drops it, so closing it does not reopen it).
   *
   * Null without an APP_URL — a link to nowhere is worse than no link.
   */
  private leadUrl(leadId: string): string | null {
    const app = (this.config.get('APP_URL', { infer: true }) as string | undefined)?.replace(/\/+$/, '');
    return app ? `${app}/leads?lead=${encodeURIComponent(leadId)}` : null;
  }

  /**
   * The last call and the call count for these leads — one query, and only when
   * a chosen column needs it. The transcript is left out unless it was asked
   * for, because it alone is big enough to be worth not carrying.
   */
  private async callActivity(ctx: Ctx, wants: Set<string>, leadIds: (string | undefined)[]): Promise<Map<string, CallActivity>> {
    const out = new Map<string, CallActivity>();
    const ids = [...new Set(leadIds.filter((id): id is string => Boolean(id)))];
    const needsLastCall = [...wants].some((k) => k.startsWith('ep_last_call'));
    if (!ids.length || (!needsLastCall && !wants.has('ep_calls_made'))) return out;

    const counts = await this.prisma.call.groupBy({
      by: ['leadId'],
      where: { orgId: ctx.orgId, leadId: { in: ids } },
      _count: { _all: true },
    });
    for (const c of counts) if (c.leadId) out.set(c.leadId, { callsMade: c._count._all, lastCall: null });

    if (needsLastCall) {
      const wantsTranscript = wants.has('ep_last_call_transcript');
      const latest = await this.prisma.$queryRaw<
        { lead_id: string; ended_at: Date | null; disposition: string | null; duration_seconds: number | null; ai_summary: string | null; recording_url: string | null; transcript: string | null }[]
      >`
        SELECT DISTINCT ON (c.lead_id)
               c.lead_id, c.ended_at, c.disposition::text AS disposition, c.duration_seconds,
               c.ai_summary, c.recording_url,
               CASE WHEN ${wantsTranscript} THEN c.transcript ELSE NULL END AS transcript
          FROM calls c
         WHERE c.organization_id = ${ctx.orgId}::uuid AND c.lead_id = ANY(${ids}::uuid[])
         ORDER BY c.lead_id, c.created_at DESC`;
      for (const r of latest) {
        const existing = out.get(r.lead_id) ?? { callsMade: 0, lastCall: null };
        existing.lastCall = {
          endedAt: r.ended_at,
          disposition: r.disposition,
          durationSeconds: r.duration_seconds,
          aiSummary: r.ai_summary,
          recordingUrl: r.recording_url,
          transcript: r.transcript,
        };
        out.set(r.lead_id, existing);
      }
    }
    return out;
  }

  private async schemaAndMapping(ctx: Ctx): Promise<{ fields: AirtableField[]; mappings: StoredMapping[] }> {
    const [schema, rows] = await Promise.all([
      this.connections.withAccessToken(ctx.orgId, ctx.credentialId, (token) => this.client.baseSchema(token, ctx.baseId)),
      this.prisma.leadSourceFieldMapping.findMany({
        where: { orgId: ctx.orgId, leadSourceId: ctx.sourceId, isActive: true },
        select: { sourceFieldKey: true, targetField: true, transform: true },
      }),
    ]);
    const table = schema.find((t) => t.id === ctx.tableId);
    return {
      fields: table?.fields ?? [],
      mappings: rows.map((r) => ({ source_field_key: r.sourceFieldKey, target_field: r.targetField, transform: r.transform as StoredMapping['transform'] })),
    };
  }

  private record(ctx: Ctx, action: string, counts: SyncCounts) {
    return this.audit.record({
      orgId: ctx.orgId,
      actorType: 'system',
      action,
      entityType: 'lead_source',
      entityId: ctx.sourceId,
      payload: { ...counts, direction: ctx.config.direction },
    });
  }
}

const LEAD_FIELDS = {
  id: true,
  externalLeadId: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  location: true,
  minBudget: true,
  maxBudget: true,
  bedrooms: true,
  motivation: true,
  updatedAt: true,
  // Everything the write-back catalogue can report. All of it is on the lead
  // row already, so asking for it costs nothing beyond the columns themselves;
  // only the call history below needs a query of its own.
  status: true,
  temperature: true,
  score: true,
  buyingIntent: true,
  timeline: true,
  financingStatus: true,
  followUpReason: true,
  lostReason: true,
  aiSummary: true,
  memorySummary: true,
  firstContactAt: true,
  firstResponseAt: true,
  lastContactAt: true,
  callbackAt: true,
  textBackAt: true,
  dncStatus: true,
  needsReview: true,
  automationPaused: true,
  consentStatus: true,
  assignedTo: { select: { firstName: true, lastName: true } },
} as const;

/** The last call and how many there have been, for the leads being written. */
interface CallActivity {
  callsMade: number;
  lastCall: WriteBackSource['lastCall'];
}

type LeadRow = Prisma.LeadGetPayload<{ select: typeof LEAD_FIELDS }>;

/** The lead, in the canonical keys a mapping names. */
function outboundLead(lead: LeadRow): OutboundLead {
  return {
    first_name: lead.firstName,
    last_name: lead.lastName,
    email: lead.email,
    phone: lead.phone,
    location: lead.location,
    min_budget: lead.minBudget ? Number(lead.minBudget) : null,
    max_budget: lead.maxBudget ? Number(lead.maxBudget) : null,
    bedrooms: lead.bedrooms,
    motivation: lead.motivation,
  };
}

/**
 * The Airtable record a tracking row belongs to. The lead's externalLeadId is
 * used only when it really is this row's record — a lead linked from another
 * source can carry that source's id, and must never have someone else's record
 * written to.
 */
export function recordIdOf(externalLeadId: string | null, rowKey: string): string | null {
  if (!externalLeadId) return null;
  return airtableRowKey(externalLeadId) === rowKey ? externalLeadId : null;
}
