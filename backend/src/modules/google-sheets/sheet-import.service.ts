import { HttpException, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { LeadStatus } from '../../common/domain';
import { newId } from '../../common/ids';
import { PrismaService, TENANT_PRISMA, type GuardedPrisma } from '../../prisma/prisma.service';
import { EventsBus } from '../events/events.bus';
import { GoogleConnectionsService } from './google-connections.service';
import { approveTrackingRows } from './approval';
import { GoogleApiError, GoogleClient, SPREADSHEET_MIME } from './google.client';
import { sheetsEnabled } from './sheets-enabled.guard';
import {
  IMPORT_REVIEW_REASON,
  MAX_COLUMNS,
  MAX_DATA_ROWS,
  analyzeHeaders,
  buildRow,
  headerFingerprint,
  type BuiltRow,
  type Identity,
  type LeadFields,
  type RowIssue,
  type SheetHeader,
  type StoredMapping,
} from './sheet-rows';

export const GOOGLE_SHEETS_PROVIDER = 'GOOGLE_SHEETS';
export const SYNC_CONNECTION = 'SYNC';

export const DNC_REASON = 'This contact previously opted out — imported as do-not-contact';

/** Which fresh rows an import approves as they land, and on whose behalf. */
export interface Approval {
  rule: (row: BuiltRow) => boolean;
  by: { userId: string };
}
export const DUPLICATE_REASON = 'Possible duplicate: another lead has the same phone or email';

/** Rows per Google read: comfortably under Sheets' recommended response size. */
export const READ_CHUNK_ROWS = 2_000;
/** Rows per database batch: one contact check and one write transaction. */
const DB_BATCH = 500;
/** Phones or emails per contact lookup, keeping each IN list bounded. */
const CONTACT_CHUNK = 2_000;
/** A lease older than this is presumed dead (process killed mid-run) and may be taken over. */
const LEASE_STUCK_SECONDS = 600;
/** Row numbers and codes only, never cell values. */
const ERROR_SAMPLE_LIMIT = 50;
/** Retry after a transient failure: 1 min, 2, 4 … capped at an hour, with jitter. */
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 3_600_000;
/** Ids per missing-row UPDATE, to keep the parameter list bounded. */
const ID_CHUNK = 1_000;

/**
 * Failures that need the owner (reconnect, fix the sheet, re-map), as opposed
 * to ones a later run may simply not hit. A permanent failure pauses the
 * source; anything else is retried with backoff.
 */
const PERMANENT = new Set([
  'NOT_CONFIGURED',
  'TAB_MISSING',
  'HEADERS_CHANGED',
  'SHEET_TOO_LARGE',
  'GOOGLE_REAUTH_REQUIRED',
  'GOOGLE_FILE_NOT_FOUND',
  'GOOGLE_FILE_ACCESS_DENIED',
  'GOOGLE_NOT_A_SPREADSHEET',
  'GOOGLE_CONNECTION_NOT_FOUND',
]);

/** A refusal with a stable code and an owner-readable message. Never carries cell values. */
export class SyncError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SyncError';
  }
}

/** What a reviewed row's flag carries until the owner applies or keeps it. */
export interface ChangedValues {
  hash: string;
  lead: LeadFields;
  externalId: string | null;
  /** The new contact matched an opted-out contact when the change was seen. */
  dnc: boolean;
  reviewReasons: string[];
  /** A CRM row's custom-field prefix (BuiltRow.crmPrefix): applying writes only the CRM's fields. */
  crmPrefix?: string;
}

/** Counters for one run: logged every run, and recorded on eventful runs. */
export class RunStats {
  googleRequests = 0;
  dbStatements = 0;
  rowsRead = 0;
  blank = 0;
  inserted = 0;
  unchanged = 0;
  /** Pending rows whose lead was refreshed from the sheet. */
  updated = 0;
  /** Reviewed rows that changed: flagged for the owner, lead untouched. */
  flagged = 0;
  /** Flags dropped because the sheet went back to the reviewed values. */
  flagsCleared = 0;
  /** Reviewed rows re-hashed silently after a mapping change. */
  rebaselined = 0;
  moved = 0;
  missingMarked = 0;
  reappeared = 0;
  dncInherited = 0;
  possibleDuplicates = 0;
  /** Fresh rows approved as they landed — the ones the owner ticked when switching the sheet on — and how many were released. */
  autoApproved = 0;
  autoReleased = 0;
  autoHeld: { rowId: string; leadId: string; reason: string }[] = [];
  /** Tracked rows whose lead had been deleted out of band: imported again, onto a new lead. */
  relinked = 0;
  /** Drive version unchanged: the sheet was not read at all. */
  probeSkipped = false;
  skipped: Partial<Record<RowIssue, number>> = {};
  errorSample: { row: number; code: RowIssue }[] = [];

  constructor(readonly queueDelayMs: number) {}

  skip(row: number, code: RowIssue): void {
    this.skipped[code] = (this.skipped[code] ?? 0) + 1;
    if (this.errorSample.length < ERROR_SAMPLE_LIMIT) this.errorSample.push({ row, code });
  }

  /** Worth a permanent audit record: something in the database changed. */
  get eventful(): boolean {
    return (
      this.inserted + this.updated + this.flagged + this.flagsCleared + this.rebaselined + this.missingMarked + this.reappeared >
      0
    );
  }

  summary(durationMs: number) {
    return {
      rowsRead: this.rowsRead,
      blank: this.blank,
      inserted: this.inserted,
      updated: this.updated,
      unchanged: this.unchanged,
      flagged: this.flagged,
      flagsCleared: this.flagsCleared,
      rebaselined: this.rebaselined,
      moved: this.moved,
      missingMarked: this.missingMarked,
      reappeared: this.reappeared,
      skipped: this.skipped,
      dncInherited: this.dncInherited,
      possibleDuplicates: this.possibleDuplicates,
      autoApproved: this.autoApproved,
      autoReleased: this.autoReleased,
      relinked: this.relinked,
      probeSkipped: this.probeSkipped,
      googleRequests: this.googleRequests,
      dbStatements: this.dbStatements,
      durationMs,
      queueDelayMs: this.queueDelayMs,
      errorSample: this.errorSample,
    };
  }
}

interface Claimed {
  id: string;
  organization_id: string;
  delay_ms: number;
  sync_failures: number;
}

