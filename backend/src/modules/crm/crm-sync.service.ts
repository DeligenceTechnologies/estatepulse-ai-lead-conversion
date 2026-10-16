import { HttpException, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { CredentialStatus } from '../../common/domain';
import { newId } from '../../common/ids';
import { PrismaService, TENANT_PRISMA, type GuardedPrisma } from '../../prisma/prisma.service';
import { EventsBus } from '../events/events.bus';
import { RunStats, SheetImportService, SYNC_CONNECTION } from '../google-sheets/sheet-import.service';
import { applyCrmChanges } from '../google-sheets/sheet-review.service';
import { PHONE_UNPARSED_REASON, type BuiltRow, type LeadFields } from '../google-sheets/sheet-rows';
import type { ChangedValues } from '../google-sheets/sheet-import.service';
import { CrmConnectionsService, type SessionIdentity } from './crm-connections.service';
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
 * same connection — whatever the number of API instances:
 *
 *  1. Webhook deliveries (webhook_events, provider 'HUBSPOT'). An event never
 *     carries data we write: it only says which contacts may have changed, and
 *     those are re-read from the CRM as they are NOW. So duplicates,
 *     out-of-order delivery and an event racing the import all converge on the
 *     CRM's current state.
 *  2. Runs (crm_sync_runs): the initial import and later complete re-reads,
 *     a page at a time, with the cursor and counts saved after every page. A
 *     restart resumes from the last saved page. When the read completes,
 *     tracked contacts it did not see are marked missing (never deleted).
 *  3. Reconciliation: contacts modified since the last good sync, by the CRM's
 *     search, every CRM_RECONCILE_INTERVAL_MS — what catches a webhook HubSpot
 *     gave up retrying.
 *
 * Every page of contacts is written the same way (persistContacts):
 *  - a contact already tracked updates its lead: automatically when the lead's
 *    CRM-owned fields are still what was last synced and the new values clash
 *    with nobody; otherwise the change is held for the owner in Import Review;
 *  - an untracked contact whose email matches exactly one existing lead is
 *    LINKED to it rather than duplicated; an ambiguous match (or a phone-only
 *    match) creates a new, paused lead flagged "possible duplicate";
 *  - anything new is inserted PAUSED, awaiting the owner's approval — a bulk
 *    import must never start the outreach engine on its own.
 * The unique (lead_source_id, row_key) index is the backstop under all of it.
 */

/** A slice of work holds a connection for at most this long, so organizations take turns. */
const SLICE_MS = 25_000;
/** A lease older than this is presumed dead (process killed mid-slice) and may be taken over. */
const LEASE_STUCK_SECONDS = 300;
/** Deliveries handled per slice. */
const EVENTS_PER_SLICE = 500;
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
  provider_credential_id: string;
  default_consent_status: string;
  sync_remote_version: string | null;
  sync_next_at: Date | null;
  sync_failures: number;
}

interface Ctx {
  adapter: CrmAdapter;
  organizationId: string;
  sourceId: string;
  credentialId: string;
  defaultConsent: string;
  region: string;
  importReason: string;
  /** What the owner sees: names and ids only. */
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
  available_at: true,
  error_code: true,
  error_message: true,
  created_at: true,
  started_at: true,
  finished_at: true,
} as const;

const fail = (status: number, code: string, message: string) => new HttpException({ error: { code, message } }, status);

