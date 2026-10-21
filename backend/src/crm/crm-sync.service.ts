import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CrmSyncRunKind, CrmSyncRunStatus, IntegrationStatus, Prisma, type ConsentStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AuditService } from '@/audit/audit.service';
import { httpError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import type { IntegrationEnv } from '@/common/utils/interface';
import { EventsBus } from '@/events/events.bus';
import { RunStats, SheetImportService, type ChangedValues } from '@/google-sheets/sheet-import.service';
import { approveTrackingRows } from '@/google-sheets/approval';
import { applyCrmChanges } from '@/google-sheets/sheet-review.service';
import { PHONE_UNPARSED_REASON, type BuiltRow, type LeadFields } from '@/google-sheets/sheet-rows';
import { CrmConnectionsService, integrationProviderOf, sourceProviderOf, type SessionIdentity } from './crm-connections.service';
import {
  CRM_CORE_FIELDS,
  buildCrmRow,
  crmImportReviewReason,
  crmMerge,
  crmRowKey,
  crmValuesOf,
  type CrmContact,
  type CrmValues,
} from './crm-records';
import { CrmRegistry } from './crm-registry';
import { CrmApiError, type CrmAdapter } from './types';

/**
 * Keeps each connected CRM's contacts in step with the organization's leads.
 *
 * Three kinds of work, all done for one connection at a time under a lease on
 * its lead_sources row (FOR UPDATE SKIP LOCKED; a lease older than five
 * minutes is presumed dead and taken over), so they never interleave for the
 * same connection, whatever the number of API instances:
 *
 *  1. Webhook deliveries (ingest_events, provider 'HUBSPOT'). An event only
 *     says which contacts may have changed; those are re-read from the CRM as
 *     they are NOW, so duplicates and out-of-order delivery converge.
 *  2. Runs (crm_sync_runs): the initial import and later complete re-reads, a
 *     page at a time, cursor and counts saved after every page. When the read
 *     completes, tracked contacts it did not see are marked missing.
 *  3. Reconciliation: contacts modified since the last good sync, every
 *     CRM_RECONCILE_INTERVAL_MS — what catches a webhook the CRM gave up on.
 *
 * Every page of contacts is written the same way (persistContacts): a tracked
 * contact updates its lead when nobody here changed the CRM's fields, otherwise
 * the change waits in Import Review; an untracked contact whose email matches
 * exactly one lead is linked to it; anything new is inserted paused, awaiting
 * the owner's approval.
 */

/** A slice of work holds a connection for at most this long, so organizations take turns. */
const SLICE_MS = 25_000;
/** A lease older than this is presumed dead (process killed mid-slice) and may be taken over. */
const LEASE_STUCK_SECONDS = 300;
/** Deliveries handled per slice. */
const EVENTS_PER_SLICE = 500;
/** A delivery that keeps failing for a reason other than auth or rate limiting is dead-lettered after this many tries. */
const MAX_EVENT_ATTEMPTS = 10;
/** Ids per batch read (the CRM's batch limit). */
const READ_BATCH = 100;
/** Search is re-queried this far back, so a contact modified at the edge of the last window is never skipped. */
const RECONCILE_OVERLAP_MS = 5 * 60 * 1000;
/** HubSpot search: 5 requests a second per account. */
const SEARCH_SPACING_MS = 250;
/** A run that fails this many times in a row stops and says so. */
const MAX_RUN_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 3_600_000;
const EVENT_BACKOFF_BASE_MS = 30_000;

export interface CrmCounts {
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  linked: number;
  conflicts: number;
  duplicates: number;
  skipped: number;
  failed: number;
  missing: number;
}

const zero = (): CrmCounts => ({ fetched: 0, created: 0, updated: 0, unchanged: 0, linked: 0, conflicts: 0, duplicates: 0, skipped: 0, failed: 0, missing: 0 });
const eventful = (c: CrmCounts) => c.created + c.updated + c.linked + c.conflicts + c.missing > 0;

/** A refusal with a stable code and an owner-readable message. */
class SyncError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Claimed {
  id: string;
  organization_id: string;
  provider: string;
  integration_id: string;
  default_consent_status: ConsentStatus;
  sync_remote_version: string | null;
  sync_next_at: Date | null;
  sync_failures: number;
}

interface Ctx {
  adapter: CrmAdapter;
  organizationId: string;
  sourceId: string;
  credentialId: string;
  defaultConsent: ConsentStatus;
  region: string;
  importReason: string;
  /** What the logs show: names and ids only. */
  logTag: string;
}

export interface RunDTO {
  id: string;
  kind: string;
  status: string;
  counts: CrmCounts;
  pages: number;
  attempts: number;
  nextAttemptAt: Date | null;
  error: { code: string; message: string | null } | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

const RUN_SELECT = {
  id: true,
  kind: true,
  status: true,
  pages: true,
  fetched: true,
  created: true,
  updated: true,
  unchanged: true,
  linked: true,
  conflicts: true,
  duplicates: true,
  skipped: true,
  failed: true,
  missing: true,
  attempts: true,
  availableAt: true,
  errorCode: true,
  errorMessage: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
} satisfies Prisma.CrmSyncRunSelect;

type RunRow = Prisma.CrmSyncRunGetPayload<{ select: typeof RUN_SELECT }>;

const ACTIVE_RUN = [CrmSyncRunStatus.queued, CrmSyncRunStatus.running];

type CoreField = (typeof CRM_CORE_FIELDS)[number];

/** A lead's CRM-relevant columns, in the column names the shared merge and apply code use. */
interface LeadRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  normalized_email: string | null;
  email_valid: boolean;
  phone: string | null;
  normalized_phone: string | null;
  phone_valid: boolean;
  custom_fields: unknown;
}

const LEAD_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  normalizedEmail: true,
  emailValid: true,
  phone: true,
  normalizedPhone: true,
  phoneValid: true,
  customFields: true,
} satisfies Prisma.LeadSelect;

function leadRow(l: Prisma.LeadGetPayload<{ select: typeof LEAD_SELECT }>): LeadRow {
  return {
    id: l.id,
    first_name: l.firstName,
    last_name: l.lastName,
    email: l.email,
    normalized_email: l.normalizedEmail,
    email_valid: l.emailValid,
    phone: l.phone,
    normalized_phone: l.normalizedPhone,
    phone_valid: l.phoneValid,
    custom_fields: l.customFields,
  };
}

/**
 * The values a merge decided on, shaped for applyCrmChanges: the CRM's value
 * for each field in `fields`, null (= keep the lead's) for the rest, and the
 * CRM's own custom fields, which always follow it.
 */
function mergedChange(lead: LeadRow, row: BuiltRow, fields: CoreField[], prefix: string): ChangedValues {
  const incoming = row.lead!;
  const take = (f: CoreField) => fields.includes(f);
  const merged: LeadFields = {
    ...incoming,
    first_name: take('first_name') ? incoming.first_name : null,
    last_name: take('last_name') ? incoming.last_name : null,
    email: take('email') ? incoming.email : null,
    normalized_email: take('email') ? incoming.normalized_email : lead.normalized_email,
    email_valid: take('email') ? incoming.email_valid : lead.email_valid,
    phone: take('phone') ? incoming.phone : null,
    normalized_phone: take('phone') ? incoming.normalized_phone : lead.normalized_phone,
    phone_valid: take('phone') ? incoming.phone_valid : lead.phone_valid,
  };
  // Only a reason about something that was actually written.
  const reasons = take('phone') && incoming.phone && !incoming.normalized_phone ? [PHONE_UNPARSED_REASON] : [];
  return { hash: row.hash!, lead: merged, externalId: row.externalId ?? null, dnc: false, reviewReasons: reasons, crmPrefix: prefix };
}