interface Tracked {
  id: string;
  row_key: string;
  content_hash: string;
  review_state: string;
  lead_id: string | null;
  row_number: number;
  changed_after_review_at: Date | null;
  changed_values: unknown;
  missing_since: Date | null;
}

interface RunResult {
  fullRead: boolean;
  firstRun: boolean;
  rebaseline: boolean;
  fingerprint: string | null;
  versionToken: string | null;
}

/**
 * Imports a connected spreadsheet tab into leads that wait for review, and
 * keeps them in step with the sheet afterwards.
 *
 * Safety properties, each enforced here rather than hoped for:
 *  - Every imported lead is INSERTED with automation_paused = true and a review
 *    reason, in the same statement. Approval (SheetReviewService) is the only way
 *    out, and it never calls the outreach engine itself.
 *  - A row is imported at most once: sheet_import_rows is unique on
 *    (lead_source_id, row_key), and the lead and its tracking row are written in
 *    one transaction, so a retry or an overlapping run cannot duplicate either.
 *  - A reviewed lead is never overwritten from the sheet. A change is flagged,
 *    with the new values held for the owner to apply or keep.
 *  - A row is marked missing only after a COMPLETE read; leads are never deleted.
 *  - One run per source at a time: a lease taken with FOR UPDATE SKIP LOCKED,
 *    and a result is recorded only while that lease is still held.
 *  - A sheet over the row cap, a changed header, a lost permission or a deleted
 *    file stops the run before anything is written, and pauses the source.
 *  - No transaction or connection is held across a Google request: the whole
 *    tab is read first (bounded by the cap), then written in short batches.
 */