type CoreField = (typeof CRM_CORE_FIELDS)[number];

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
  // Only a reason about something that was actually written: a lead keeping
  // its own name must not be told the CRM has none.
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
  /** Extra predicate on the claim; empty in production. See claimOnly. */
  private claimFilter: Prisma.Sql = Prisma.empty;

  constructor(
    // Unguarded on purpose, for the claim and the lease only: "which connection
    // has work?" is a sweep across tenants. Everything else is scoped to the
    // claimed connection's organization through the guarded client.
    private readonly unscoped: PrismaService,
    @Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma,
    private readonly connections: CrmConnectionsService,
    private readonly registry: CrmRegistry,
    private readonly importer: SheetImportService,
    private readonly events: EventsBus,
    private readonly config: ConfigService,
  ) {}

  private get reconcileIntervalMs(): number {
    return Number(this.config.get('CRM_RECONCILE_INTERVAL_MS') ?? 3_600_000);
  }

  /**
   * Polls for work every CRM_POLL_MS (0 = never; owner actions and webhooks
   * still nudge it). Polling is what resumes a run after a restart, retries
   * after a backoff, and runs scheduled reconciliation.
   */
  onModuleInit(): void {
    const active = this.registry.active();
    if (active.length === 0) {
      this.logger.log('CRM sync disabled (set HUBSPOT_ENABLED=1)');
      return;
    }
    const pollMs = Number(this.config.get('CRM_POLL_MS') ?? 30_000);
    if (pollMs <= 0) {
      this.logger.log('periodic CRM sync off (CRM_POLL_MS=0); owner actions and webhooks still run it');
      return;
    }
    this.logger.log(`checking ${active.map((a) => a.provider).join(', ')} connections for work every ${pollMs}ms`);
    this.timer = setInterval(() => this.nudge(), pollMs);
    if (this.timer.unref) this.timer.unref();
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

  /**
   * Restrict claims to these organizations. For test harnesses sharing a
   * database with real connections — never called in production, where the
   * sweep is cross-tenant by design.
   */
  claimOnly(organizationIds: string[]): void {
    this.claimFilter = Prisma.sql`AND s.organization_id = ANY(${organizationIds}::uuid[])`;
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
   * runnable run, or reconciliation due. Only live connections — a revoked or
   * reauthorization-required grant has nothing it could do.
   */
  private async claim(): Promise<Claimed | null> {
    const providers = this.registry.active().map((a) => a.provider);
    const rows = await this.unscoped.$queryRaw<Claimed[]>`
      WITH due AS (
        SELECT s.id FROM lead_sources s
          JOIN provider_credentials c ON c.id = s.provider_credential_id AND c.organization_id = s.organization_id
         WHERE s.provider = ANY(${providers}::text[]) AND s.connection_method = ${SYNC_CONNECTION}
           AND s.archived_at IS NULL AND s.is_active
           AND c.status = ${CredentialStatus.ACTIVE} AND c.revoked_at IS NULL
           AND (s.sync_locked_at IS NULL OR s.sync_locked_at < now() - make_interval(secs => ${LEASE_STUCK_SECONDS}))
           AND (
             EXISTS (SELECT 1 FROM crm_sync_runs r
                      WHERE r.lead_source_id = s.id AND r.status IN ('queued', 'running') AND r.available_at <= now())
             OR EXISTS (SELECT 1 FROM webhook_events e
                         WHERE e.lead_source_id = s.id AND e.queue_state = 'PENDING' AND e.available_at <= now())
             -- Deliveries a dead worker left mid-processing (see processEvents).
             OR EXISTS (SELECT 1 FROM webhook_events e
                         WHERE e.lead_source_id = s.id AND e.queue_state = 'PROCESSING'
                           AND e.locked_at < now() - make_interval(secs => ${LEASE_STUCK_SECONDS}))
             OR s.sync_next_at <= now()
           )
           ${this.claimFilter}
         -- Round robin: the lead_sources updated_at trigger moves on every claim
         -- and release, so the connection worked least recently goes first and
         -- one big import cannot starve everyone else.
         ORDER BY s.updated_at, s.id
         FOR UPDATE OF s SKIP LOCKED
         LIMIT 1
      )
      UPDATE lead_sources s
         SET sync_locked_at = now(), sync_locked_by = ${this.instanceId}
        FROM due
       WHERE s.id = due.id
      RETURNING s.id, s.organization_id, s.provider, s.provider_credential_id, s.default_consent_status,
                s.sync_remote_version, s.sync_next_at, s.sync_failures`;
    return rows[0] ?? null;
  }

  /** Extend the lease; false when this instance no longer holds it. */
  private async heartbeat(c: { sourceId: string; organizationId: string }): Promise<boolean> {
    const n = await this.unscoped.$executeRaw`
      UPDATE lead_sources SET sync_locked_at = now()
       WHERE id = ${c.sourceId}::uuid AND organization_id = ${c.organizationId}::uuid AND sync_locked_by = ${this.instanceId}`;
    return n === 1;
  }

  private async release(c: { sourceId: string; organizationId: string }): Promise<void> {
    await this.unscoped.$executeRaw`
      UPDATE lead_sources SET sync_locked_at = NULL, sync_locked_by = NULL
       WHERE id = ${c.sourceId}::uuid AND organization_id = ${c.organizationId}::uuid AND sync_locked_by = ${this.instanceId}`;
  }

  /** Re-checked before every write: a disconnect mid-slice stops the slice. */
  private async stillLive(ctx: Ctx): Promise<boolean> {
    const n = await this.prisma.provider_credentials.count({
      where: { id: ctx.credentialId, organization_id: ctx.organizationId, status: CredentialStatus.ACTIVE, revoked_at: null },
    });
    return n === 1 && (await this.heartbeat(ctx));
  }

  private async slice(c: Claimed): Promise<void> {
    const adapter = this.registry.byProvider(c.provider);
    const org = await this.prisma.organizations.findUnique({ where: { id: c.organization_id }, select: { default_region: true } });
    const ctx: Ctx = {
      adapter: adapter!,
      organizationId: c.organization_id,
      sourceId: c.id,
      credentialId: c.provider_credential_id,
      defaultConsent: c.default_consent_status,
      region: org?.default_region ?? 'US',
      importReason: adapter ? crmImportReviewReason(adapter.label) : '',
      logTag: `${c.provider} source ${c.id}`,
    };
    const deadline = Date.now() + SLICE_MS;
    try {
      if (!adapter) return;
      if (!(await this.processEvents(ctx))) return;
      const run = await this.prisma.crm_sync_runs.findFirst({
        where: { organization_id: c.organization_id, lead_source_id: c.id, status: { in: ['queued', 'running'] }, available_at: { lte: new Date() } },
        select: { id: true, status: true, cursor: true, started_at: true, attempts: true },
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
    // A worker that died between claiming deliveries and recording their
    // outcome (a crash, a deploy) left them PROCESSING. This one now holds the
    // connection, so anything older than a lease is nobody's: back in the queue.
    await this.unscoped.$executeRaw`
      UPDATE webhook_events
         SET queue_state = 'PENDING', processing_status = 'received', locked_by = NULL, locked_at = NULL
       WHERE lead_source_id = ${ctx.sourceId}::uuid AND organization_id = ${ctx.organizationId}::uuid
         AND provider = ${ctx.adapter.provider} AND queue_state = 'PROCESSING'
         AND locked_at < now() - make_interval(secs => ${LEASE_STUCK_SECONDS})`;
    const claimed = await this.unscoped.$queryRaw<{ id: string; payload: { contactIds?: string[] }; attempts: number; max_attempts: number }[]>`
      WITH c AS (
        SELECT id FROM webhook_events
         WHERE lead_source_id = ${ctx.sourceId}::uuid AND organization_id = ${ctx.organizationId}::uuid
           AND provider = ${ctx.adapter.provider} AND queue_state = 'PENDING' AND available_at <= now()
         ORDER BY available_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT ${EVENTS_PER_SLICE}
      )
      UPDATE webhook_events e
         SET queue_state = 'PROCESSING', processing_status = 'processing', locked_by = ${this.instanceId}, locked_at = now(), attempts = e.attempts + 1
        FROM c WHERE e.id = c.id
      RETURNING e.id, e.payload, e.attempts, e.max_attempts`;
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

    await this.unscoped.$executeRaw`
      UPDATE webhook_events
         SET queue_state = 'DONE', processing_status = 'processed', outcome = 'PROCESSED',
             outcome_reason = ${ids.length ? 'contacts_refreshed' : 'not_acted_on'},
             processed_at = now(), processing_ms = ${Date.now() - started}, locked_by = NULL, locked_at = NULL, error_message = NULL
       WHERE id = ANY(${claimed.map((e) => e.id)}::uuid[]) AND queue_state = 'PROCESSING' AND locked_by = ${this.instanceId}`;
    await this.prisma.lead_sources.update({ where: { id: ctx.sourceId }, data: { last_success_at: new Date() } });
    this.logger.log(`${ctx.logTag}: ${claimed.length} webhook event(s), ${ids.length} contact(s) re-read — ${summary(counts)}`);
    if (eventful(counts)) await this.audit(ctx, 'crm_sync.webhook_applied', { events: claimed.length, ...counts }, Date.now() - started);
    if (counts.created > 0) this.events.publish({ organizationId: ctx.organizationId, type: 'lead.created', leadSourceId: ctx.sourceId });
    return true;
  }

  /**
   * Deliveries that could not be processed, in one statement:
   *  - the connection needs reauthorization: back in the queue as they were;
   *    the claim skips the connection until it is reconnected;
   *  - the CRM is rate-limiting or down: back in the queue with backoff (its
   *    Retry-After when it gave one), for as long as that lasts — a deletion
   *    or a merge has no other way in, so these are never given up on;
   *  - anything else: backoff, and after max_attempts DEAD_LETTER with a
   *    reason, for investigation.
   */
  private async eventsFailed(ctx: Ctx, claimed: { id: string; attempts: number; max_attempts: number }[], e: unknown): Promise<void> {
    const { code, message } = describe(ctx.adapter, e);
    const reauth = e instanceof CrmApiError && e.kind === 'REAUTH';
    const transient = e instanceof CrmApiError && e.transient;
    const retryAfter = e instanceof CrmApiError ? e.retryAfterMs : null;
    if (code === 'INTERNAL') this.logger.error(`${ctx.logTag}: webhook processing failed: ${(e as Error)?.stack ?? String(e)}`);
    else this.logger.warn(`${ctx.logTag}: ${claimed.length} webhook event(s) not processed: ${code}`);
    await this.unscoped.$executeRaw`
      UPDATE webhook_events
         SET queue_state = CASE WHEN ${!reauth && !transient} AND attempts >= max_attempts THEN 'DEAD_LETTER' ELSE 'PENDING' END,
             processing_status = CASE WHEN ${!reauth && !transient} AND attempts >= max_attempts THEN 'failed' ELSE 'received' END,
             outcome = CASE WHEN ${!reauth && !transient} AND attempts >= max_attempts THEN 'ERROR' END,
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
    run: { id: string; status: string; cursor: string | null; started_at: Date | null; attempts: number },
    deadline: number,
  ): Promise<void> {
    let startedAt = run.started_at;
    if (run.status === 'queued') {
      // The DATABASE's clock, like every last_seen_at it will be compared with
      // when the run completes: an app host whose clock ran ahead of the
      // database's would otherwise mark the first pages "missing".
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
        const saved = await this.prisma.crm_sync_runs.updateMany({
          where: { id: run.id, organization_id: ctx.organizationId, status: 'running' },
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
            heartbeat_at: new Date(),
            updated_at: new Date(),
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
   * The read is complete — this is unreachable otherwise — so a tracked
   * contact not seen since the run started is no longer in the CRM: marked
   * missing, never deleted. Then the run's watermark becomes the starting point
   * for reconciliation.
   */
  private async completeRun(ctx: Ctx, runId: string, startedAt: Date): Promise<void> {
    const missing = await this.prisma.$executeRaw`
      UPDATE sheet_import_rows SET missing_since = now(), updated_at = now()
       WHERE organization_id = ${ctx.organizationId}::uuid AND lead_source_id = ${ctx.sourceId}::uuid
         AND missing_since IS NULL AND (last_seen_at IS NULL OR last_seen_at < ${startedAt.toISOString()}::timestamptz)`;
    const finished = await this.prisma.crm_sync_runs.updateMany({
      where: { id: runId, organization_id: ctx.organizationId, status: 'running' },
      data: { status: 'succeeded', finished_at: new Date(), missing, cursor: null, updated_at: new Date() },
    });
    // Cancelled meanwhile (a disconnect): its outcome stands.
    if (finished.count === 0) return;
    const done = (await this.prisma.crm_sync_runs.findFirst({ where: { id: runId, organization_id: ctx.organizationId }, select: RUN_SELECT }))!;
    await this.prisma.lead_sources.update({
      where: { id: ctx.sourceId },
      data: {
        last_success_at: new Date(),
        remote_synced_at: new Date(),
        // Reconciliation starts from when this read began: anything modified
        // after that may have been read before it changed.
        sync_remote_version: String(startedAt.getTime()),
        sync_next_at: new Date(Date.now() + this.reconcileIntervalMs),
        sync_failures: 0,
        remote_error_code: null,
        remote_error_message: null,
      },
    });
    const dto = toRunDTO(done);
    await this.audit(ctx, 'crm_sync.completed', { runId, kind: done.kind, pages: done.pages, ...dto.counts }, Date.now() - startedAt.getTime());
    this.logger.log(`${ctx.logTag}: run ${runId} complete — ${summary(dto.counts)}`);
  }

  private async runFailed(ctx: Ctx, run: { id: string; attempts: number }, e: unknown): Promise<void> {
    const { code, message } = describe(ctx.adapter, e);
    const transient = (e instanceof CrmApiError && e.transient) || (!(e instanceof CrmApiError) && !(e instanceof SyncError));
    const attempts = run.attempts + 1;
    const final = !transient || attempts >= MAX_RUN_ATTEMPTS;
    if (code === 'INTERNAL') this.logger.error(`${ctx.logTag}: run ${run.id} failed: ${(e as Error)?.stack ?? String(e)}`);
    const wait = e instanceof CrmApiError && e.retryAfterMs ? e.retryAfterMs : Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
    const n = await this.prisma.crm_sync_runs.updateMany({
      where: { id: run.id, organization_id: ctx.organizationId, status: { in: ['queued', 'running'] } },
      data: final
        ? {
            status: 'failed',
            finished_at: new Date(),
            attempts,
            error_code: transient ? 'RETRIES_EXHAUSTED' : code,
            error_message: message.slice(0, 500),
            updated_at: new Date(),
          }
        : { attempts, available_at: new Date(Date.now() + jitter(wait)), error_code: code, error_message: message.slice(0, 500), updated_at: new Date() },
    });
    if (n.count === 0) return;
    await this.prisma.lead_sources.update({
      where: { id: ctx.sourceId },
      data: { last_failure_at: new Date(), remote_error_code: code, remote_error_message: message.slice(0, 300) },
    });
    this.logger.warn(`${ctx.logTag}: run ${run.id} ${final ? 'failed' : `will retry (attempt ${attempts})`}: ${code}`);
    if (final) await this.audit(ctx, 'crm_sync.failed', { runId: run.id, code, attempts, rateLimited: code.endsWith('RATE_LIMITED') }, 0);
  }

  // -------------------------------------------------------------------------
  // 3. Reconciliation
  // -------------------------------------------------------------------------

  /**
   * Contacts modified since the watermark (minus an overlap), oldest first, by
   * the CRM's search. The watermark only ever moves to a point every contact
   * before which has been written, so a slice that stops part-way, a failure
   * or a restart repeats work but never skips it — and repeating is free,
   * because unchanged contacts hash equal.
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
          // Stopped part-way: carry on from the newest contact written — but
          // never in place, or a burst larger than one search window would loop.
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
      await this.prisma.lead_sources.update({
        where: { id: ctx.sourceId },
        data: {
          sync_failures: failures,
          sync_next_at: new Date(Date.now() + jitter(wait)),
          last_failure_at: new Date(),
          remote_error_code: code,
          remote_error_message: message.slice(0, 300),
        },
      });
      return;
    }
    this.logger.log(`${ctx.logTag}: reconciled — ${summary(counts)}`);
    if (eventful(counts)) await this.audit(ctx, 'crm_sync.reconciled', { ...counts }, Date.now() - startedAt);
    if (counts.created > 0) this.events.publish({ organizationId: ctx.organizationId, type: 'lead.created', leadSourceId: ctx.sourceId });
  }

  private async saveReconcile(ctx: Ctx, p: { watermark?: number; next: Date; success?: boolean }): Promise<void> {
    await this.prisma.lead_sources.update({
      where: { id: ctx.sourceId },
      data: {
        ...(p.watermark !== undefined ? { sync_remote_version: String(p.watermark) } : {}),
        sync_next_at: p.next,
        sync_failures: 0,
        ...(p.success ? { last_success_at: new Date(), remote_error_code: null, remote_error_message: null } : {}),
      },
    });
  }

  private async queueFullRun(ctx: Ctx, why: string): Promise<void> {
    await this.prisma.crm_sync_runs.createMany({
      data: [{ id: newId(), organization_id: ctx.organizationId, lead_source_id: ctx.sourceId, provider: ctx.adapter.provider, kind: 'full' }],
      skipDuplicates: true,
    });
    this.logger.warn(`${ctx.logTag}: ${why}`);
  }

  // -------------------------------------------------------------------------
  // Writing a page of contacts
  // -------------------------------------------------------------------------

  /**
   * One page (at most a few hundred contacts), a fixed handful of statements
   * whatever its size. `counts` is added to.
   *
   *  - Untracked, and exactly one lead in the organization has the same valid
   *    email: LINKED to that lead. Its empty fields are filled from the CRM;
   *    where both have a value and they differ, nothing is written and the
   *    difference waits for the owner in Import Review. Never a second lead.
   *  - Untracked otherwise (no match, or an ambiguous one): a new lead, paused,
   *    awaiting approval — flagged "possible duplicate" by the engine when its
   *    phone or email belongs to someone else. Phone alone never links: shared
   *    office and family numbers would merge strangers.
   *  - Tracked and approved, changed in the CRM: a field-level three-way merge
   *    against what the CRM said last time (crmMerge). Changed only in the CRM
   *    and clashing with nobody: applied. Changed on both sides, or the new
   *    phone/email belongs to another lead: held for the owner.
   *  - Pending drafts, rejected rows, and a lead deleted out of band: the
   *    engine's existing rules (refresh the draft; flag; re-import paused).
   */
  async persistContacts(ctx: Ctx, contacts: CrmContact[], counts: CrmCounts): Promise<void> {
    const { adapter, organizationId: org, sourceId } = ctx;
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
      const leadSelect = {
        id: true,
        first_name: true,
        last_name: true,
        email: true,
        normalized_email: true,
        email_valid: true,
        phone: true,
        normalized_phone: true,
        phone_valid: true,
        custom_fields: true,
      } as const;
      const tracked = await this.prisma.sheet_import_rows.findMany({
        where: { organization_id: org, lead_source_id: sourceId, row_key: { in: rows.map((r) => r.key!) } },
        select: {
          id: true,
          row_key: true,
          review_state: true,
          content_hash: true,
          lead_id: true,
          changed_after_review_at: true,
          synced_values: true,
          leads: { select: leadSelect },
        },
      });
      const trackedByKey = new Map(tracked.map((t) => [t.row_key, t]));

      // Who these contacts already are in this organization: to link an
      // untracked contact, and to know whether a new phone or email clashes.
      const untracked = rows.filter((r) => !trackedByKey.has(r.key!));
      const changed = rows.filter((r) => {
        const t = trackedByKey.get(r.key!);
        return t?.lead_id && t.review_state === 'approved' && !t.changed_after_review_at && t.content_hash !== r.hash;
      });
      const candidates = [...untracked, ...changed];
      const emails = [...new Set(candidates.map((r) => r.lead!.normalized_email).filter((e): e is string => !!e))];
      const phones = [...new Set(candidates.map((r) => r.lead!.normalized_phone).filter((p): p is string => !!p))];
      const externalIds = untracked.map((r) => r.externalId!).filter(Boolean);
      const others =
        emails.length || phones.length || externalIds.length
          ? await this.prisma.leads.findMany({
              where: {
                organization_id: org,
                OR: [
                  ...(emails.length ? [{ normalized_email: { in: emails } }] : []),
                  ...(phones.length ? [{ normalized_phone: { in: phones } }] : []),
                  ...(externalIds.length ? [{ lead_source_id: sourceId, external_lead_id: { in: externalIds } }] : []),
                ],
              },
              select: { ...leadSelect, dnc_status: true, lead_source_id: true, external_lead_id: true, review_reasons: true },
            })
          : [];
      // A lead this connection already tracks (for any contact) is never linked to a second one.
      const alreadyTracked = new Set(
        others.length
          ? (
              await this.prisma.sheet_import_rows.findMany({
                where: { organization_id: org, lead_source_id: sourceId, lead_id: { in: others.map((o) => o.id) } },
                select: { lead_id: true },
              })
            ).map((t) => t.lead_id)
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

      const links: Prisma.sheet_import_rowsCreateManyInput[] = [];
      const linkAudit: { leadId: string; match: string; held: boolean }[] = [];
      const apply: { trackingId: string | null; key: string; lead: LeadRow; row: BuiltRow; fields: CoreField[] }[] = [];
      const claimedLeads = new Set<string>();

      // --- link untracked contacts to leads that already exist ---
      for (const r of untracked) {
        const free = others.filter((o) => !alreadyTracked.has(o.id) && !claimedLeads.has(o.id));
        // Recovery: this connection created the lead (it carries the record id)
        // but its tracking row is gone.
        let lead = free.find((o) => o.lead_source_id === sourceId && o.external_lead_id === r.externalId);
        let match = 'external_id';
        if (!lead && r.lead!.normalized_email) {
          const byEmail = free.filter((o) => o.normalized_email === r.lead!.normalized_email);
          if (byEmail.length === 1) [lead, match] = [byEmail[0], 'email'];
        }
        if (!lead) continue;
        claimedLeads.add(lead.id);

        const awaiting = lead.lead_source_id === sourceId && lead.review_reasons.includes(ctx.importReason);
        const merge = crmMerge(null, crmValuesOf(lead, prefix), crmValuesOf(r.lead!, prefix));
        const held = !awaiting && (merge.conflicts.length > 0 || clashes(r, lead.id, merge.apply));
        links.push({
          id: newId(),
          organization_id: org,
          lead_source_id: sourceId,
          row_key: r.key!,
          lead_id: lead.id,
          // A draft is refreshed by the engine; a held link is flagged by it
          // (an empty hash never matches), so the existing lead is never
          // overwritten by being linked.
          content_hash: awaiting || held ? '' : r.hash!,
          row_number: 1,
          review_state: awaiting ? 'pending' : 'approved',
          reviewed_at: awaiting ? null : new Date(),
          last_seen_at: new Date(),
        });
        linkAudit.push({ leadId: lead.id, match, held });
        if (!awaiting && !held) apply.push({ trackingId: null, key: r.key!, lead, row: r, fields: merge.apply });
      }

      // --- tracked, approved, changed in the CRM: the three-way merge ---
      for (const r of changed) {
        const t = trackedByKey.get(r.key!)!;
        if (!t.leads) continue;
        const base = (t.synced_values as unknown as CrmValues | null) ?? null;
        const merge = crmMerge(base, crmValuesOf(t.leads, prefix), crmValuesOf(r.lead!, prefix));
        // Without a base there is nothing to tell "changed here" from; the engine flags it.
        if (!base || merge.conflicts.length > 0 || clashes(r, t.leads.id, merge.apply)) continue;
        apply.push({ trackingId: t.id, key: r.key!, lead: t.leads, row: r, fields: merge.apply });
      }

      if (links.length || apply.length) {
        // One batch transaction: links, applied values, moved hashes and the
        // audit land together or not at all, without holding a connection
        // idle between statements.
        const statements: Prisma.PrismaPromise<unknown>[] = [];
        // No skipDuplicates: the lease means nobody else writes this source,
        // and if somehow they did, failing the page (it is retried) beats
        // applying values to a lead whose link was not ours to make.
        if (links.length) statements.push(this.prisma.sheet_import_rows.createMany({ data: links }));
        if (apply.length) {
          statements.push(
            applyCrmChanges(
              this.prisma,
              org,
              apply.map((a) => ({ lead_id: a.lead.id, changed_values: mergedChange(a.lead, a.row, a.fields, prefix) })),
            ),
          );
          const moved = apply.filter((a) => a.trackingId);
          if (moved.length) {
            const values = moved.map((a) => Prisma.sql`(${a.trackingId}::uuid, ${a.row.hash!}::varchar)`);
            statements.push(this.prisma.$executeRaw`
              UPDATE sheet_import_rows AS r SET content_hash = v.hash, updated_at = now()
                FROM (VALUES ${Prisma.join(values)}) AS v(id, hash)
               WHERE r.id = v.id AND r.organization_id = ${org}::uuid AND r.changed_after_review_at IS NULL`);
          }
        }
        if (linkAudit.length) {
          statements.push(
            this.prisma.audit_logs.createMany({
              data: linkAudit.map((l) => ({
                id: newId(),
                organization_id: org,
                actor_type: 'system',
                action: 'crm.contact_linked',
                entity_type: 'lead',
                entity_id: l.leadId,
                payload: { provider: adapter.provider, leadSourceId: sourceId, match: l.match, differencesHeldForReview: l.held } as Prisma.InputJsonValue,
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

      // The CRM values each record now stands at — the base of the next merge.
      // Only where they were accepted (applied, imported, unchanged): a held
      // change keeps its old hash, so it keeps its old base too.
      const synced = rows.map((r) => Prisma.sql`(${r.key!}::varchar, ${r.hash!}::varchar, ${JSON.stringify(crmValuesOf(r.lead!, prefix))}::jsonb)`);
      await this.prisma.$executeRaw`
        UPDATE sheet_import_rows AS t SET synced_values = v.vals
          FROM (VALUES ${Prisma.join(synced)}) AS v(key, hash, vals)
         WHERE t.organization_id = ${org}::uuid AND t.lead_source_id = ${sourceId}::uuid
           AND t.row_key = v.key AND t.content_hash = v.hash`;
    }

    // Everything seen in the CRM is present — contacts we refused included,
    // they are still there — and a contact that had gone missing is back.
    if (seenKeys.length) {
      await this.prisma.$executeRaw`
        UPDATE sheet_import_rows SET last_seen_at = now(), missing_since = NULL
         WHERE organization_id = ${org}::uuid AND lead_source_id = ${sourceId}::uuid AND row_key = ANY(${seenKeys}::varchar[])`;
    }
  }

  /**
   * The engine writes a page in one transaction. When the DATABASE refuses it
   * for a reason a retry cannot fix (a value it will not store), the page is
   * written again one contact at a time, so one bad record cannot hold back
   * the rest of its page; each refused record is counted as failed.
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
   * succeeded. Asking while one is queued or running returns that one: the
   * partial unique index makes a second impossible, however the clicks race.
   */
  async requestSync(adapter: CrmAdapter, who: SessionIdentity): Promise<{ run: RunDTO; alreadyActive: boolean }> {
    const { source } = await this.liveSource(adapter, who.organizationId);
    const id = newId();
    const created = await this.prisma.crm_sync_runs.createMany({
      data: [
        {
          id,
          organization_id: who.organizationId,
          lead_source_id: source.id,
          provider: adapter.provider,
          kind: source.remote_synced_at ? 'full' : 'initial',
          requested_by: who.userId,
        },
      ],
      skipDuplicates: true,
    });
    const run = await this.prisma.crm_sync_runs.findFirst({
      where: created.count ? { id, organization_id: who.organizationId } : { organization_id: who.organizationId, lead_source_id: source.id, status: { in: ['queued', 'running'] } },
      select: RUN_SELECT,
    });
    if (!run) throw fail(409, 'CRM_SYNC_NOT_STARTED', 'The sync could not be started. Try again.');
    if (created.count) {
      await this.prisma.audit_logs.create({
        data: {
          id: newId(),
          organization_id: who.organizationId,
          actor_type: 'user',
          actor_id: who.userId,
          action: 'crm_sync.requested',
          entity_type: 'lead_source',
          entity_id: source.id,
          payload: { provider: adapter.provider, runId: id, kind: run.kind } as Prisma.InputJsonValue,
        },
      });
    }
    this.nudge();
    return { run: toRunDTO(run), alreadyActive: created.count === 0 };
  }

  async runs(adapter: CrmAdapter, organizationId: string, limit = 20): Promise<RunDTO[]> {
    const rows = await this.prisma.crm_sync_runs.findMany({
      where: { organization_id: organizationId, provider: adapter.provider },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: limit,
      select: RUN_SELECT,
    });
    return rows.map(toRunDTO);
  }

  /** One run, only if it belongs to the caller's organization: another's id is simply not found. */
  async run(adapter: CrmAdapter, organizationId: string, runId: string): Promise<RunDTO> {
    const row = await this.prisma.crm_sync_runs.findFirst({
      where: { id: runId, organization_id: organizationId, provider: adapter.provider },
      select: RUN_SELECT,
    });
    if (!row) throw fail(404, 'CRM_RUN_NOT_FOUND', 'No such sync run.');
    return toRunDTO(row);
  }

  /** Everything the integration card shows. Never a token, never a record value. */
  async status(adapter: CrmAdapter, organizationId: string) {
    const credential = await this.prisma.provider_credentials.findFirst({
      where: { organization_id: organizationId, provider: adapter.provider, revoked_at: null },
      select: { id: true, status: true, account_name: true, account_email: true, external_account_id: true, last_error_code: true, created_at: true },
    });
    const source = await this.prisma.lead_sources.findFirst({
      where: {
        organization_id: organizationId,
        provider: adapter.provider,
        connection_method: SYNC_CONNECTION,
        archived_at: null,
        ...(credential ? { provider_credential_id: credential.id } : {}),
      },
      orderBy: { updated_at: 'desc' },
      select: {
        id: true,
        external_form_id: true,
        external_form_name: true,
        last_success_at: true,
        last_failure_at: true,
        last_event_at: true,
        remote_error_code: true,
        remote_error_message: true,
        sync_next_at: true,
      },
    });
    // One after another rather than all at once: a card polled during an
    // import must not compete with the import for the connection pool.
    const runs = source
      ? await this.prisma.crm_sync_runs.findMany({ where: { organization_id: organizationId, lead_source_id: source.id }, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 2, select: RUN_SELECT })
      : [];
    const counts = source
      ? await this.prisma.sheet_import_rows.groupBy({
          by: ['review_state'],
          where: { organization_id: organizationId, lead_source_id: source.id, lead_id: { not: null } },
          _count: { _all: true },
        })
      : [];
    const pendingReview = counts.find((c) => c.review_state === 'pending')?._count._all ?? 0;
    const leads = counts.reduce((n, c) => n + c._count._all, 0);
    const changes = source
      ? await this.prisma.sheet_import_rows.count({ where: { organization_id: organizationId, lead_source_id: source.id, changed_after_review_at: { not: null } } })
      : 0;
    const connectedBy = credential ? await this.connectedBy(organizationId, credential.id) : null;
    const active = runs.find((r) => r.status === 'queued' || r.status === 'running') ?? null;
    const last = runs.find((r) => r !== active) ?? null;
    const lastFailed = last?.status === 'failed';

    let status: 'not_connected' | 'connected' | 'reauthorization_required' | 'disconnected' | 'error';
    // A failed run stops being "the" state once a newer one is under way (a
    // reconnect queues one straight away).
    if (credential?.status === CredentialStatus.ACTIVE) status = lastFailed && !active ? 'error' : 'connected';
    else if (credential) status = 'reauthorization_required';
    else status = source ? 'disconnected' : 'not_connected';

    return {
      provider: adapter.provider,
      displayName: adapter.label.displayName,
      configured: adapter.isConfigured(),
      status,
      account: credential
        ? {
            id: credential.external_account_id,
            name: credential.account_name,
            authorizedBy: credential.account_email,
            connectedBy,
            connectedAt: credential.created_at,
          }
        : source
          ? { id: source.external_form_id, name: source.external_form_name, authorizedBy: null, connectedBy: null, connectedAt: null }
          : null,
      sourceId: source?.id ?? null,
      lastSuccessfulSyncAt: source?.last_success_at ?? null,
      lastFailureAt: source?.last_failure_at ?? null,
      lastWebhookAt: source?.last_event_at ?? null,
      nextReconcileAt: source?.sync_next_at ?? null,
      lastError:
        credential && credential.status !== CredentialStatus.ACTIVE
          ? { code: credential.last_error_code ?? 'CRM_REAUTH_REQUIRED', message: `${adapter.label.displayName} access was revoked or has expired. Reconnect to keep syncing.` }
          : source?.remote_error_code
            ? { code: source.remote_error_code, message: source.remote_error_message }
            : null,
      activeRun: active ? toRunDTO(active) : null,
      lastRun: last ? toRunDTO(last) : null,
      importedLeads: leads,
      pendingReview,
      changesToReview: changes,
    };
  }

  /** Who in EstatePulse connected it, from the immutable audit trail. */
  private async connectedBy(organizationId: string, credentialId: string): Promise<string | null> {
    const entry = await this.prisma.audit_logs.findFirst({
      where: { organization_id: organizationId, entity_type: 'provider_credential', entity_id: credentialId, action: { in: ['crm.connected', 'crm.reconnected'] } },
      orderBy: { created_at: 'desc' },
      select: { actor_id: true },
    });
    if (!entry?.actor_id) return null;
    const user = await this.prisma.users.findUnique({ where: { id: entry.actor_id }, select: { email: true } });
    return user?.email ?? null;
  }

  private async liveSource(adapter: CrmAdapter, organizationId: string) {
    const credential = await this.prisma.provider_credentials.findFirst({
      where: { organization_id: organizationId, provider: adapter.provider, revoked_at: null },
      select: { id: true, status: true },
    });
    if (!credential) throw fail(409, 'CRM_NOT_CONNECTED', `${adapter.label.displayName} is not connected.`);
    if (credential.status !== CredentialStatus.ACTIVE) {
      throw fail(409, 'CRM_REAUTH_REQUIRED', `${adapter.label.displayName} access was revoked or has expired. Reconnect it first.`);
    }
    const source = await this.prisma.lead_sources.findFirst({
      where: { organization_id: organizationId, provider: adapter.provider, provider_credential_id: credential.id, archived_at: null, is_active: true },
      select: { id: true, remote_synced_at: true },
    });
    if (!source) throw fail(409, 'CRM_NOT_CONNECTED', `${adapter.label.displayName} is not connected.`);
    return { credential, source };
  }

  private async audit(ctx: Ctx, action: string, payload: object, durationMs: number): Promise<void> {
    await this.prisma.audit_logs.create({
      data: {
        id: newId(),
        organization_id: ctx.organizationId,
        actor_type: 'system',
        action,
        entity_type: 'lead_source',
        entity_id: ctx.sourceId,
        payload: { provider: ctx.adapter.provider, ...payload } as Prisma.InputJsonValue,
        response_time_ms: Math.max(0, Math.round(durationMs)),
      },
    });
  }
}

export function toRunDTO(r: {
  id: string;
  kind: string;
  status: string;
  pages: number;
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
  attempts: number;
  available_at: Date;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}): RunDTO {
  const active = r.status === 'queued' || r.status === 'running';
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
    nextAttemptAt: active && r.attempts > 0 ? r.available_at : null,
    error: r.error_code ? { code: r.error_code, message: r.error_message } : null,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
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