@Injectable()
export class CrmSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('CrmSync');
  private readonly instanceId = `crm-${randomUUID()}`;
  private draining: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: CrmConnectionsService,
    private readonly registry: CrmRegistry,
    private readonly importer: SheetImportService,
    private readonly events: EventsBus,
    private readonly audit: AuditService,
    private readonly config: ConfigService<IntegrationEnv, true>,
  ) {}

  private get reconcileIntervalMs(): number {
    return this.config.get('CRM_RECONCILE_INTERVAL_MS', { infer: true });
  }

  /**
   * Polls for work every CRM_POLL_MS (0 = never; owner actions and webhooks
   * still nudge it). Polling is what resumes a run after a restart, retries
   * after a backoff, and runs scheduled reconciliation.
   */
  onModuleInit(): void {
    const active = this.registry.active();
    if (active.length === 0) {
      this.logger.log('CRM sync disabled (set HUBSPOT_ENABLED=true)');
      return;
    }
    const pollMs = this.config.get('CRM_POLL_MS', { infer: true });
    if (pollMs <= 0) {
      this.logger.log('periodic CRM sync off (CRM_POLL_MS=0); owner actions and webhooks still run it');
      return;
    }
    this.logger.log(`checking ${active.map((a) => a.provider).join(', ')} connections for work every ${pollMs}ms`);
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

  /** Every connection with due work, one slice at a time, until none is left. */
  drain(): Promise<void> {
    if (this.registry.active().length === 0) return Promise.resolve();
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
      this.logger.error(`CRM sync loop failed: ${(e as Error).message}`);
    }
  }

  /**
   * A connection with due work and a free (or dead) lease: queued deliveries, a
   * runnable run, or reconciliation due. Only live connections. Claiming and
   * releasing bump updated_at, so the connection worked least recently goes
   * first and one big import cannot starve everyone else.
   */
  private async claim(): Promise<Claimed | null> {
    const providers = this.registry.active().map((a) => a.provider);
    const rows = await this.prisma.$queryRaw<Claimed[]>`
      WITH due AS (
        SELECT s.id FROM lead_sources s
          JOIN integrations c ON c.id = s.integration_id AND c.organization_id = s.organization_id
         WHERE s.provider::text = ANY(${providers}::text[]) AND s.connection_method = 'SYNC'
           AND s.archived_at IS NULL AND s.is_active
           AND c.status = 'active' AND c.revoked_at IS NULL
           AND (s.sync_locked_at IS NULL OR s.sync_locked_at < now() - make_interval(secs => ${LEASE_STUCK_SECONDS}))
           AND (
             EXISTS (SELECT 1 FROM crm_sync_runs r
                      WHERE r.lead_source_id = s.id AND r.status IN ('queued', 'running') AND r.available_at <= now())
             OR EXISTS (SELECT 1 FROM ingest_events e
                         WHERE e.lead_source_id = s.id AND e.queue_state = 'PENDING' AND e.available_at <= now())
             -- Deliveries a dead worker left mid-processing (see processEvents).
             OR EXISTS (SELECT 1 FROM ingest_events e
                         WHERE e.lead_source_id = s.id AND e.queue_state = 'PROCESSING'
                           AND e.locked_at < now() - make_interval(secs => ${LEASE_STUCK_SECONDS}))
             OR s.sync_next_at <= now()
           )
         ORDER BY s.updated_at, s.id
         FOR UPDATE OF s SKIP LOCKED
         LIMIT 1
      )
      UPDATE lead_sources s
         SET sync_locked_at = now(), sync_locked_by = ${this.instanceId}, updated_at = now()
        FROM due
       WHERE s.id = due.id
      RETURNING s.id, s.organization_id, s.provider::text AS provider, s.integration_id, s.default_consent_status,
                s.sync_remote_version, s.sync_next_at, s.sync_failures`;
    return rows[0] ?? null;
  }

  /** Extend the lease; false when this instance no longer holds it. */
  private async heartbeat(c: { sourceId: string; organizationId: string }): Promise<boolean> {
    const n = await this.prisma.$executeRaw`
      UPDATE lead_sources SET sync_locked_at = now()
       WHERE id = ${c.sourceId}::uuid AND organization_id = ${c.organizationId}::uuid AND sync_locked_by = ${this.instanceId}`;
    return n === 1;
  }

  private async release(c: { sourceId: string; organizationId: string }): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE lead_sources SET sync_locked_at = NULL, sync_locked_by = NULL, updated_at = now()
       WHERE id = ${c.sourceId}::uuid AND organization_id = ${c.organizationId}::uuid AND sync_locked_by = ${this.instanceId}`;
  }

  /** Re-checked before every write: a disconnect mid-slice stops the slice. */
  private async stillLive(ctx: Ctx): Promise<boolean> {
    const n = await this.prisma.integration.count({
      where: { id: ctx.credentialId, orgId: ctx.organizationId, status: IntegrationStatus.active, revokedAt: null },
    });
    return n === 1 && (await this.heartbeat(ctx));
  }

  private async slice(c: Claimed): Promise<void> {
    const adapter = this.registry.byProvider(c.provider);
    const settings = await this.prisma.organizationSetting.findUnique({ where: { orgId: c.organization_id }, select: { defaultRegion: true } });
    const ctx: Ctx = {
      adapter: adapter!,
      organizationId: c.organization_id,
      sourceId: c.id,
      credentialId: c.integration_id,
      defaultConsent: c.default_consent_status,
      region: settings?.defaultRegion ?? 'US',
      importReason: adapter ? crmImportReviewReason(adapter.label) : '',
      logTag: `${c.provider} source ${c.id}`,
    };
    const deadline = Date.now() + SLICE_MS;
    try {
      if (!adapter) return;
      if (!(await this.processEvents(ctx))) return;
      const run = await this.prisma.crmSyncRun.findFirst({
        where: { orgId: c.organization_id, leadSourceId: c.id, status: { in: ACTIVE_RUN }, availableAt: { lte: new Date() } },
        select: { id: true, status: true, cursor: true, startedAt: true, attempts: true },
      });
      if (run) await this.advanceRun(ctx, run, deadline);
      else if (c.sync_next_at && c.sync_next_at <= new Date()) await this.reconcile(ctx, c, deadline);
    } catch (e) {
      this.logger.error(`${ctx.logTag}: slice failed: ${(e as Error)?.stack ?? String(e)}`);
    } finally {
      await this.release(ctx).catch((e) => this.logger.error(`${ctx.logTag}: lease not released: ${(e as Error).message}`));
    }
  }

  // -------------------------------------------------------------------------
  // 1. Webhook deliveries
  // -------------------------------------------------------------------------

  /** False when the deliveries could not be processed (they are back in the queue); the slice then stops. */
  private async processEvents(ctx: Ctx): Promise<boolean> {
    // A worker that died between claiming deliveries and recording their outcome left them PROCESSING.
    // This one now holds the connection, so anything older than a lease is nobody's: back in the queue.
    await this.prisma.$executeRaw`
      UPDATE ingest_events
         SET queue_state = 'PENDING', locked_by = NULL, locked_at = NULL
       WHERE lead_source_id = ${ctx.sourceId}::uuid AND organization_id = ${ctx.organizationId}::uuid
         AND provider::text = ${ctx.adapter.provider} AND queue_state = 'PROCESSING'
         AND locked_at < now() - make_interval(secs => ${LEASE_STUCK_SECONDS})`;
    const claimed = await this.prisma.$queryRaw<{ id: string; payload: { contactIds?: string[] }; attempts: number }[]>`
      WITH c AS (
        SELECT id FROM ingest_events
         WHERE lead_source_id = ${ctx.sourceId}::uuid AND organization_id = ${ctx.organizationId}::uuid
           AND provider::text = ${ctx.adapter.provider} AND queue_state = 'PENDING' AND available_at <= now()
         ORDER BY available_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT ${EVENTS_PER_SLICE}
      )
      UPDATE ingest_events e
         SET queue_state = 'PROCESSING', locked_by = ${this.instanceId}, locked_at = now(), attempts = e.attempts + 1
        FROM c WHERE e.id = c.id
      RETURNING e.id, e.payload, e.attempts`;
    if (claimed.length === 0) return true;

    const ids = [...new Set(claimed.flatMap((e) => (Array.isArray(e.payload?.contactIds) ? e.payload.contactIds.map(String) : [])))];
    const counts = zero();
    const started = Date.now();
    try {
      for (let i = 0; i < ids.length; i += READ_BATCH) {
        const chunk = ids.slice(i, i + READ_BATCH);
        const read = await this.connections.withAccessToken(ctx.adapter, ctx.organizationId, ctx.credentialId, (t) => ctx.adapter.readContacts(t, chunk));
        if (!(await this.stillLive(ctx))) throw new SyncError('DISCONNECTED', 'The connection was disconnected.');
        counts.fetched += read.found.length;
        await this.persistContacts(ctx, read.found, counts);
        // Not returned: deleted, archived or merged away in the CRM.
        counts.missing += await this.markMissing(ctx, read.missing);
      }
    } catch (e) {
      await this.eventsFailed(ctx, claimed, e);
      return false;
    }

    await this.prisma.$executeRaw`
      UPDATE ingest_events
         SET queue_state = 'DONE', outcome = 'PROCESSED',
             outcome_reason = ${ids.length ? 'contacts_refreshed' : 'not_acted_on'},
             processed_at = now(), processing_ms = ${Date.now() - started}, locked_by = NULL, locked_at = NULL, error_message = NULL
       WHERE id = ANY(${claimed.map((e) => e.id)}::uuid[]) AND queue_state = 'PROCESSING' AND locked_by = ${this.instanceId}`;
    await this.prisma.leadSource.update({ where: { id: ctx.sourceId }, data: { lastSuccessAt: new Date() } });
    this.logger.log(`${ctx.logTag}: ${claimed.length} webhook event(s), ${ids.length} contact(s) re-read — ${summary(counts)}`);
    if (eventful(counts)) await this.record(ctx, 'crm_sync.webhook_applied', { events: claimed.length, ...counts }, Date.now() - started);
    if (counts.created > 0) this.events.publish({ organizationId: ctx.organizationId, type: 'lead.created', leadSourceId: ctx.sourceId });
    return true;
  }

  /**
   * Deliveries that could not be processed, in one statement: a connection that
   * needs reauthorization puts them back as they were; a rate limit or outage
   * backs off for as long as that lasts (a deletion or merge has no other way
   * in); anything else backs off and is dead-lettered after MAX_EVENT_ATTEMPTS.
   */
  private async eventsFailed(ctx: Ctx, claimed: { id: string; attempts: number }[], e: unknown): Promise<void> {
    const { code, message } = describe(ctx.adapter, e);
    const reauth = e instanceof CrmApiError && e.kind === 'REAUTH';
    const transient = e instanceof CrmApiError && e.transient;
    const retryAfter = e instanceof CrmApiError ? e.retryAfterMs : null;
    const final = !reauth && !transient;
    if (code === 'INTERNAL') this.logger.error(`${ctx.logTag}: webhook processing failed: ${(e as Error)?.stack ?? String(e)}`);
    else this.logger.warn(`${ctx.logTag}: ${claimed.length} webhook event(s) not processed: ${code}`);
    await this.prisma.$executeRaw`
      UPDATE ingest_events
         SET queue_state = CASE WHEN ${final} AND attempts >= ${MAX_EVENT_ATTEMPTS} THEN 'DEAD_LETTER'::ingest_queue_state ELSE 'PENDING'::ingest_queue_state END,
             outcome = CASE WHEN ${final} AND attempts >= ${MAX_EVENT_ATTEMPTS} THEN 'ERROR'::ingest_outcome END,
             outcome_reason = ${code.slice(0, 100)}, error_message = ${message.slice(0, 300)},
             available_at = CASE
               WHEN ${reauth} THEN now()
               WHEN ${retryAfter}::double precision IS NOT NULL THEN now() + ${retryAfter}::double precision * interval '1 millisecond'
               ELSE now() + LEAST(${EVENT_BACKOFF_BASE_MS} * power(2, GREATEST(attempts, 1) - 1), ${BACKOFF_MAX_MS}) * interval '1 millisecond'
             END,
             attempts = CASE WHEN ${reauth} THEN GREATEST(attempts - 1, 0) ELSE attempts END,
             locked_by = NULL, locked_at = NULL
       WHERE id = ANY(${claimed.map((c) => c.id)}::uuid[]) AND queue_state = 'PROCESSING' AND locked_by = ${this.instanceId}`;
  }

  // -------------------------------------------------------------------------
  // 2. Runs
  // -------------------------------------------------------------------------

  private async advanceRun(
    ctx: Ctx,
    run: { id: string; status: CrmSyncRunStatus; cursor: string | null; startedAt: Date | null; attempts: number },
    deadline: number,
  ): Promise<void> {
    let startedAt = run.startedAt;
    if (run.status === CrmSyncRunStatus.queued) {
      // The DATABASE's clock, like every last_seen_at it will be compared with when the run completes.
      const started = await this.prisma.$queryRaw<{ started_at: Date }[]>`
        UPDATE crm_sync_runs SET status = 'running', started_at = now(), heartbeat_at = now(), updated_at = now()
         WHERE id = ${run.id}::uuid AND organization_id = ${ctx.organizationId}::uuid AND status = 'queued'
        RETURNING started_at`;
      if (started.length === 0) return;
      startedAt = started[0].started_at;
      this.logger.log(`${ctx.logTag}: run ${run.id} started`);
    }
    let cursor = run.cursor;
    try {
      while (Date.now() < deadline && !this.stopped) {
        const page = await this.connections.withAccessToken(ctx.adapter, ctx.organizationId, ctx.credentialId, (t) => ctx.adapter.listContacts(t, cursor));
        if (!(await this.stillLive(ctx))) return;
        const counts = zero();
        counts.fetched = page.contacts.length;
        await this.persistContacts(ctx, page.contacts, counts);
        cursor = page.nextCursor;
        const saved = await this.prisma.crmSyncRun.updateMany({
          where: { id: run.id, orgId: ctx.organizationId, status: CrmSyncRunStatus.running },
          data: {
            cursor,
            pages: { increment: 1 },
            fetched: { increment: counts.fetched },
            created: { increment: counts.created },
            updated: { increment: counts.updated },
            unchanged: { increment: counts.unchanged },
            linked: { increment: counts.linked },
            conflicts: { increment: counts.conflicts },
            duplicates: { increment: counts.duplicates },
            skipped: { increment: counts.skipped },
            failed: { increment: counts.failed },
            attempts: 0,
            heartbeatAt: new Date(),
          },
        });
        // Cancelled meanwhile (a disconnect): stop without touching it again.
        if (saved.count === 0) return;
        if (counts.created > 0) this.events.publish({ organizationId: ctx.organizationId, type: 'lead.created', leadSourceId: ctx.sourceId });
        if (!cursor) {
          await this.completeRun(ctx, run.id, startedAt!);
          return;
        }
      }
    } catch (e) {
      await this.runFailed(ctx, run, e);
    }
  }

  /**
   * The read is complete, so a tracked contact not seen since the run started
   * is no longer in the CRM: marked missing, never deleted. Then the run's
   * start becomes the watermark for reconciliation.
   */
  private async completeRun(ctx: Ctx, runId: string, startedAt: Date): Promise<void> {
    const missing = await this.prisma.$executeRaw`
      UPDATE sheet_import_rows SET missing_since = now(), updated_at = now()
       WHERE organization_id = ${ctx.organizationId}::uuid AND lead_source_id = ${ctx.sourceId}::uuid
         AND missing_since IS NULL AND (last_seen_at IS NULL OR last_seen_at < ${startedAt.toISOString()}::timestamptz)`;
    const finished = await this.prisma.crmSyncRun.updateMany({
      where: { id: runId, orgId: ctx.organizationId, status: CrmSyncRunStatus.running },
      data: { status: CrmSyncRunStatus.succeeded, finishedAt: new Date(), missing, cursor: null },
    });
    // Cancelled meanwhile (a disconnect): its outcome stands.
    if (finished.count === 0) return;
    const done = (await this.prisma.crmSyncRun.findFirst({ where: { id: runId, orgId: ctx.organizationId }, select: RUN_SELECT }))!;
    await this.prisma.leadSource.update({
      where: { id: ctx.sourceId },
      data: {
        lastSuccessAt: new Date(),
        remoteSyncedAt: new Date(),
        // Reconciliation starts from when this read began: anything modified after that may have been read before it changed.
        syncRemoteVersion: String(startedAt.getTime()),
        syncNextAt: new Date(Date.now() + this.reconcileIntervalMs),
        syncFailures: 0,
        remoteErrorCode: null,
        remoteErrorMessage: null,
      },
    });
    const dto = toRunDTO(done);
    await this.record(ctx, 'crm_sync.completed', { runId, kind: done.kind, pages: done.pages, ...dto.counts }, Date.now() - startedAt.getTime());
    this.logger.log(`${ctx.logTag}: run ${runId} complete — ${summary(dto.counts)}`);
  }

  private async runFailed(ctx: Ctx, run: { id: string; attempts: number }, e: unknown): Promise<void> {
    const { code, message } = describe(ctx.adapter, e);
    const transient = (e instanceof CrmApiError && e.transient) || (!(e instanceof CrmApiError) && !(e instanceof SyncError));
    const attempts = run.attempts + 1;
    const final = !transient || attempts >= MAX_RUN_ATTEMPTS;
    if (code === 'INTERNAL') this.logger.error(`${ctx.logTag}: run ${run.id} failed: ${(e as Error)?.stack ?? String(e)}`);
    const wait = e instanceof CrmApiError && e.retryAfterMs ? e.retryAfterMs : Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
    const n = await this.prisma.crmSyncRun.updateMany({
      where: { id: run.id, orgId: ctx.organizationId, status: { in: ACTIVE_RUN } },
      data: final
        ? {
            status: CrmSyncRunStatus.failed,
            finishedAt: new Date(),
            attempts,
            errorCode: transient ? 'RETRIES_EXHAUSTED' : code,
            errorMessage: message.slice(0, 500),
          }
        : { attempts, availableAt: new Date(Date.now() + jitter(wait)), errorCode: code, errorMessage: message.slice(0, 500) },
    });
    if (n.count === 0) return;
    await this.prisma.leadSource.update({
      where: { id: ctx.sourceId },
      data: { lastFailureAt: new Date(), remoteErrorCode: code, remoteErrorMessage: message.slice(0, 300) },
    });
    this.logger.warn(`${ctx.logTag}: run ${run.id} ${final ? 'failed' : `will retry (attempt ${attempts})`}: ${code}`);
    if (final) await this.record(ctx, 'crm_sync.failed', { runId: run.id, code, attempts, rateLimited: code.endsWith('RATE_LIMITED') }, 0);
  }

  // -------------------------------------------------------------------------
  // 3. Reconciliation
  // -------------------------------------------------------------------------

  /**
   * Contacts modified since the watermark (minus an overlap), oldest first. The
   * watermark only moves to a point every contact before which has been
   * written, so a stop part-way repeats work but never skips it.
   */
  private async reconcile(ctx: Ctx, c: Claimed, deadline: number): Promise<void> {
    const watermark = Number(c.sync_remote_version);
    if (!Number.isFinite(watermark) || watermark <= 0) return;
    const startedAt = Date.now();
    const since = watermark - RECONCILE_OVERLAP_MS;
    const counts = zero();
    let cursor: string | null = null;
    let newest = watermark;
    try {
      for (;;) {
        const page = await this.connections.withAccessToken(ctx.adapter, ctx.organizationId, ctx.credentialId, (t) =>
          ctx.adapter.changedContactsSince(t, since, cursor),
        );
        if (!(await this.stillLive(ctx))) return;
        counts.fetched += page.contacts.length;
        await this.persistContacts(ctx, page.contacts, counts);
        for (const contact of page.contacts) newest = Math.max(newest, contact.modifiedAt);

        if (page.capped || (page.nextCursor && Date.now() >= deadline)) {
          // Stopped part-way: carry on from the newest contact written, but never in place,
          // or a burst larger than one search window would loop.
          if (newest <= watermark) {
            await this.queueFullRun(ctx, 'The CRM changed more contacts at once than incremental sync can page through; a full re-read was queued.');
            await this.saveReconcile(ctx, { next: new Date(Date.now() + this.reconcileIntervalMs) });
          } else {
            await this.saveReconcile(ctx, { watermark: newest, next: new Date() });
          }
          break;
        }
        if (!page.nextCursor) {
          await this.saveReconcile(ctx, { watermark: startedAt, next: new Date(Date.now() + this.reconcileIntervalMs), success: true });
          break;
        }
        cursor = page.nextCursor;
        await new Promise((r) => setTimeout(r, SEARCH_SPACING_MS));
      }
    } catch (e) {
      const { code, message } = describe(ctx.adapter, e);
      const failures = c.sync_failures + 1;
      const wait = e instanceof CrmApiError && e.retryAfterMs ? e.retryAfterMs : Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
      this.logger.warn(`${ctx.logTag}: reconciliation failed: ${code}`);
      await this.prisma.leadSource.update({
        where: { id: ctx.sourceId },
        data: {
          syncFailures: failures,
          syncNextAt: new Date(Date.now() + jitter(wait)),
          lastFailureAt: new Date(),
          remoteErrorCode: code,
          remoteErrorMessage: message.slice(0, 300),
        },
      });
      return;
    }
    this.logger.log(`${ctx.logTag}: reconciled — ${summary(counts)}`);
    if (eventful(counts)) await this.record(ctx, 'crm_sync.reconciled', { ...counts }, Date.now() - startedAt);
    if (counts.created > 0) this.events.publish({ organizationId: ctx.organizationId, type: 'lead.created', leadSourceId: ctx.sourceId });
  }

  private async saveReconcile(ctx: Ctx, p: { watermark?: number; next: Date; success?: boolean }): Promise<void> {
    await this.prisma.leadSource.update({
      where: { id: ctx.sourceId },
      data: {
        ...(p.watermark !== undefined ? { syncRemoteVersion: String(p.watermark) } : {}),
        syncNextAt: p.next,
        syncFailures: 0,
        ...(p.success ? { lastSuccessAt: new Date(), remoteErrorCode: null, remoteErrorMessage: null } : {}),
      },
    });
  }

  private async queueFullRun(ctx: Ctx, why: string): Promise<void> {
    await this.prisma.crmSyncRun.createMany({
      data: [{ orgId: ctx.organizationId, leadSourceId: ctx.sourceId, provider: sourceProviderOf(ctx.adapter), kind: CrmSyncRunKind.full }],
      skipDuplicates: true,
    });
    this.logger.warn(`${ctx.logTag}: ${why}`);
  }

  // -------------------------------------------------------------------------
  // Writing a page of contacts
  // -------------------------------------------------------------------------

  /**
   * One page, a fixed handful of statements whatever its size. `counts` is added to.
   *
   *  - Untracked, and exactly one lead in the organization has the same valid
   *    email: LINKED to that lead. Its empty fields are filled from the CRM;
   *    where both have a value and they differ, the difference waits for the
   *    owner in Import Review. Never a second lead.
   *  - Untracked otherwise: a new lead, paused, awaiting approval. Phone alone
   *    never links: shared office and family numbers would merge strangers.
   *  - Any contact still awaiting approval that is complete and unflagged is
   *    then approved on its own (approveCleanContacts).
   *  - Tracked and approved, changed in the CRM: a field-level three-way merge
   *    against what the CRM said last time (crmMerge).
   *  - Pending drafts, rejected rows, and a lead deleted out of band: the
   *    import engine's existing rules.
   */
  async persistContacts(ctx: Ctx, contacts: CrmContact[], counts: CrmCounts): Promise<void> {
    const { adapter, organizationId: orgId, sourceId } = ctx;
    const prefix = adapter.label.customPrefix;
    const byKey = new Map<string, BuiltRow>();
    for (const contact of contacts) {
      const row = buildCrmRow(adapter.provider, adapter.label, contact, ctx.region);
      byKey.set(row.key!, row);
    }
    const all = [...byKey.values()];
    const seenKeys = all.map((r) => r.key!);
    const rows = all.filter((r) => {
      if (r.issue) counts.skipped += 1;
      return !r.issue;
    });

    if (rows.length) {
      const trackedRows = await this.prisma.sheetImportRow.findMany({
        where: { orgId, leadSourceId: sourceId, rowKey: { in: rows.map((r) => r.key!) } },
        select: {
          id: true,
          rowKey: true,
          reviewState: true,
          contentHash: true,
          leadId: true,
          changedAfterReviewAt: true,
          syncedValues: true,
          lead: { select: LEAD_SELECT },
        },
      });
      const trackedByKey = new Map(trackedRows.map((t) => [t.rowKey, { ...t, lead: t.lead ? leadRow(t.lead) : null }]));

      // Who these contacts already are in this organization: to link an untracked contact, and to know whether a new phone or email clashes.
      const untracked = rows.filter((r) => !trackedByKey.has(r.key!));
      const changed = rows.filter((r) => {
        const t = trackedByKey.get(r.key!);
        return t?.leadId && t.reviewState === 'approved' && !t.changedAfterReviewAt && t.contentHash !== r.hash;
      });
      const candidates = [...untracked, ...changed];
      const emails = [...new Set(candidates.map((r) => r.lead!.normalized_email).filter((e): e is string => !!e))];
      const phones = [...new Set(candidates.map((r) => r.lead!.normalized_phone).filter((p): p is string => !!p))];
      const externalIds = untracked.map((r) => r.externalId!).filter(Boolean);
      const others =
        emails.length || phones.length || externalIds.length
          ? (
              await this.prisma.lead.findMany({
                where: {
                  orgId,
                  OR: [
                    ...(emails.length ? [{ normalizedEmail: { in: emails } }] : []),
                    ...(phones.length ? [{ normalizedPhone: { in: phones } }] : []),
                    ...(externalIds.length ? [{ leadSourceId: sourceId, externalLeadId: { in: externalIds } }] : []),
                  ],
                },
                select: { ...LEAD_SELECT, dncStatus: true, leadSourceId: true, externalLeadId: true, reviewReasons: true },
              })
            ).map((l) => ({ ...leadRow(l), leadSourceId: l.leadSourceId, externalLeadId: l.externalLeadId, reviewReasons: l.reviewReasons }))
          : [];
      // A lead this connection already tracks (for any contact) is never linked to a second one.
      const alreadyTracked = new Set(
        others.length
          ? (
              await this.prisma.sheetImportRow.findMany({
                where: { orgId, leadSourceId: sourceId, leadId: { in: others.map((o) => o.id) } },
                select: { leadId: true },
              })
            ).map((t) => t.leadId)
          : [],
      );
      /** The new phone or email would belong to another lead too: the owner decides, never the sync. */
      const clashes = (r: BuiltRow, selfId: string, fields: string[]) =>
        others.some(
          (o) =>
            o.id !== selfId &&
            ((fields.includes('phone') && r.lead!.normalized_phone && o.normalized_phone === r.lead!.normalized_phone) ||
              (fields.includes('email') && r.lead!.normalized_email && o.normalized_email === r.lead!.normalized_email)),
        );

      const links: Prisma.SheetImportRowCreateManyInput[] = [];
      const linkAudit: { leadId: string; match: string; held: boolean }[] = [];
      const apply: { trackingId: string | null; key: string; lead: LeadRow; row: BuiltRow; fields: CoreField[] }[] = [];
      const claimedLeads = new Set<string>();

      // --- link untracked contacts to leads that already exist ---
      for (const r of untracked) {
        const free = others.filter((o) => !alreadyTracked.has(o.id) && !claimedLeads.has(o.id));
        // Recovery: this connection created the lead (it carries the record id) but its tracking row is gone.
        let lead = free.find((o) => o.leadSourceId === sourceId && o.externalLeadId === r.externalId);
        let match = 'external_id';
        if (!lead && r.lead!.normalized_email) {
          const byEmail = free.filter((o) => o.normalized_email === r.lead!.normalized_email);
          if (byEmail.length === 1) [lead, match] = [byEmail[0], 'email'];
        }
        if (!lead) continue;
        claimedLeads.add(lead.id);

        const awaiting = lead.leadSourceId === sourceId && lead.reviewReasons.includes(ctx.importReason);
        const merge = crmMerge(null, crmValuesOf(lead, prefix), crmValuesOf(r.lead!, prefix));
        const held = !awaiting && (merge.conflicts.length > 0 || clashes(r, lead.id, merge.apply));
        links.push({
          orgId,
          leadSourceId: sourceId,
          rowKey: r.key!,
          leadId: lead.id,
          // A draft is refreshed by the engine; a held link is flagged by it (an empty hash never matches),
          // so the existing lead is never overwritten by being linked.
          contentHash: awaiting || held ? '' : r.hash!,
          rowNumber: 1,
          reviewState: awaiting ? 'pending' : 'approved',
          reviewedAt: awaiting ? null : new Date(),
          lastSeenAt: new Date(),
        });
        linkAudit.push({ leadId: lead.id, match, held });
        if (!awaiting && !held) apply.push({ trackingId: null, key: r.key!, lead, row: r, fields: merge.apply });
      }

      // --- tracked, approved, changed in the CRM: the three-way merge ---
      for (const r of changed) {
        const t = trackedByKey.get(r.key!)!;
        if (!t.lead) continue;
        const base = (t.syncedValues as unknown as CrmValues | null) ?? null;
        const merge = crmMerge(base, crmValuesOf(t.lead, prefix), crmValuesOf(r.lead!, prefix));
        // Without a base there is nothing to tell "changed here" from; the engine flags it.
        if (!base || merge.conflicts.length > 0 || clashes(r, t.lead.id, merge.apply)) continue;
        apply.push({ trackingId: t.id, key: r.key!, lead: t.lead, row: r, fields: merge.apply });
      }

      if (links.length || apply.length) {
        // One batch transaction: links, applied values, moved hashes and the audit land together or not at all.
        const statements: Prisma.PrismaPromise<unknown>[] = [];
        if (links.length) statements.push(this.prisma.sheetImportRow.createMany({ data: links }));
        if (apply.length) {
          statements.push(
            applyCrmChanges(
              this.prisma,
              orgId,
              apply.map((a) => ({ lead_id: a.lead.id, changed_values: mergedChange(a.lead, a.row, a.fields, prefix) })),
            ),
          );
          const moved = apply.filter((a) => a.trackingId);
          if (moved.length) {
            const values = moved.map((a) => Prisma.sql`(${a.trackingId}::uuid, ${a.row.hash!}::varchar)`);
            statements.push(this.prisma.$executeRaw`
              UPDATE sheet_import_rows AS r SET content_hash = v.hash, updated_at = now()
                FROM (VALUES ${Prisma.join(values)}) AS v(id, hash)
               WHERE r.id = v.id AND r.organization_id = ${orgId}::uuid AND r.changed_after_review_at IS NULL`);
          }
        }
        if (linkAudit.length) {
          statements.push(
            this.prisma.auditLog.createMany({
              data: linkAudit.map((l) => ({
                orgId,
                actorType: 'system' as const,
                action: 'crm.contact_linked',
                entityType: 'lead',
                entityId: l.leadId,
                payload: { provider: adapter.provider, leadSourceId: sourceId, match: l.match, differencesHeldForReview: l.held },
              })),
            }),
          );
        }
        await this.prisma.$transaction(statements);
        counts.linked += links.length;
        counts.updated += apply.filter((a) => a.trackingId && a.fields.length).length;
      }

      // --- everything else through the shared import engine ---
      const applied = new Set(apply.map((a) => a.key));
      const engineRows = rows.filter((r) => !applied.has(r.key!));
      if (engineRows.length) await this.writeThroughEngine(ctx, engineRows, counts);

      // --- complete contacts skip Import Review, as a sheet's clean rows do ---
      await this.approveCleanContacts(ctx, rows.map((r) => r.key!));

      // The CRM values each record now stands at: the base of the next merge. Only where they were
      // accepted (applied, imported, unchanged); a held change keeps its old hash, so its old base too.
      const synced = rows.map((r) => Prisma.sql`(${r.key!}::varchar, ${r.hash!}::varchar, ${JSON.stringify(crmValuesOf(r.lead!, prefix))}::jsonb)`);
      await this.prisma.$executeRaw`
        UPDATE sheet_import_rows AS t SET synced_values = v.vals
          FROM (VALUES ${Prisma.join(synced)}) AS v(key, hash, vals)
         WHERE t.organization_id = ${orgId}::uuid AND t.lead_source_id = ${sourceId}::uuid
           AND t.row_key = v.key AND t.content_hash = v.hash`;
    }

    // Everything seen in the CRM is present (contacts we refused included), and one that had gone missing is back.
    if (seenKeys.length) {
      await this.prisma.$executeRaw`
        UPDATE sheet_import_rows SET last_seen_at = now(), missing_since = NULL
         WHERE organization_id = ${orgId}::uuid AND lead_source_id = ${sourceId}::uuid AND row_key = ANY(${seenKeys}::varchar[])`;
    }
  }

  /**
   * The engine writes a page in one transaction. When the database refuses it
   * for a reason a retry cannot fix, the page is written again one contact at
   * a time, so one bad record cannot hold back the rest; each is counted failed.
   */
  private async writeThroughEngine(ctx: Ctx, rows: BuiltRow[], counts: CrmCounts): Promise<void> {
    const write = async (batch: BuiltRow[]) => {
      const stats = new RunStats(0);
      await this.importer.importRows(ctx.organizationId, ctx.sourceId, ctx.defaultConsent, batch, stats, ctx.importReason, null, { scopeToRows: true });
      counts.created += stats.inserted;
      counts.updated += stats.updated;
      counts.unchanged += stats.unchanged;
      counts.conflicts += stats.flagged;
      counts.duplicates += stats.possibleDuplicates;
    };
    try {
      await write(rows);
    } catch (e) {
      if (!permanentDataError(e) || rows.length === 1) throw e;
      this.logger.warn(`${ctx.logTag}: a page was refused by the database (${(e as { code?: string }).code}); writing it one contact at a time`);
      for (const row of rows) {
        try {
          await write([row]);
        } catch (one) {
          if (!permanentDataError(one)) throw one;
          counts.failed += 1;
          this.logger.warn(`${ctx.logTag}: contact ${row.externalId} refused by the database (${(one as { code?: string }).code})`);
        }
      }
    }
  }

  /**
   * CRM contacts that already have what a lead needs skip Import Review, as a
   * sheet's clean rows do when it is switched on: see isCleanCrmLead, and no
   * other lead may share the phone or email (a possible duplicate the owner
   * decides). Checked on every sync of a contact still awaiting approval — new,
   * changed or not — so one completed in the CRM moves on by itself; anything
   * else keeps waiting. Approved as the system, so released to outreach like
   * any approved lead.
   */
  private async approveCleanContacts(ctx: Ctx, keys: string[]): Promise<void> {
    const { organizationId: orgId, sourceId } = ctx;
    if (keys.length === 0) return;
    const pending = await this.prisma.sheetImportRow.findMany({
      where: { orgId, leadSourceId: sourceId, rowKey: { in: keys }, reviewState: 'pending', leadId: { not: null } },
      select: {
        id: true,
        lead: { select: { id: true, firstName: true, normalizedEmail: true, normalizedPhone: true, dncStatus: true, reviewReasons: true } },
      },
    });
    const clean = pending.filter((p) => p.lead && isCleanCrmLead(p.lead, ctx.importReason));
    if (clean.length === 0) return;

    const sharing = await this.prisma.lead.findMany({
      where: {
        orgId,
        OR: [
          { normalizedPhone: { in: clean.map((p) => p.lead!.normalizedPhone!) } },
          { normalizedEmail: { in: clean.map((p) => p.lead!.normalizedEmail!) } },
        ],
      },
      select: { id: true, normalizedPhone: true, normalizedEmail: true },
    });
    const rowIds = clean
      .filter(({ lead }) =>
        !sharing.some((o) => o.id !== lead!.id && (o.normalizedPhone === lead!.normalizedPhone || o.normalizedEmail === lead!.normalizedEmail)),
      )
      .map((p) => p.id);
    if (rowIds.length === 0) return;

    const result = await this.prisma.$transaction((tx) => approveTrackingRows(tx, this.audit, orgId, rowIds, { userId: null }));
    if (result.approved) this.logger.log(`${ctx.logTag}: ${result.approved} complete contact(s) approved (${result.released} released to outreach)`);
  }

  /** Deleted, archived or merged away in the CRM: marked, never deleted. */
  private async markMissing(ctx: Ctx, externalIds: string[]): Promise<number> {
    if (externalIds.length === 0) return 0;
    const keys = externalIds.map((id) => crmRowKey(ctx.adapter.provider, 'contact', id));
    return this.prisma.$executeRaw`
      UPDATE sheet_import_rows SET missing_since = now(), updated_at = now()
       WHERE organization_id = ${ctx.organizationId}::uuid AND lead_source_id = ${ctx.sourceId}::uuid
         AND row_key = ANY(${keys}::varchar[]) AND missing_since IS NULL`;
  }

  // -------------------------------------------------------------------------
  // Owner-facing
  // -------------------------------------------------------------------------

  /**
   * Start a complete re-read now ("Sync now"), or the first import if none has
   * succeeded. Asking while one is queued or running returns that one.
   */
  async requestSync(adapter: CrmAdapter, who: SessionIdentity): Promise<{ run: RunDTO; alreadyActive: boolean }> {
    const { source } = await this.liveSource(adapter, who.organizationId);
    const id = randomUUID();
    const created = await this.prisma.crmSyncRun.createMany({
      data: [
        {
          id,
          orgId: who.organizationId,
          leadSourceId: source.id,
          provider: sourceProviderOf(adapter),
          kind: source.remoteSyncedAt ? CrmSyncRunKind.full : CrmSyncRunKind.initial,
          requestedBy: who.userId,
        },
      ],
      skipDuplicates: true,
    });
    const run = await this.prisma.crmSyncRun.findFirst({
      where: created.count ? { id, orgId: who.organizationId } : { orgId: who.organizationId, leadSourceId: source.id, status: { in: ACTIVE_RUN } },
      select: RUN_SELECT,
    });
    if (!run) throw httpError(409, 'CRM_SYNC_NOT_STARTED', 'The sync could not be started. Try again.');
    if (created.count) {
      await this.audit.record({
        orgId: who.organizationId,
        actorType: 'user',
        actorId: who.userId,
        action: 'crm_sync.requested',
        entityType: 'lead_source',
        entityId: source.id,
        payload: { provider: adapter.provider, runId: id, kind: run.kind },
      });
    }
    this.nudge();
    return { run: toRunDTO(run), alreadyActive: created.count === 0 };
  }

  async runs(adapter: CrmAdapter, organizationId: string, limit = 20): Promise<RunDTO[]> {
    const rows = await this.prisma.crmSyncRun.findMany({
      where: { orgId: organizationId, provider: sourceProviderOf(adapter) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: RUN_SELECT,
    });
    return rows.map(toRunDTO);
  }

  /** One run, only if it belongs to the caller's organization: another's id is simply not found. */
  async run(adapter: CrmAdapter, organizationId: string, runId: string): Promise<RunDTO> {
    const row = await this.prisma.crmSyncRun.findFirst({
      where: { id: runId, orgId: organizationId, provider: sourceProviderOf(adapter) },
      select: RUN_SELECT,
    });
    if (!row) throw httpError(404, 'CRM_RUN_NOT_FOUND', 'No such sync run.');
    return toRunDTO(row);
  }

  /** Everything the integration card shows. Never a token, never a record value. */
  async status(adapter: CrmAdapter, organizationId: string) {
    const credential = await this.prisma.integration.findFirst({
      where: { orgId: organizationId, provider: integrationProviderOf(adapter), revokedAt: null },
      select: { id: true, status: true, accountName: true, accountEmail: true, externalAccountId: true, lastErrorCode: true, createdAt: true },
    });
    const source = await this.prisma.leadSource.findFirst({
      where: {
        orgId: organizationId,
        provider: sourceProviderOf(adapter),
        connectionMethod: 'SYNC',
        archivedAt: null,
        ...(credential ? { integrationId: credential.id } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        externalFormId: true,
        externalFormName: true,
        lastSuccessAt: true,
        lastFailureAt: true,
        lastEventAt: true,
        remoteErrorCode: true,
        remoteErrorMessage: true,
        syncNextAt: true,
      },
    });
    // One after another rather than all at once: a card polled during an import must not compete with it for the pool.
    const runs = source
      ? await this.prisma.crmSyncRun.findMany({ where: { orgId: organizationId, leadSourceId: source.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 2, select: RUN_SELECT })
      : [];
    const counts = source
      ? await this.prisma.sheetImportRow.groupBy({
          by: ['reviewState'],
          where: { orgId: organizationId, leadSourceId: source.id, leadId: { not: null } },
          _count: { _all: true },
        })
      : [];
    const pendingReview = counts.find((c) => c.reviewState === 'pending')?._count._all ?? 0;
    const leads = counts.reduce((n, c) => n + c._count._all, 0);
    const changes = source
      ? await this.prisma.sheetImportRow.count({ where: { orgId: organizationId, leadSourceId: source.id, changedAfterReviewAt: { not: null } } })
      : 0;
    const connectedBy = credential ? await this.connectedBy(organizationId, credential.id) : null;
    const active = runs.find((r) => r.status === CrmSyncRunStatus.queued || r.status === CrmSyncRunStatus.running) ?? null;
    const last = runs.find((r) => r !== active) ?? null;
    const lastFailed = last?.status === CrmSyncRunStatus.failed;

    let status: 'not_connected' | 'connected' | 'reauthorization_required' | 'disconnected' | 'error';
    // A failed run stops being "the" state once a newer one is under way (a reconnect queues one straight away).
    if (credential?.status === IntegrationStatus.active) status = lastFailed && !active ? 'error' : 'connected';
    else if (credential) status = 'reauthorization_required';
    else status = source ? 'disconnected' : 'not_connected';

    return {
      provider: adapter.provider,
      displayName: adapter.label.displayName,
      configured: adapter.isConfigured(),
      status,
      account: credential
        ? {
            id: credential.externalAccountId,
            name: credential.accountName,
            authorizedBy: credential.accountEmail,
            connectedBy,
            connectedAt: credential.createdAt,
          }
        : source
          ? { id: source.externalFormId, name: source.externalFormName, authorizedBy: null, connectedBy: null, connectedAt: null }
          : null,
      sourceId: source?.id ?? null,
      lastSuccessfulSyncAt: source?.lastSuccessAt ?? null,
      lastFailureAt: source?.lastFailureAt ?? null,
      lastWebhookAt: source?.lastEventAt ?? null,
      nextReconcileAt: source?.syncNextAt ?? null,
      lastError:
        credential && credential.status !== IntegrationStatus.active
          ? { code: credential.lastErrorCode ?? 'CRM_REAUTH_REQUIRED', message: `${adapter.label.displayName} access was revoked or has expired. Reconnect to keep syncing.` }
          : source?.remoteErrorCode
            ? { code: source.remoteErrorCode, message: source.remoteErrorMessage }
            : null,
      activeRun: active ? toRunDTO(active) : null,
      lastRun: last ? toRunDTO(last) : null,
      importedLeads: leads,
      pendingReview,
      changesToReview: changes,
    };
  }

  /** Who in EstatePulse connected it, from the audit trail. */
  private async connectedBy(organizationId: string, credentialId: string): Promise<string | null> {
    const entry = await this.prisma.auditLog.findFirst({
      where: { orgId: organizationId, entityType: 'integration', entityId: credentialId, action: { in: ['crm.connected', 'crm.reconnected'] } },
      orderBy: { createdAt: 'desc' },
      select: { actorId: true },
    });
    if (!entry?.actorId) return null;
    const user = await this.prisma.user.findUnique({ where: { id: entry.actorId }, select: { email: true } });
    return user?.email ?? null;
  }

  private async liveSource(adapter: CrmAdapter, organizationId: string) {
    const credential = await this.prisma.integration.findFirst({
      where: { orgId: organizationId, provider: integrationProviderOf(adapter), revokedAt: null },
      select: { id: true, status: true },
    });
    if (!credential) throw httpError(409, 'CRM_NOT_CONNECTED', `${adapter.label.displayName} is not connected.`);
    if (credential.status !== IntegrationStatus.active) {
      throw httpError(409, 'CRM_REAUTH_REQUIRED', `${adapter.label.displayName} access was revoked or has expired. Reconnect it first.`);
    }
    const source = await this.prisma.leadSource.findFirst({
      where: { orgId: organizationId, provider: sourceProviderOf(adapter), integrationId: credential.id, archivedAt: null, isActive: true },
      select: { id: true, remoteSyncedAt: true },
    });
    if (!source) throw httpError(409, 'CRM_NOT_CONNECTED', `${adapter.label.displayName} is not connected.`);
    return { credential, source };
  }

  private async record(ctx: Ctx, action: string, payload: Record<string, unknown>, durationMs: number): Promise<void> {
    await this.audit.record({
      orgId: ctx.organizationId,
      actorType: 'system',
      action,
      entityType: 'lead_source',
      entityId: ctx.sourceId,
      payload: { provider: ctx.adapter.provider, ...payload } as Prisma.InputJsonValue,
      durationMs: Math.max(0, Math.round(durationMs)),
    });
  }
}

export function toRunDTO(r: RunRow): RunDTO {
  const active = r.status === CrmSyncRunStatus.queued || r.status === CrmSyncRunStatus.running;
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    counts: {
      fetched: r.fetched,
      created: r.created,
      updated: r.updated,
      unchanged: r.unchanged,
      linked: r.linked,
      conflicts: r.conflicts,
      duplicates: r.duplicates,
      skipped: r.skipped,
      failed: r.failed,
      missing: r.missing,
    },
    pages: r.pages,
    attempts: r.attempts,
    nextAttemptAt: active && r.attempts > 0 ? r.availableAt : null,
    error: r.errorCode ? { code: r.errorCode, message: r.errorMessage } : null,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
  };
}

/**
 * A CRM lead complete enough to skip Import Review: a first name, a valid email
 * and a dialable phone, not do-not-contact, and nothing flagged on it — its only
 * review reason is the import's own "awaiting approval" (no invalid value, no
 * missing name, no possible duplicate or opt-out found when it was imported).
 */
export function isCleanCrmLead(
  lead: { firstName: string | null; normalizedEmail: string | null; normalizedPhone: string | null; dncStatus: boolean; reviewReasons: string[] },
  importReason: string,
): boolean {
  return (
    Boolean(lead.firstName && lead.normalizedEmail && lead.normalizedPhone) &&
    !lead.dncStatus &&
    lead.reviewReasons.every((r) => r === importReason)
  );
}

/** A database refusal no retry fixes: a value too long, out of range, or otherwise unstorable. */
function permanentDataError(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientValidationError) return true;
  if (!(e instanceof Prisma.PrismaClientKnownRequestError)) return false;
  // Raw statements surface a Postgres data exception (SQLSTATE class 22) as P2010.
  if (e.code === 'P2010') return /^22/.test(String(e.meta?.code ?? ''));
  return ['P2000', 'P2006', 'P2007', 'P2011', 'P2012', 'P2020', 'P2023'].includes(e.code);
}

/** A stable code and a message safe to show the owner. Unknown errors say nothing specific. */
function describe(adapter: CrmAdapter, e: unknown): { code: string; message: string } {
  if (e instanceof SyncError) return { code: e.code, message: e.message };
  if (e instanceof CrmApiError) {
    const name = adapter.label.displayName;
    switch (e.kind) {
      case 'REAUTH':
      case 'UNAUTHORIZED':
        return { code: 'CRM_REAUTH_REQUIRED', message: `${name} access was revoked or has expired. Reconnect ${name} to keep syncing.` };
      case 'RATE_LIMITED':
        return { code: 'CRM_RATE_LIMITED', message: `${name} is rate-limiting this account; the sync will continue automatically.` };
      case 'UNAVAILABLE':
        return { code: 'CRM_UNAVAILABLE', message: `${name} did not respond; the sync will retry automatically.` };
      default:
        return { code: `CRM_${e.kind}`, message: `${name} refused a request: ${e.message}` };
    }
  }
  return { code: 'INTERNAL', message: 'The sync failed unexpectedly. It is safe to run it again.' };
}

function summary(c: CrmCounts): string {
  return `${c.fetched} read, ${c.created} new, ${c.updated} updated, ${c.linked} linked, ${c.conflicts} held for review, ${c.unchanged} unchanged, ${c.skipped} skipped, ${c.missing} missing, ${c.failed} failed`;
}

/** ±20%, so connections that failed together do not retry in lockstep. */
function jitter(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}