@Injectable()
export class SheetImportService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('SheetImport');
  private readonly instanceId = `sheets-${randomUUID()}`;
  private draining: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  /** Extra predicate on the claim; empty in production. See claimOnly. */
  private claimFilter: Prisma.Sql = Prisma.empty;

  constructor(
    // Unguarded on purpose, for the claim and the lease release only: "which
    // source is due?" is a sweep across tenants. Everything else is scoped to
    // the claimed row's organization through the guarded client.
    private readonly unscoped: PrismaService,
    @Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma,
    private readonly connections: GoogleConnectionsService,
    private readonly google: GoogleClient,
    private readonly events: EventsBus,
    private readonly config: ConfigService,
  ) {}

  private get periodic(): boolean {
    return this.config.get<string>('SHEETS_SYNC') === '1';
  }

  private get intervalMs(): number {
    return Number(this.config.get('SHEETS_SYNC_INTERVAL_MS') ?? 300_000);
  }

  /**
   * Gated like the other pollers: periodic sync reads every connected sheet and
   * writes leads, so it never starts by accident against a shared database.
   * Owner actions (enable, sync now) still run without it.
   */
  onModuleInit(): void {
    if (!sheetsEnabled(this.config)) {
      this.logger.log('Google Sheets import disabled (set GOOGLE_SHEETS_ENABLED=1)');
      return;
    }
    if (!this.periodic) {
      this.logger.log('periodic sync disabled (set SHEETS_SYNC=1); owner-triggered syncs still run');
      return;
    }
    const pollMs = Number(this.config.get('SHEETS_POLL_MS') ?? 60_000);
    this.logger.log(`checking for due spreadsheets every ${pollMs}ms; each syncs every ${this.intervalMs}ms`);
    this.timer = setInterval(() => this.nudge(), pollMs);
    if (this.timer.unref) this.timer.unref();
    // Picks up anything a restart left due or leased.
    this.nudge();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Process due sources soon, in the background. Never throws; never makes the caller wait. */
  nudge(): void {
    void this.drain();
  }

  /**
   * Restrict claims to these organizations. For test harnesses that share a
   * database with real sources: a due sheet of someone else's must never be run
   * against a fake Google. Production never calls this — the sweep is
   * cross-tenant by design.
   */
  claimOnly(organizationIds: string[]): void {
    this.claimFilter = Prisma.sql`AND organization_id = ANY(${organizationIds}::uuid[])`;
  }

  /**
   * Process every due source, one at a time. A call while a drain is running
   * joins it, and that drain looks again before finishing — so a source made
   * due mid-run is never left waiting, and the promise means "all caught up".
   */
  drain(): Promise<void> {
    // Switched off: nothing is read or written; due sources simply wait.
    if (!sheetsEnabled(this.config)) return Promise.resolve();
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
          await this.run(claimed);
        }
      } while (this.again && !this.stopped);
    } catch (e) {
      this.logger.error(`sheet import loop failed: ${(e as Error).message}`);
    }
  }

  /** The most overdue source first: fairness across organizations is queue order. `only`: that one source, or nothing. */
  private async claim(only: { organizationId: string; sourceId: string } | null = null): Promise<Claimed | null> {
    const rows = await this.unscoped.$queryRaw<Claimed[]>`
      WITH due AS (
        SELECT id FROM lead_sources
         WHERE connection_method = ${SYNC_CONNECTION}
           AND provider = ${GOOGLE_SHEETS_PROVIDER}
           AND is_active AND archived_at IS NULL
           AND ingest_status = 'ACTIVE'
           AND sync_next_at <= now()
           AND (sync_locked_at IS NULL OR sync_locked_at < now() - make_interval(secs => ${LEASE_STUCK_SECONDS}))
           ${this.claimFilter}
           ${only ? Prisma.sql`AND id = ${only.sourceId}::uuid AND organization_id = ${only.organizationId}::uuid` : Prisma.empty}
         ORDER BY sync_next_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      UPDATE lead_sources s
         SET sync_locked_at = now(), sync_locked_by = ${this.instanceId}
        FROM due
       WHERE s.id = due.id
      RETURNING s.id, s.organization_id, s.sync_failures,
                GREATEST(0, (extract(epoch FROM (now() - s.sync_next_at)) * 1000))::int AS delay_ms`;
    return rows[0] ?? null;
  }

  private async run(c: Claimed, approve: Approval | null = null): Promise<{ ok: boolean; stats: RunStats }> {
    const started = Date.now();
    const claimedAt = new Date();
    const stats = new RunStats(c.delay_ms);
    try {
      const result = await this.importOnce(c.organization_id, c.id, stats, approve);
      await this.finishOk(c, claimedAt, stats, started, result);
      return { ok: true, stats };
    } catch (e) {
      await this.finishFailed(c, claimedAt, stats, started, e);
      return { ok: false, stats };
    }
  }

  /**
   * Run one source now, in the caller's request, approving the fresh rows
   * `approve` picks as they land — the owner's "Start importing", whose ticks
   * only this run knows. The sweep's lease applies, so a sweep that already
   * holds the source (or a source that is not due) gives null: the caller
   * queues it instead, and its rows wait in Import Review. Every other run —
   * scheduled, "Sync now", a retry — approves nothing.
   */
  async runNow(organizationId: string, sourceId: string, approve: Approval): Promise<{ ok: boolean; stats: RunStats } | null> {
    if (!sheetsEnabled(this.config) || this.stopped) return null;
    const claimed = await this.claim({ organizationId, sourceId });
    return claimed ? this.run(claimed, approve) : null;
  }

  // -------------------------------------------------------------------------
  // One run
  // -------------------------------------------------------------------------

  private async importOnce(organizationId: string, sourceId: string, stats: RunStats, approve: Approval | null): Promise<RunResult> {
    stats.dbStatements += 1;
    const source = await this.prisma.lead_sources.findFirst({
      where: { id: sourceId, organization_id: organizationId, provider: GOOGLE_SHEETS_PROVIDER, connection_method: SYNC_CONNECTION },
      select: {
        provider_credential_id: true,
        external_form_id: true,
        mapping_status: true,
        mapping_version: true,
        sync_row_key_field: true,
        sync_fallback_ack_at: true,
        sync_remote_version: true,
        remote_synced_at: true,
        last_success_at: true,
        default_consent_status: true,
      },
    });
    const [spreadsheetId, sheetIdText] = (source?.external_form_id ?? '').split(':');
    const sheetId = Number(sheetIdText);
    if (!source?.provider_credential_id || !spreadsheetId || !Number.isInteger(sheetId)) {
      throw new SyncError('NOT_CONFIGURED', 'This source has no Google connection or spreadsheet.');
    }
    if (source.mapping_status !== 'CONFIGURED') throw new SyncError('NOT_CONFIGURED', 'Map the columns before importing.');
    const identity: Identity | null = source.sync_row_key_field
      ? { mode: 'column', fieldKey: source.sync_row_key_field }
      : source.sync_fallback_ack_at
        ? { mode: 'fallback' }
        : null;
    if (!identity) throw new SyncError('NOT_CONFIGURED', 'Choose a unique ID column, or acknowledge the fallback identity.');

    // The token records which Drive version was read under which mapping. A
    // mapping change re-hashes every row, so the first read after one updates
    // reviewed rows' hashes without flagging them as edited.
    const [lastVersion, lastMapping] = (source.sync_remote_version ?? '').split(':');
    const rebaseline = lastMapping !== String(source.mapping_version);

    stats.dbStatements += 2;
    const [mappingRows, org] = await Promise.all([
      this.prisma.lead_source_field_mappings.findMany({
        where: { organization_id: organizationId, lead_source_id: sourceId, is_active: true },
        select: { source_field_key: true, target_field: true, transform: true },
      }),
      this.prisma.organizations.findUnique({ where: { id: organizationId }, select: { default_region: true } }),
    ]);
    const mappings = mappingRows as unknown as StoredMapping[];
    if (mappings.length === 0) throw new SyncError('NOT_CONFIGURED', 'Map the columns before importing.');
    const region = org?.default_region ?? 'US';

    // A tracked row whose lead was deleted out of band is imported again — which
    // only a full read can do, so the version probe must not skip one while any exist.
    let orphans = 0;
    if (this.config.get<string>('SHEETS_VERSION_PROBE') === '1') {
      stats.dbStatements += 1;
      orphans = await this.prisma.sheet_import_rows.count({ where: { organization_id: organizationId, lead_source_id: sourceId, lead_id: null } });
    }
    const sheet = await this.readTab(
      organizationId,
      source.provider_credential_id,
      spreadsheetId,
      sheetId,
      mappings,
      identity,
      stats,
      rebaseline || orphans > 0 ? null : lastVersion || null,
      source.remote_synced_at,
    );
    const versionToken = sheet.version === null ? null : `${sheet.version}:${source.mapping_version}`;
    if (sheet.skipped) {
      stats.probeSkipped = true;
      return { fullRead: false, firstRun: false, rebaseline: false, fingerprint: null, versionToken };
    }

    const ctx = {
      headerIndex: new Map(sheet.headers.filter((h) => h.fieldKey).map((h) => [h.fieldKey, h.index])),
      labels: new Map(sheet.headers.filter((h) => h.fieldKey).map((h) => [h.fieldKey, h.label])),
      mappings,
      identity,
      region,
    };
    // present: every identity still in the sheet, refused rows included, for
    // missing-row detection. seen: identities already taken by an earlier
    // importable row; a later one is a duplicate within the sheet.
    const present = new Set<string>();
    const seen = new Set<string>();
    const candidates: BuiltRow[] = [];
    for (const r of sheet.rows) {
      const built = buildRow(r.cells, r.rowNumber, ctx);
      if (built.blank) {
        stats.blank += 1;
        continue;
      }
      if (built.key) present.add(built.key);
      if (built.issue) {
        stats.skip(r.rowNumber, built.issue);
        continue;
      }
      if (seen.has(built.key!)) {
        stats.skip(r.rowNumber, 'DUPLICATE_IN_SHEET');
        continue;
      }
      seen.add(built.key!);
      candidates.push(built);
    }

    // Every row tracked for this source, once, for both classification and
    // missing-row detection — instead of one existence query per batch.
    stats.dbStatements += 1;
    const tracked = (await this.prisma.sheet_import_rows.findMany({
      where: { organization_id: organizationId, lead_source_id: sourceId },
      select: {
        id: true,
        row_key: true,
        content_hash: true,
        review_state: true,
        lead_id: true,
        row_number: true,
        changed_after_review_at: true,
        changed_values: true,
        missing_since: true,
      },
    })) as Tracked[];
    const known = new Map(tracked.map((t) => [t.row_key, t]));

    const runPhones = new Set<string>();
    const runEmails = new Set<string>();
    const mappedTargets = new Set(mappings.map((m) => m.target_field));
    for (let i = 0; i < candidates.length; i += DB_BATCH) {
      await this.persistBatch(
        organizationId,
        sourceId,
        source.default_consent_status,
        candidates.slice(i, i + DB_BATCH),
        known,
        rebaseline ? mappedTargets : null,
        runPhones,
        runEmails,
        stats,
        IMPORT_REVIEW_REASON,
        approve,
      );
    }

    // The read was complete — this line is unreachable otherwise — so absence
    // now means the row is gone. Marked, never deleted.
    const now = new Date();
    const toMark = tracked.filter((t) => !t.missing_since && !present.has(t.row_key)).map((t) => t.id);
    const toClear = tracked.filter((t) => t.missing_since && present.has(t.row_key)).map((t) => t.id);
    for (const [ids, value] of [
      [toMark, now],
      [toClear, null],
    ] as const) {
      for (let i = 0; i < ids.length; i += ID_CHUNK) {
        stats.dbStatements += 1;
        await this.prisma.sheet_import_rows.updateMany({
          where: { organization_id: organizationId, id: { in: ids.slice(i, i + ID_CHUNK) } },
          data: { missing_since: value, updated_at: now },
        });
      }
    }
    stats.missingMarked = toMark.length;
    stats.reappeared = toClear.length;

    return {
      fullRead: true,
      firstRun: !source.last_success_at,
      rebaseline,
      fingerprint: headerFingerprint(sheet.headers),
      versionToken,
    };
  }

  /**
   * Read the whole tab — header, then data rows in fixed index ranges up to the
   * tab's row count. Not "until a short chunk": Google drops trailing blank
   * rows inside a range, so a short chunk does not mean the data has ended.
   *
   * With SHEETS_VERSION_PROBE=1, an unchanged Drive version skips everything
   * after the first request — but never for longer than
   * SHEETS_FULL_READ_MAX_AGE_MS, in case some edit does not move the version.
   */
  private async readTab(
    organizationId: string,
    credentialId: string,
    spreadsheetId: string,
    sheetId: number,
    mappings: StoredMapping[],
    identity: Identity,
    stats: RunStats,
    lastVersion: string | null,
    lastFullRead: Date | null,
  ): Promise<{ skipped: boolean; headers: SheetHeader[]; rows: { rowNumber: number; cells: string[] }[]; version: string | null }> {
    return this.connections.withAccessToken(organizationId, credentialId, async (token) => {
      stats.googleRequests += 1;
      const file = await this.google.driveFile(token, spreadsheetId);
      if (file.trashed) throw new GoogleApiError('NOT_FOUND', 'The spreadsheet is in the trash', 404);
      if (file.mimeType !== SPREADSHEET_MIME) {
        throw new SyncError('GOOGLE_NOT_A_SPREADSHEET', 'The connected file is no longer a Google Sheets spreadsheet.');
      }
      const version = file.version ?? null;
      const maxAge = Number(this.config.get('SHEETS_FULL_READ_MAX_AGE_MS') ?? 6 * 3_600_000);
      if (
        this.config.get<string>('SHEETS_VERSION_PROBE') === '1' &&
        version !== null &&
        version === lastVersion &&
        lastFullRead !== null &&
        Date.now() - lastFullRead.getTime() < maxAge
      ) {
        return { skipped: true, headers: [], rows: [], version };
      }

      stats.googleRequests += 1;
      const meta = await this.google.spreadsheet(token, spreadsheetId);
      const tab = (meta.sheets ?? [])
        .map((s) => s.properties)
        .find((p) => p.sheetId === sheetId && (!p.sheetType || p.sheetType === 'GRID'));
      if (!tab) throw new SyncError('TAB_MISSING', 'The connected tab no longer exists in the spreadsheet.');
      const rowCount = tab.gridProperties?.rowCount ?? 0;
      const columnCount = Math.min(tab.gridProperties?.columnCount ?? MAX_COLUMNS, MAX_COLUMNS);

      stats.googleRequests += 1;
      const [headerCells = []] = await this.google.readGrid(token, spreadsheetId, sheetId, 1, columnCount, 0);
      const headers = analyzeHeaders(headerCells);

      // Fail closed on any change to a column this source depends on.
      const byKey = new Map(headers.filter((h) => h.fieldKey).map((h) => [h.fieldKey, h]));
      const needed = new Set(mappings.map((m) => m.source_field_key));
      if (identity.mode === 'column') needed.add(identity.fieldKey);
      const broken = [...needed].filter((k) => !byKey.get(k) || byKey.get(k)!.duplicate);
      if (broken.length > 0) {
        throw new SyncError(
          'HEADERS_CHANGED',
          `Mapped column${broken.length === 1 ? '' : 's'} missing or duplicated in the header row: ${broken.join(', ')}. Confirm the mapping again.`,
        );
      }
      const width = Math.max(...[...needed].map((k) => byKey.get(k)!.index)) + 1;

      const rows: { rowNumber: number; cells: string[] }[] = [];
      let nonBlank = 0;
      for (let start = 1; start < rowCount; start += READ_CHUNK_ROWS) {
        stats.googleRequests += 1;
        const chunk = await this.google.readGrid(token, spreadsheetId, sheetId, Math.min(READ_CHUNK_ROWS, rowCount - start), width, start);
        chunk.forEach((cells, i) => {
          if (cells.some((c) => c.trim())) nonBlank += 1;
          rows.push({ rowNumber: start + i + 1, cells });
        });
        if (nonBlank > MAX_DATA_ROWS) {
          throw new SyncError(
            'SHEET_TOO_LARGE',
            `This tab has more than ${MAX_DATA_ROWS.toLocaleString('en-US')} data rows. Split it into smaller tabs to import it.`,
          );
        }
      }
      stats.rowsRead = rows.length;
      return { skipped: false, headers, rows, version };
    });
  }

  /**
   * Rows that arrived some other way than a sync — an uploaded file — written
   * exactly as a sheet's rows are: paused leads awaiting review, one tracking
   * row each, never twice. `rows` must already be deduplicated by key. Safe to
   * call again for the same source: rows it already holds are left alone.
   */
  async importRows(
    organizationId: string,
    sourceId: string,
    defaultConsent: string,
    rows: BuiltRow[],
    stats: RunStats,
    importReason: string,
    /** Rows to approve as they land; null approves nothing. */
    approve: Approval | null,
    /**
     * Load only the tracking rows for `rows`' keys, not the whole source's.
     * For callers that write a large source a page at a time (a CRM import):
     * the classification of a row never depends on any other row's tracking.
     */
    opts: { scopeToRows?: boolean } = {},
  ): Promise<void> {
    stats.dbStatements += 1;
    const tracked = (await this.prisma.sheet_import_rows.findMany({
      where: {
        organization_id: organizationId,
        lead_source_id: sourceId,
        ...(opts.scopeToRows ? { row_key: { in: rows.map((r) => r.key!) } } : {}),
      },
      select: {
        id: true,
        row_key: true,
        content_hash: true,
        review_state: true,
        lead_id: true,
        row_number: true,
        changed_after_review_at: true,
        changed_values: true,
        missing_since: true,
      },
    })) as Tracked[];
    const known = new Map(tracked.map((t) => [t.row_key, t]));
    const runPhones = new Set<string>();
    const runEmails = new Set<string>();
    for (let i = 0; i < rows.length; i += DB_BATCH) {
      await this.persistBatch(organizationId, sourceId, defaultConsent, rows.slice(i, i + DB_BATCH), known, null, runPhones, runEmails, stats, importReason, approve);
    }
  }

  /**
   * One batch, two round trips whatever its size: who the new and changed rows
   * might duplicate (and whether any opted out), then every insert and update
   * in ONE transaction.
   */
  private async persistBatch(
    organizationId: string,
    sourceId: string,
    defaultConsent: string,
    batch: BuiltRow[],
    known: Map<string, Tracked>,
    /** Set on the first read after a mapping change: the targets the new mapping fills. */
    rebaseline: Set<string> | null,
    runPhones: Set<string>,
    runEmails: Set<string>,
    stats: RunStats,
    /** The review reason every new lead starts with — which import it came from. */
    importReason: string,
    /** Which fresh rows to approve as they land, if any. */
    approve: Approval | null,
    retried = false,
  ): Promise<void> {
    const fresh: BuiltRow[] = [];
    const refresh: { row: BuiltRow; tracked: Tracked }[] = [];
    const flag: { row: BuiltRow; tracked: Tracked }[] = [];
    const rebase: { row: BuiltRow; tracked: Tracked; hadFlag: boolean }[] = [];
    const rowUpdates: { id: string; hash: string; rowNumber: number; set: ChangedValues | null; clear: boolean; requirePending: boolean }[] = [];

    // Tracking rows whose lead was deleted out of band (lead_id NULL): the row is
    // imported again onto a new lead, re-using its tracking row.
    const relink = new Map<string, string>();
    for (const b of batch) {
      const t = known.get(b.key!);
      if (!t || t.lead_id === null) {
        if (t) relink.set(b.key!, t.id);
        fresh.push(b);
        continue;
      }
      const moved = t.row_number !== b.rowNumber;
      if (moved) stats.moved += 1;
      const pendingFlag = t.changed_after_review_at ? (t.changed_values as ChangedValues | null) : null;

      // After the mapping is saved, every undecided draft is written again even
      // when its values match: what is checked about a row (its warnings) can
      // change without them. Reviewed rows are never rewritten this way.
      const redraft = rebaseline !== null && t.review_state === 'pending';
      if (t.content_hash === b.hash && !redraft) {
        // Back to the reviewed values: the flag no longer means anything.
        if (pendingFlag) {
          stats.flagsCleared += 1;
          rowUpdates.push({ id: t.id, hash: t.content_hash, rowNumber: b.rowNumber, set: null, clear: true, requirePending: false });
        } else if (moved) {
          rowUpdates.push({ id: t.id, hash: t.content_hash, rowNumber: b.rowNumber, set: null, clear: false, requirePending: false });
        }
        stats.unchanged += 1;
      } else if (t.review_state === 'pending') {
        // Still a draft nobody has decided on: take the sheet's new values.
        refresh.push({ row: b, tracked: t });
      } else if (rebaseline) {
        rebase.push({ row: b, tracked: t, hadFlag: Boolean(pendingFlag) });
      } else if (pendingFlag?.hash === b.hash) {
        // Already flagged with exactly these values.
        stats.unchanged += 1;
        if (moved) rowUpdates.push({ id: t.id, hash: t.content_hash, rowNumber: b.rowNumber, set: null, clear: false, requirePending: false });
      } else {
        flag.push({ row: b, tracked: t });
      }
    }

    // After a mapping change every hash moves, so a hash cannot tell a sheet
    // edit from a re-mapping. Compare with what the reviewed lead actually
    // holds instead: a real difference in a mapped field is flagged; anything
    // else is the mapping's doing and the hash is quietly brought up to date.
    if (rebaseline && rebase.length) {
      const ids = rebase.map((r) => r.tracked.lead_id).filter((id): id is string => !!id);
      stats.dbStatements += 1;
      const current = await this.prisma.leads.findMany({
        where: { organization_id: organizationId, id: { in: ids } },
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
        },
      });
      const byId = new Map(current.map((l) => [l.id, l as Record<string, unknown>]));
      for (const r of rebase) {
        const lead = r.tracked.lead_id ? byId.get(r.tracked.lead_id) : undefined;
        if (lead && materialDiffers(lead, r.row.lead!, rebaseline)) {
          flag.push({ row: r.row, tracked: r.tracked });
        } else {
          stats.rebaselined += 1;
          rowUpdates.push({ id: r.tracked.id, hash: r.row.hash!, rowNumber: r.row.rowNumber, set: null, clear: r.hadFlag, requirePending: false });
        }
      }
    }

    // Who these contacts already are: duplicates, opt-outs, and — for rows
    // being refreshed — the lead's own current DNC flag (never cleared here).
    const needContact = [...fresh, ...refresh.map((r) => r.row), ...flag.map((f) => f.row)];
    const phones = [...new Set(needContact.map((b) => b.lead!.normalized_phone).filter((p): p is string => !!p))];
    const emails = [...new Set(needContact.map((b) => b.lead!.normalized_email).filter((e): e is string => !!e))];
    const ownLeadIds = refresh.map((r) => r.tracked.lead_id).filter((id): id is string => !!id);
    let contacts: { id: string; normalized_phone: string | null; normalized_email: string | null; dnc_status: boolean }[] = [];
    if (phones.length || emails.length || ownLeadIds.length) {
      stats.dbStatements += 1;
      contacts = await this.prisma.leads.findMany({
        where: {
          organization_id: organizationId,
          OR: [
            ...(phones.length ? [{ normalized_phone: { in: phones } }] : []),
            ...(emails.length ? [{ normalized_email: { in: emails } }] : []),
            ...(ownLeadIds.length ? [{ id: { in: ownLeadIds } }] : []),
          ],
        },
        select: { id: true, normalized_phone: true, normalized_email: true, dnc_status: true },
      });
    }
    const ownDnc = new Map(contacts.map((c) => [c.id, c.dnc_status]));
    const assess = (l: LeadFields, self: string | null) => {
      const p = l.normalized_phone;
      const e = l.normalized_email;
      const others = contacts.filter((c) => c.id !== self && ((p && c.normalized_phone === p) || (e && c.normalized_email === e)));
      const dnc = others.some((c) => c.dnc_status) || Boolean(self && ownDnc.get(self));
      const duplicate = others.length > 0 || Boolean((p && runPhones.has(p)) || (e && runEmails.has(e)));
      if (p) runPhones.add(p);
      if (e) runEmails.add(e);
      return { dnc, duplicate };
    };
    const reasons = (dnc: boolean, duplicate: boolean, rest: string[]) => [
      importReason,
      ...(dnc ? [DNC_REASON] : []),
      ...(duplicate ? [DUPLICATE_REASON] : []),
      ...rest,
    ];

    const leads: Prisma.leadsCreateManyInput[] = [];
    const tracking: Prisma.sheet_import_rowsCreateManyInput[] = [];
    const relinks: Prisma.Sql[] = [];
    const toApprove: string[] = [];
    let dncCount = 0;
    let dupCount = 0;
    for (const b of fresh) {
      const l = b.lead!;
      const { dnc, duplicate } = assess(l, null);
      if (dnc) dncCount += 1;
      if (duplicate) dupCount += 1;
      const leadId = newId();
      leads.push({
        id: leadId,
        organization_id: organizationId,
        lead_source_id: sourceId,
        ...leadColumns(l, b.externalId ?? null),
        // Never from the sheet: these are ours to decide.
        status: LeadStatus.NEW,
        automation_paused: true,
        needs_review: true,
        review_reasons: reasons(dnc, duplicate, b.reviewReasons),
        // Fail safe: someone who opted out on another record stays opted out.
        dnc_status: dnc,
        consent_status: defaultConsent,
      });
      const existing = relink.get(b.key!);
      const trackingId = existing ?? newId();
      if (approve?.rule(b)) toApprove.push(trackingId);
      if (existing) {
        relinks.push(Prisma.sql`(${existing}::uuid, ${leadId}::uuid, ${b.hash!}::varchar, ${b.rowNumber}::int)`);
        continue;
      }
      tracking.push({
        id: trackingId,
        organization_id: organizationId,
        lead_source_id: sourceId,
        row_key: b.key!,
        lead_id: leadId,
        content_hash: b.hash!,
        row_number: b.rowNumber,
      });
    }

    const refreshValues: Prisma.Sql[] = [];
    for (const { row, tracked } of refresh) {
      if (!tracked.lead_id) continue;
      const { dnc, duplicate } = assess(row.lead!, tracked.lead_id);
      refreshValues.push(leadValuesRow(tracked.lead_id, row.lead!, row.externalId ?? null, reasons(dnc, duplicate, row.reviewReasons), dnc));
      rowUpdates.push({ id: tracked.id, hash: row.hash!, rowNumber: row.rowNumber, set: null, clear: false, requirePending: true });
    }
    for (const { row, tracked } of flag) {
      const { dnc, duplicate } = assess(row.lead!, tracked.lead_id);
      const changed: ChangedValues = {
        hash: row.hash!,
        lead: row.lead!,
        externalId: row.externalId ?? null,
        dnc,
        reviewReasons: reasons(dnc, duplicate, row.reviewReasons).filter((r) => r !== importReason),
        ...(row.crmPrefix ? { crmPrefix: row.crmPrefix } : {}),
      };
      // The reviewed hash stays: it is what the lead still holds.
      rowUpdates.push({ id: tracked.id, hash: tracked.content_hash, rowNumber: row.rowNumber, set: changed, clear: false, requirePending: false });
    }

    const statements: Prisma.PrismaPromise<unknown>[] = [];
    if (leads.length) statements.push(this.prisma.leads.createMany({ data: leads }));
    if (tracking.length) statements.push(this.prisma.sheet_import_rows.createMany({ data: tracking }));
    if (relinks.length) {
      // Back to an undecided draft on its new lead: the old decision was about a lead that no longer exists.
      statements.push(this.prisma.$executeRaw`
        UPDATE sheet_import_rows AS r
           SET lead_id = v.lead_id, content_hash = v.hash, row_number = v.row_number,
               review_state = 'pending', reviewed_by = NULL, reviewed_at = NULL,
               changed_after_review_at = NULL, changed_values = NULL, missing_since = NULL, updated_at = now()
          FROM (VALUES ${Prisma.join(relinks)}) AS v(id, lead_id, hash, row_number)
         WHERE r.id = v.id AND r.organization_id = ${organizationId}::uuid AND r.lead_id IS NULL`);
    }
    if (refreshValues.length) {
      // Re-checks review_state at write time: a row approved meanwhile keeps
      // the values the owner approved.
      statements.push(this.prisma.$executeRaw`
        UPDATE leads AS l
           SET first_name = v.first_name, last_name = v.last_name,
               email = v.email, normalized_email = v.normalized_email, email_valid = v.email_valid,
               phone = v.phone, normalized_phone = v.normalized_phone, phone_valid = v.phone_valid,
               location = v.location, min_budget = v.min_budget, max_budget = v.max_budget,
               bedrooms = v.bedrooms, motivation = v.motivation, custom_fields = v.custom_fields,
               external_lead_id = v.external_lead_id, review_reasons = v.review_reasons,
               needs_review = true, dnc_status = l.dnc_status OR v.dnc, updated_at = now()
          FROM (VALUES ${Prisma.join(refreshValues)}) AS v(id, first_name, last_name, email, normalized_email, email_valid,
               phone, normalized_phone, phone_valid, location, min_budget, max_budget, bedrooms, motivation,
               custom_fields, external_lead_id, review_reasons, dnc),
               sheet_import_rows AS r
         WHERE l.id = v.id AND l.organization_id = ${organizationId}::uuid
           AND r.lead_id = l.id AND r.organization_id = ${organizationId}::uuid AND r.review_state = 'pending'`);
    }
    if (rowUpdates.length) {
      const values = rowUpdates.map(
        (u) =>
          Prisma.sql`(${u.id}::uuid, ${u.hash}::varchar, ${u.rowNumber}::int, ${u.set ? JSON.stringify(u.set) : null}::jsonb, ${u.clear}::boolean, ${u.requirePending}::boolean)`,
      );
      statements.push(this.prisma.$executeRaw`
        UPDATE sheet_import_rows AS r
           SET content_hash = v.hash, row_number = v.row_number,
               changed_after_review_at = CASE WHEN v.cv IS NOT NULL THEN COALESCE(r.changed_after_review_at, now())
                                              WHEN v.clear THEN NULL ELSE r.changed_after_review_at END,
               changed_values = CASE WHEN v.cv IS NOT NULL THEN v.cv WHEN v.clear THEN NULL ELSE r.changed_values END,
               updated_at = now()
          FROM (VALUES ${Prisma.join(values)}) AS v(id, hash, row_number, cv, clear, require_pending)
         WHERE r.id = v.id AND r.organization_id = ${organizationId}::uuid
           AND (NOT v.require_pending OR r.review_state = 'pending')`);
    }
    if (statements.length === 0) return;

    try {
      stats.dbStatements += statements.length;
      await this.prisma.$transaction(statements);
    } catch (err) {
      // Another run imported some of these rows between our read and our
      // insert. The whole batch rolled back together; re-read and retry once.
      if (!retried && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        stats.dbStatements += 1;
        const again = await this.prisma.sheet_import_rows.findMany({
          where: { organization_id: organizationId, lead_source_id: sourceId, row_key: { in: batch.map((b) => b.key!) } },
        });
        for (const t of again) known.set(t.row_key, t as Tracked);
        return this.persistBatch(organizationId, sourceId, defaultConsent, batch, known, rebaseline, runPhones, runEmails, stats, importReason, approve, true);
      }
      throw err;
    }
    stats.inserted += fresh.length;
    stats.relinked += relinks.length;
    stats.updated += refreshValues.length;
    stats.flagged += flag.length;
    stats.dncInherited += dncCount;
    stats.possibleDuplicates += dupCount;

    // The rows the owner ticked are approved as they land — the same rules as
    // the owner's click in Import Review. Everything else waits there.
    if (toApprove.length > 0 && approve) {
      const by = approve.by;
      stats.dbStatements += 1;
      const r = await this.prisma.$transaction((tx) => approveTrackingRows(tx, organizationId, toApprove, by));
      stats.autoApproved += r.approved;
      stats.autoReleased += r.released;
      stats.autoHeld.push(...r.held);
    }
  }

  // -------------------------------------------------------------------------
  // Recording the outcome — only while this run still holds the lease
  // -------------------------------------------------------------------------

  private async finishOk(c: Claimed, claimedAt: Date, stats: RunStats, started: number, r: RunResult): Promise<void> {
    const durationMs = Date.now() - started;
    const next = this.periodic ? new Date(Date.now() + jitter(this.intervalMs)) : null;
    const released = await this.unscoped.$executeRaw`
      UPDATE lead_sources
         SET sync_locked_at = NULL, sync_locked_by = NULL,
             -- A sync requested while this one ran stays requested.
             sync_next_at = CASE WHEN sync_next_at > ${claimedAt.toISOString()}::timestamptz THEN sync_next_at
                                 ELSE ${next ? next.toISOString() : null}::timestamptz END,
             sync_failures = 0,
             last_success_at = now(),
             remote_synced_at = CASE WHEN ${r.fullRead} THEN now() ELSE remote_synced_at END,
             remote_error_code = NULL, remote_error_message = NULL,
             schema_fingerprint = COALESCE(${r.fingerprint}, schema_fingerprint),
             sync_remote_version = ${r.versionToken}
       WHERE id = ${c.id}::uuid AND organization_id = ${c.organization_id}::uuid AND sync_locked_by = ${this.instanceId}`;
    if (released === 0) this.logger.warn(`sheet sync ${c.id}: lease lost before the result was recorded`);

    // The audit log is immutable, so it records runs that changed something —
    // plus the first run and the re-baseline after a mapping change — not every
    // quiet five-minute check. Those are visible as last_success_at.
    if (stats.eventful || r.firstRun || r.rebaseline) {
      await this.audit(c, 'sheet_sync.completed', stats.summary(durationMs), durationMs);
    }
    if (stats.inserted > 0) this.events.publish({ organizationId: c.organization_id, type: 'lead.created', leadSourceId: c.id });
    this.logger.log(
      stats.probeSkipped
        ? `sheet sync ${c.id}: unchanged (Drive version), not read — ${durationMs}ms`
        : `sheet sync ${c.id}: ${stats.inserted} imported (${stats.autoApproved} approved), ${stats.updated} refreshed, ${stats.flagged} flagged, ` +
            `${stats.unchanged} unchanged, ${stats.missingMarked} missing, ` +
            `${Object.values(stats.skipped).reduce((a, b) => a + (b ?? 0), 0)} skipped in ${durationMs}ms ` +
            `(${stats.googleRequests} Google, ${stats.dbStatements} DB)`,
    );
  }

  private async finishFailed(c: Claimed, claimedAt: Date, stats: RunStats, started: number, err: unknown): Promise<void> {
    const durationMs = Date.now() - started;
    const { code, message } = describe(err);
    const permanent = PERMANENT.has(code);
    // Transient: retry with exponential backoff and jitter, whatever the cause —
    // a rate limit, a Google outage, a dropped connection.
    const retryAt = permanent ? null : new Date(Date.now() + jitter(Math.min(BACKOFF_BASE_MS * 2 ** c.sync_failures, BACKOFF_MAX_MS)));
    if (code === 'INTERNAL') this.logger.error(`sheet sync ${c.id} failed: ${(err as Error)?.stack ?? String(err)}`);
    else this.logger.warn(`sheet sync ${c.id} failed: ${code}${permanent ? ' (paused)' : `, retry at ${retryAt!.toISOString()}`}`);

    try {
      await this.unscoped.$executeRaw`
        UPDATE lead_sources
           SET sync_locked_at = NULL, sync_locked_by = NULL,
               sync_next_at = CASE WHEN sync_next_at > ${claimedAt.toISOString()}::timestamptz AND NOT ${permanent} THEN sync_next_at
                                   ELSE ${retryAt ? retryAt.toISOString() : null}::timestamptz END,
               sync_failures = sync_failures + 1,
               last_failure_at = now(),
               remote_error_code = ${code},
               remote_error_message = ${message.slice(0, 300)},
               ingest_status = CASE WHEN ${permanent} THEN 'PAUSED' ELSE ingest_status END,
               mapping_status = CASE WHEN ${code === 'HEADERS_CHANGED'} THEN 'NEEDS_REVIEW' ELSE mapping_status END
         WHERE id = ${c.id}::uuid AND organization_id = ${c.organization_id}::uuid AND sync_locked_by = ${this.instanceId}`;
      await this.audit(
        c,
        'sheet_sync.failed',
        { code, permanent, retryAt: retryAt?.toISOString() ?? null, rateLimited: code === 'GOOGLE_RATE_LIMITED', ...stats.summary(durationMs) },
        durationMs,
      );
    } catch (e) {
      this.logger.error(`sheet sync ${c.id}: could not record failure: ${(e as Error).message}`);
    }
  }

  private async audit(c: Claimed, action: string, payload: object, durationMs: number): Promise<void> {
    await this.prisma.audit_logs.create({
      data: {
        id: newId(),
        organization_id: c.organization_id,
        actor_type: 'system',
        action,
        entity_type: 'lead_source',
        entity_id: c.id,
        payload: payload as Prisma.InputJsonValue,
        response_time_ms: durationMs,
      },
    });
  }
}

/**
 * For a preview: which rows share a phone or email with a lead this
 * organization already has (pending imports included), or with an earlier row
 * of the same sheet or file — and which match someone who opted out. The import
 * itself re-checks all of this when it writes.
 */
export async function contactFlags(prisma: GuardedPrisma, organizationId: string, candidates: BuiltRow[]) {
  const phones = [...new Set(candidates.map((b) => b.lead!.normalized_phone).filter((p): p is string => !!p))];
  const emails = [...new Set(candidates.map((b) => b.lead!.normalized_email).filter((e): e is string => !!e))];
  const known = { phones: new Map<string, boolean>(), emails: new Map<string, boolean>() };
  for (const [field, values, into] of [
    ['normalized_phone', phones, known.phones],
    ['normalized_email', emails, known.emails],
  ] as const) {
    for (let i = 0; i < values.length; i += CONTACT_CHUNK) {
      const found = await prisma.leads.findMany({
        where: { organization_id: organizationId, [field]: { in: values.slice(i, i + CONTACT_CHUNK) } },
        select: { normalized_phone: true, normalized_email: true, dnc_status: true },
      });
      for (const f of found) {
        const v = f[field];
        if (v) into.set(v, (into.get(v) ?? false) || f.dnc_status);
      }
    }
  }
  const inFile = { phones: new Set<string>(), emails: new Set<string>() };
  const reasons = new Map<number, string[]>();
  let possible = 0;
  let optedOut = 0;
  for (const b of candidates) {
    const p = b.lead!.normalized_phone;
    const e = b.lead!.normalized_email;
    const dnc = Boolean((p && known.phones.get(p)) || (e && known.emails.get(e)));
    const duplicate = Boolean(
      (p && (known.phones.has(p) || inFile.phones.has(p))) || (e && (known.emails.has(e) || inFile.emails.has(e))),
    );
    if (p) inFile.phones.add(p);
    if (e) inFile.emails.add(e);
    if (dnc) optedOut += 1;
    if (duplicate) possible += 1;
    const why = [...(dnc ? [DNC_REASON] : []), ...(duplicate ? [DUPLICATE_REASON] : [])];
    if (why.length) reasons.set(b.rowNumber, why);
  }
  return { possible, optedOut, reasons };
}

/** The lead columns a sheet row fills. Shared by insert, refresh and "apply change". */
export function leadColumns(l: LeadFields, externalId: string | null) {
  return {
    first_name: l.first_name,
    last_name: l.last_name,
    email: l.email,
    normalized_email: l.normalized_email,
    email_valid: l.email_valid,
    phone: l.phone,
    normalized_phone: l.normalized_phone,
    phone_valid: l.phone_valid,
    location: l.location,
    min_budget: l.min_budget,
    max_budget: l.max_budget,
    bedrooms: l.bedrooms,
    motivation: l.motivation,
    custom_fields: l.custom_fields as Prisma.InputJsonValue,
    external_lead_id: externalId ? externalId.slice(0, 255) : null,
  };
}

/** One typed VALUES row for a bulk lead update; every value cast, since NULLs carry no type. */
export function leadValuesRow(leadId: string, l: LeadFields, externalId: string | null, reviewReasons: string[], dnc: boolean): Prisma.Sql {
  return Prisma.sql`(${leadId}::uuid, ${l.first_name}::varchar, ${l.last_name}::varchar, ${l.email}::varchar,
    ${l.normalized_email}::varchar, ${l.email_valid}::boolean, ${l.phone}::varchar, ${l.normalized_phone}::varchar,
    ${l.phone_valid}::boolean, ${l.location}::varchar, ${l.min_budget}::numeric, ${l.max_budget}::numeric,
    ${l.bedrooms}::int, ${l.motivation}::text, ${JSON.stringify(l.custom_fields)}::jsonb,
    ${externalId ? externalId.slice(0, 255) : null}::varchar, ${reviewReasons}::text[], ${dnc}::boolean)`;
}

/** Lead fields whose difference is a real change, not a mapping artifact. Custom fields are not among them. */
const MATERIAL_FIELDS = [
  'first_name',
  'last_name',
  'phone',
  'email',
  'location',
  'min_budget',
  'max_budget',
  'bedrooms',
  'motivation',
] as const;

/** Does the sheet now say something different from the lead, in a field the mapping fills? */
export function materialDiffers(lead: Record<string, unknown>, incoming: LeadFields, mappedTargets: Set<string>): boolean {
  const norm = (v: unknown): string | number | null => {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Prisma.Decimal) return v.toNumber();
    if (typeof v === 'number') return v;
    return String(v).trim();
  };
  return MATERIAL_FIELDS.some(
    (f) => mappedTargets.has(f) && norm(lead[f]) !== norm((incoming as unknown as Record<string, unknown>)[f]),
  );
}

/** ±20%, so sources configured together do not stay in lockstep. */
function jitter(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

/** A stable code and a message safe to show the owner. Unknown errors say nothing specific. */
function describe(err: unknown): { code: string; message: string } {
  if (err instanceof SyncError) return { code: err.code, message: err.message };
  if (err instanceof HttpException) {
    const body = err.getResponse() as { error?: { code?: string; message?: string } };
    return { code: body?.error?.code ?? 'GOOGLE_REQUEST_FAILED', message: body?.error?.message ?? 'Google request failed.' };
  }
  if (err instanceof GoogleApiError) return { code: `GOOGLE_${err.kind}`, message: err.message };
  return { code: 'INTERNAL', message: 'The import failed unexpectedly. It is safe to run it again.' };
}
