import { HttpException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConnectionMethod, LeadSourceProvider, LeadStatus, Prisma, type ConsentStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AuditService } from '@/audit/audit.service';
import { PrismaService } from '@/common/prisma/prisma.service';
import type { IntegrationEnv } from '@/common/utils/interface';
import { EventsBus } from '@/events/events.bus';
import { approveTrackingRows } from './approval';
import { GoogleConnectionsService } from './google-connections.service';
import { GoogleApiError, GoogleClient, SPREADSHEET_MIME } from './google.client';
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

export const DNC_REASON = 'This contact previously opted out — imported as do-not-contact';
export const DUPLICATE_REASON = 'Possible duplicate: another lead has the same phone or email';
export const READ_CHUNK_ROWS = 2_000;

const DB_BATCH = 500;
const CONTACT_CHUNK = 2_000;
const LEASE_STUCK_SECONDS = 600;
const ERROR_SAMPLE_LIMIT = 50;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 3_600_000;
const ID_CHUNK = 1_000;
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

export class SyncError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SyncError';
  }
}

export interface Approval {
  /** Decides each new row; `flags` is this import's own duplicate / do-not-contact verdict on it. */
  rule: (row: BuiltRow, flags: { dnc: boolean; duplicate: boolean }) => boolean;
  /** The owner who approved; null when a sync approves on its own (a connected CRM). */
  by: { userId: string | null };
}

export interface ChangedValues {
  hash: string;
  lead: LeadFields;
  externalId: string | null;
  dnc: boolean;
  reviewReasons: string[];
  /** A CRM row's custom-field prefix (BuiltRow.crmPrefix): applying writes only the CRM's fields. */
  crmPrefix?: string;
}

export class RunStats {
  googleRequests = 0;
  dbStatements = 0;
  rowsRead = 0;
  blank = 0;
  inserted = 0;
  unchanged = 0;
  updated = 0;
  flagged = 0;
  flagsCleared = 0;
  rebaselined = 0;
  moved = 0;
  missingMarked = 0;
  reappeared = 0;
  dncInherited = 0;
  possibleDuplicates = 0;
  autoApproved = 0;
  autoReleased = 0;
  autoHeld: { rowId: string; leadId: string; reason: string }[] = [];
  relinked = 0;
  probeSkipped = false;
  skipped: Partial<Record<RowIssue, number>> = {};
  errorSample: { row: number; code: RowIssue }[] = [];

  constructor(readonly queueDelayMs: number) {}

  skip(row: number, code: RowIssue): void {
    this.skipped[code] = (this.skipped[code] ?? 0) + 1;
    if (this.errorSample.length < ERROR_SAMPLE_LIMIT) this.errorSample.push({ row, code });
  }

  get eventful(): boolean {
    return this.inserted + this.updated + this.flagged + this.flagsCleared + this.rebaselined + this.missingMarked + this.reappeared > 0;
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
  rowKey: string;
  contentHash: string;
  reviewState: string;
  leadId: string | null;
  rowNumber: number;
  changedAfterReviewAt: Date | null;
  changedValues: unknown;
  missingSince: Date | null;
}

interface RunResult {
  fullRead: boolean;
  firstRun: boolean;
  rebaseline: boolean;
  fingerprint: string | null;
  versionToken: string | null;
}

const TRACKED_FIELDS = {
  id: true,
  rowKey: true,
  contentHash: true,
  reviewState: true,
  leadId: true,
  rowNumber: true,
  changedAfterReviewAt: true,
  changedValues: true,
  missingSince: true,
} satisfies Prisma.SheetImportRowSelect;

/**
 * Imports Google Sheets rows into leads. Each source is claimed with a lease
 * (FOR UPDATE SKIP LOCKED) so instances never sync one sheet twice. New rows
 * become leads held for owner review; a reviewed row that changes in the sheet
 * is flagged rather than overwriting the lead.
 */
@Injectable()
export class SheetImportService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('SheetImport');
  private readonly instanceId = `sheets-${randomUUID()}`;
  private draining: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: GoogleConnectionsService,
    private readonly google: GoogleClient,
    private readonly events: EventsBus,
    private readonly audit: AuditService,
    private readonly config: ConfigService<IntegrationEnv, true>,
  ) {}

  private get enabled(): boolean {
    return this.config.get('GOOGLE_SHEETS_ENABLED', { infer: true });
  }

  private get periodic(): boolean {
    return this.config.get('SHEETS_SYNC', { infer: true });
  }

  private get intervalMs(): number {
    return this.config.get('SHEETS_SYNC_INTERVAL_MS', { infer: true });
  }

  onModuleInit(): void {
    if (!this.enabled || !this.periodic) return;
    this.timer = setInterval(() => this.nudge(), this.config.get('SHEETS_POLL_MS', { infer: true }));
    this.timer.unref();
    this.nudge();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  nudge(): void {
    void this.drain();
  }

  drain(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
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
    } catch (error) {
      this.logger.error(`sheet import loop failed: ${(error as Error).message}`);
    }
  }

  private async claim(only: { orgId: string; sourceId: string } | null = null): Promise<Claimed | null> {
    const rows = await this.prisma.$queryRaw<Claimed[]>`
      WITH due AS (
        SELECT id FROM lead_sources
         WHERE connection_method = 'SYNC' AND provider = 'GOOGLE_SHEETS'
           AND is_active AND archived_at IS NULL AND ingest_status = 'ACTIVE'
           AND sync_next_at <= now()
           AND (sync_locked_at IS NULL OR sync_locked_at < now() - make_interval(secs => ${LEASE_STUCK_SECONDS}))
           ${only ? Prisma.sql`AND id = ${only.sourceId}::uuid AND organization_id = ${only.orgId}::uuid` : Prisma.empty}
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
    } catch (error) {
      await this.finishFailed(c, claimedAt, stats, started, error);
      return { ok: false, stats };
    }
  }

  /** The first run when an owner switches a sheet on, with the rows they ticked approved straight away. */
  async runNow(orgId: string, sourceId: string, approve: Approval): Promise<{ ok: boolean; stats: RunStats } | null> {
    if (!this.enabled || this.stopped) return null;
    const claimed = await this.claim({ orgId, sourceId });
    return claimed ? this.run(claimed, approve) : null;
  }

  private async importOnce(orgId: string, sourceId: string, stats: RunStats, approve: Approval | null): Promise<RunResult> {
    stats.dbStatements += 1;
    const source = await this.prisma.leadSource.findFirst({
      where: { id: sourceId, orgId, provider: LeadSourceProvider.GOOGLE_SHEETS, connectionMethod: ConnectionMethod.SYNC },
      select: {
        integrationId: true,
        externalFormId: true,
        mappingStatus: true,
        mappingVersion: true,
        syncRowKeyField: true,
        syncFallbackAckAt: true,
        syncRemoteVersion: true,
        remoteSyncedAt: true,
        lastSuccessAt: true,
        defaultConsentStatus: true,
      },
    });
    const [spreadsheetId, sheetIdText] = (source?.externalFormId ?? '').split(':');
    const sheetId = Number(sheetIdText);
    if (!source?.integrationId || !spreadsheetId || !Number.isInteger(sheetId)) {
      throw new SyncError('NOT_CONFIGURED', 'This source has no Google connection or spreadsheet.');
    }
    if (source.mappingStatus !== 'CONFIGURED') throw new SyncError('NOT_CONFIGURED', 'Map the columns before importing.');
    const identity: Identity | null = source.syncRowKeyField
      ? { mode: 'column', fieldKey: source.syncRowKeyField }
      : source.syncFallbackAckAt
        ? { mode: 'fallback' }
        : null;
    if (!identity) throw new SyncError('NOT_CONFIGURED', 'Choose a unique ID column, or acknowledge the fallback identity.');

    const [lastVersion, lastMapping] = (source.syncRemoteVersion ?? '').split(':');
    const rebaseline = lastMapping !== String(source.mappingVersion);
    stats.dbStatements += 2;
    const [mappingRows, settings] = await Promise.all([
      this.prisma.leadSourceFieldMapping.findMany({
        where: { orgId, leadSourceId: sourceId, isActive: true },
        select: { sourceFieldKey: true, targetField: true, transform: true },
      }),
      this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { defaultRegion: true } }),
    ]);
    const mappings = toStored(mappingRows);
    if (mappings.length === 0) throw new SyncError('NOT_CONFIGURED', 'Map the columns before importing.');
    const region = settings?.defaultRegion ?? 'US';

    let orphans = 0;
    if (this.config.get('SHEETS_VERSION_PROBE', { infer: true })) {
      stats.dbStatements += 1;
      orphans = await this.prisma.sheetImportRow.count({ where: { orgId, leadSourceId: sourceId, leadId: null } });
    }
    const sheet = await this.readTab(
      orgId,
      source.integrationId,
      spreadsheetId,
      sheetId,
      mappings,
      identity,
      stats,
      rebaseline || orphans > 0 ? null : lastVersion || null,
      source.remoteSyncedAt,
    );
    const versionToken = sheet.version === null ? null : `${sheet.version}:${source.mappingVersion}`;
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

    stats.dbStatements += 1;
    const tracked = await this.prisma.sheetImportRow.findMany({ where: { orgId, leadSourceId: sourceId }, select: TRACKED_FIELDS });
    const known = new Map(tracked.map((t) => [t.rowKey, t]));
    const runPhones = new Set<string>();
    const runEmails = new Set<string>();
    const mappedTargets = new Set(mappings.map((m) => m.target_field));
    for (let i = 0; i < candidates.length; i += DB_BATCH) {
      await this.persistBatch(
        orgId,
        sourceId,
        source.defaultConsentStatus,
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

    const now = new Date();
    const toMark = tracked.filter((t) => !t.missingSince && !present.has(t.rowKey)).map((t) => t.id);
    const toClear = tracked.filter((t) => t.missingSince && present.has(t.rowKey)).map((t) => t.id);
    for (const [ids, value] of [
      [toMark, now],
      [toClear, null],
    ] as const) {
      for (let i = 0; i < ids.length; i += ID_CHUNK) {
        stats.dbStatements += 1;
        await this.prisma.sheetImportRow.updateMany({
          where: { orgId, id: { in: ids.slice(i, i + ID_CHUNK) } },
          data: { missingSince: value },
        });
      }
    }
    stats.missingMarked = toMark.length;
    stats.reappeared = toClear.length;
    return { fullRead: true, firstRun: !source.lastSuccessAt, rebaseline, fingerprint: headerFingerprint(sheet.headers), versionToken };
  }

  private async readTab(
    orgId: string,
    integrationId: string,
    spreadsheetId: string,
    sheetId: number,
    mappings: StoredMapping[],
    identity: Identity,
    stats: RunStats,
    lastVersion: string | null,
    lastFullRead: Date | null,
  ): Promise<{ skipped: boolean; headers: SheetHeader[]; rows: { rowNumber: number; cells: string[] }[]; version: string | null }> {
    return this.connections.withAccessToken(orgId, integrationId, async (token) => {
      stats.googleRequests += 1;
      const file = await this.google.driveFile(token, spreadsheetId);
      if (file.trashed) throw new GoogleApiError('NOT_FOUND', 'The spreadsheet is in the trash', 404);
      if (file.mimeType !== SPREADSHEET_MIME) {
        throw new SyncError('GOOGLE_NOT_A_SPREADSHEET', 'The connected file is no longer a Google Sheets spreadsheet.');
      }
      const version = file.version ?? null;
      const maxAge = this.config.get('SHEETS_FULL_READ_MAX_AGE_MS', { infer: true });
      if (
        this.config.get('SHEETS_VERSION_PROBE', { infer: true }) &&
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

  /** File uploads reuse the same row tracking, review and duplicate checks as a sheet sync. */
  async importRows(
    orgId: string,
    sourceId: string,
    defaultConsent: ConsentStatus,
    rows: BuiltRow[],
    stats: RunStats,
    importReason: string,
    approve: Approval | null,
    /** Load only the tracking rows for `rows`' keys: for a CRM import written a page at a time. */
    opts: { scopeToRows?: boolean } = {},
  ): Promise<void> {
    stats.dbStatements += 1;
    const tracked = await this.prisma.sheetImportRow.findMany({
      where: { orgId, leadSourceId: sourceId, ...(opts.scopeToRows ? { rowKey: { in: rows.map((r) => r.key!) } } : {}) },
      select: TRACKED_FIELDS,
    });
    const known = new Map(tracked.map((t) => [t.rowKey, t]));
    const runPhones = new Set<string>();
    const runEmails = new Set<string>();
    for (let i = 0; i < rows.length; i += DB_BATCH) {
      await this.persistBatch(orgId, sourceId, defaultConsent, rows.slice(i, i + DB_BATCH), known, null, runPhones, runEmails, stats, importReason, approve);
    }
  }

  private async persistBatch(
    orgId: string,
    sourceId: string,
    defaultConsent: ConsentStatus,
    batch: BuiltRow[],
    known: Map<string, Tracked>,
    rebaseline: Set<string> | null,
    runPhones: Set<string>,
    runEmails: Set<string>,
    stats: RunStats,
    importReason: string,
    approve: Approval | null,
    retried = false,
  ): Promise<void> {
    const fresh: BuiltRow[] = [];
    const refresh: { row: BuiltRow; tracked: Tracked }[] = [];
    const flag: { row: BuiltRow; tracked: Tracked }[] = [];
    const rebase: { row: BuiltRow; tracked: Tracked; hadFlag: boolean }[] = [];
    const rowUpdates: { id: string; hash: string; rowNumber: number; set: ChangedValues | null; clear: boolean; requirePending: boolean }[] = [];
    const relink = new Map<string, string>();

    for (const b of batch) {
      const t = known.get(b.key!);
      if (!t || t.leadId === null) {
        if (t) relink.set(b.key!, t.id);
        fresh.push(b);
        continue;
      }
      const moved = t.rowNumber !== b.rowNumber;
      if (moved) stats.moved += 1;
      const pendingFlag = t.changedAfterReviewAt ? (t.changedValues as ChangedValues | null) : null;
      const redraft = rebaseline !== null && t.reviewState === 'pending';
      if (t.contentHash === b.hash && !redraft) {
        if (pendingFlag) {
          stats.flagsCleared += 1;
          rowUpdates.push({ id: t.id, hash: t.contentHash, rowNumber: b.rowNumber, set: null, clear: true, requirePending: false });
        } else if (moved) {
          rowUpdates.push({ id: t.id, hash: t.contentHash, rowNumber: b.rowNumber, set: null, clear: false, requirePending: false });
        }
        stats.unchanged += 1;
      } else if (t.reviewState === 'pending') {
        refresh.push({ row: b, tracked: t });
      } else if (rebaseline) {
        rebase.push({ row: b, tracked: t, hadFlag: Boolean(pendingFlag) });
      } else if (pendingFlag?.hash === b.hash) {
        stats.unchanged += 1;
        if (moved) rowUpdates.push({ id: t.id, hash: t.contentHash, rowNumber: b.rowNumber, set: null, clear: false, requirePending: false });
      } else {
        flag.push({ row: b, tracked: t });
      }
    }

    if (rebaseline && rebase.length) {
      const ids = rebase.map((r) => r.tracked.leadId).filter((id): id is string => !!id);
      stats.dbStatements += 1;
      const current = await this.prisma.lead.findMany({
        where: { orgId, id: { in: ids } },
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
        },
      });
      const byId = new Map(
        current.map((l) => [
          l.id,
          {
            first_name: l.firstName,
            last_name: l.lastName,
            phone: l.phone,
            email: l.email,
            location: l.location,
            min_budget: l.minBudget,
            max_budget: l.maxBudget,
            bedrooms: l.bedrooms,
            motivation: l.motivation,
          } as Record<string, unknown>,
        ]),
      );
      for (const r of rebase) {
        const lead = r.tracked.leadId ? byId.get(r.tracked.leadId) : undefined;
        if (lead && materialDiffers(lead, r.row.lead!, rebaseline)) {
          flag.push({ row: r.row, tracked: r.tracked });
        } else {
          stats.rebaselined += 1;
          rowUpdates.push({ id: r.tracked.id, hash: r.row.hash!, rowNumber: r.row.rowNumber, set: null, clear: r.hadFlag, requirePending: false });
        }
      }
    }

    const needContact = [...fresh, ...refresh.map((r) => r.row), ...flag.map((f) => f.row)];
    const phones = [...new Set(needContact.map((b) => b.lead!.normalized_phone).filter((p): p is string => !!p))];
    const emails = [...new Set(needContact.map((b) => b.lead!.normalized_email).filter((e): e is string => !!e))];
    const ownLeadIds = refresh.map((r) => r.tracked.leadId).filter((id): id is string => !!id);
    let contacts: { id: string; normalizedPhone: string | null; normalizedEmail: string | null; dncStatus: boolean }[] = [];
    if (phones.length || emails.length || ownLeadIds.length) {
      stats.dbStatements += 1;
      contacts = await this.prisma.lead.findMany({
        where: {
          orgId,
          OR: [
            ...(phones.length ? [{ normalizedPhone: { in: phones } }] : []),
            ...(emails.length ? [{ normalizedEmail: { in: emails } }] : []),
            ...(ownLeadIds.length ? [{ id: { in: ownLeadIds } }] : []),
          ],
        },
        select: { id: true, normalizedPhone: true, normalizedEmail: true, dncStatus: true },
      });
    }
    const ownDnc = new Map(contacts.map((c) => [c.id, c.dncStatus]));
    const assess = (l: LeadFields, self: string | null) => {
      const p = l.normalized_phone;
      const e = l.normalized_email;
      const others = contacts.filter((c) => c.id !== self && ((p && c.normalizedPhone === p) || (e && c.normalizedEmail === e)));
      const dnc = others.some((c) => c.dncStatus) || Boolean(self && ownDnc.get(self));
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

    const leads: Prisma.LeadCreateManyInput[] = [];
    const tracking: Prisma.SheetImportRowCreateManyInput[] = [];
    const relinks: Prisma.Sql[] = [];
    const toApprove: string[] = [];
    let dncCount = 0;
    let dupCount = 0;
    for (const b of fresh) {
      const { dnc, duplicate } = assess(b.lead!, null);
      if (dnc) dncCount += 1;
      if (duplicate) dupCount += 1;
      const leadId = randomUUID();
      leads.push({
        id: leadId,
        orgId,
        leadSourceId: sourceId,
        ...leadColumns(b.lead!, b.externalId ?? null),
        status: LeadStatus.new,
        automationPaused: true,
        needsReview: true,
        reviewReasons: reasons(dnc, duplicate, b.reviewReasons),
        dncStatus: dnc,
        consentStatus: defaultConsent,
      });
      const existing = relink.get(b.key!);
      const trackingId = existing ?? randomUUID();
      if (approve?.rule(b, { dnc, duplicate })) toApprove.push(trackingId);
      if (existing) {
        relinks.push(Prisma.sql`(${existing}::uuid, ${leadId}::uuid, ${b.hash!}::varchar, ${b.rowNumber}::int)`);
        continue;
      }
      tracking.push({ id: trackingId, orgId, leadSourceId: sourceId, rowKey: b.key!, leadId, contentHash: b.hash!, rowNumber: b.rowNumber });
    }

    const refreshValues: Prisma.Sql[] = [];
    for (const { row, tracked } of refresh) {
      if (!tracked.leadId) continue;
      const { dnc, duplicate } = assess(row.lead!, tracked.leadId);
      refreshValues.push(leadValuesRow(tracked.leadId, row.lead!, row.externalId ?? null, reasons(dnc, duplicate, row.reviewReasons), dnc));
      rowUpdates.push({ id: tracked.id, hash: row.hash!, rowNumber: row.rowNumber, set: null, clear: false, requirePending: true });
    }
    for (const { row, tracked } of flag) {
      const { dnc, duplicate } = assess(row.lead!, tracked.leadId);
      const changed: ChangedValues = {
        hash: row.hash!,
        lead: row.lead!,
        externalId: row.externalId ?? null,
        dnc,
        reviewReasons: reasons(dnc, duplicate, row.reviewReasons).filter((r) => r !== importReason),
        ...(row.crmPrefix ? { crmPrefix: row.crmPrefix } : {}),
      };
      rowUpdates.push({ id: tracked.id, hash: tracked.contentHash, rowNumber: row.rowNumber, set: changed, clear: false, requirePending: false });
    }

    const statements: Prisma.PrismaPromise<unknown>[] = [];
    if (leads.length) statements.push(this.prisma.lead.createMany({ data: leads }));
    if (tracking.length) statements.push(this.prisma.sheetImportRow.createMany({ data: tracking }));
    if (relinks.length) {
      statements.push(this.prisma.$executeRaw`
        UPDATE sheet_import_rows AS r
           SET lead_id = v.lead_id, content_hash = v.hash, row_number = v.row_number,
               review_state = 'pending', reviewed_by = NULL, reviewed_at = NULL,
               changed_after_review_at = NULL, changed_values = NULL, missing_since = NULL, updated_at = now()
          FROM (VALUES ${Prisma.join(relinks)}) AS v(id, lead_id, hash, row_number)
         WHERE r.id = v.id AND r.organization_id = ${orgId}::uuid AND r.lead_id IS NULL`);
    }
    if (refreshValues.length) {
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
         WHERE l.id = v.id AND l.organization_id = ${orgId}::uuid
           AND r.lead_id = l.id AND r.organization_id = ${orgId}::uuid AND r.review_state = 'pending'`);
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
         WHERE r.id = v.id AND r.organization_id = ${orgId}::uuid
           AND (NOT v.require_pending OR r.review_state = 'pending')`);
    }
    if (statements.length === 0) return;

    try {
      stats.dbStatements += statements.length;
      await this.prisma.$transaction(statements);
    } catch (error) {
      // Another run inserted one of these row keys first: re-read and redo the batch once.
      if (!retried && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        stats.dbStatements += 1;
        const again = await this.prisma.sheetImportRow.findMany({
          where: { orgId, leadSourceId: sourceId, rowKey: { in: batch.map((b) => b.key!) } },
          select: TRACKED_FIELDS,
        });
        for (const t of again) known.set(t.rowKey, t);
        return this.persistBatch(orgId, sourceId, defaultConsent, batch, known, rebaseline, runPhones, runEmails, stats, importReason, approve, true);
      }
      throw error;
    }
    stats.inserted += fresh.length;
    stats.relinked += relinks.length;
    stats.updated += refreshValues.length;
    stats.flagged += flag.length;
    stats.dncInherited += dncCount;
    stats.possibleDuplicates += dupCount;

    if (toApprove.length > 0 && approve) {
      stats.dbStatements += 1;
      const result = await this.prisma.$transaction((tx) => approveTrackingRows(tx, this.audit, orgId, toApprove, approve.by));
      stats.autoApproved += result.approved;
      stats.autoReleased += result.released;
      stats.autoHeld.push(...result.held);
    }
  }

  private async finishOk(c: Claimed, claimedAt: Date, stats: RunStats, started: number, r: RunResult): Promise<void> {
    const durationMs = Date.now() - started;
    const next = this.periodic ? new Date(Date.now() + jitter(this.intervalMs)) : null;
    const released = await this.prisma.$executeRaw`
      UPDATE lead_sources
         SET sync_locked_at = NULL, sync_locked_by = NULL,
             sync_next_at = CASE WHEN sync_next_at > ${claimedAt.toISOString()}::timestamptz THEN sync_next_at
                                 ELSE ${next ? next.toISOString() : null}::timestamptz END,
             sync_failures = 0,
             last_success_at = now(),
             remote_synced_at = CASE WHEN ${r.fullRead} THEN now() ELSE remote_synced_at END,
             remote_error_code = NULL, remote_error_message = NULL,
             schema_fingerprint = COALESCE(${r.fingerprint}, schema_fingerprint),
             sync_remote_version = ${r.versionToken},
             updated_at = now()
       WHERE id = ${c.id}::uuid AND organization_id = ${c.organization_id}::uuid AND sync_locked_by = ${this.instanceId}`;
    if (released === 0) this.logger.warn(`sheet sync ${c.id}: lease lost before the result was recorded`);
    if (stats.eventful || r.firstRun || r.rebaseline) {
      await this.recordRun(c, 'sheet_sync.completed', stats.summary(durationMs), durationMs);
    }
    if (stats.inserted > 0) this.events.publish({ organizationId: c.organization_id, type: 'lead.created', leadSourceId: c.id });
    this.logger.log(
      stats.probeSkipped
        ? `sheet sync ${c.id}: unchanged (Drive version), not read — ${durationMs}ms`
        : `sheet sync ${c.id}: ${stats.inserted} imported (${stats.autoApproved} approved), ${stats.updated} refreshed, ${stats.flagged} flagged, ` +
            `${stats.unchanged} unchanged, ${stats.missingMarked} missing in ${durationMs}ms`,
    );
  }

  private async finishFailed(c: Claimed, claimedAt: Date, stats: RunStats, started: number, error: unknown): Promise<void> {
    const durationMs = Date.now() - started;
    const { code, message } = describe(error);
    const permanent = PERMANENT.has(code);
    const retryAt = permanent ? null : new Date(Date.now() + jitter(Math.min(BACKOFF_BASE_MS * 2 ** c.sync_failures, BACKOFF_MAX_MS)));
    if (code === 'INTERNAL') this.logger.error(`sheet sync ${c.id} failed: ${(error as Error)?.stack ?? String(error)}`);
    else this.logger.warn(`sheet sync ${c.id} failed: ${code}${permanent ? ' (paused)' : `, retry at ${retryAt!.toISOString()}`}`);
    try {
      await this.prisma.$executeRaw`
        UPDATE lead_sources
           SET sync_locked_at = NULL, sync_locked_by = NULL,
               sync_next_at = CASE WHEN sync_next_at > ${claimedAt.toISOString()}::timestamptz AND NOT ${permanent} THEN sync_next_at
                                   ELSE ${retryAt ? retryAt.toISOString() : null}::timestamptz END,
               sync_failures = sync_failures + 1,
               last_failure_at = now(),
               remote_error_code = ${code},
               remote_error_message = ${message.slice(0, 300)},
               ingest_status = CASE WHEN ${permanent} THEN 'PAUSED'::lead_source_ingest_status ELSE ingest_status END,
               mapping_status = CASE WHEN ${code === 'HEADERS_CHANGED'} THEN 'NEEDS_REVIEW'::lead_source_mapping_status ELSE mapping_status END,
               updated_at = now()
         WHERE id = ${c.id}::uuid AND organization_id = ${c.organization_id}::uuid AND sync_locked_by = ${this.instanceId}`;
      await this.recordRun(
        c,
        'sheet_sync.failed',
        { code, permanent, retryAt: retryAt?.toISOString() ?? null, rateLimited: code === 'GOOGLE_RATE_LIMITED', ...stats.summary(durationMs) },
        durationMs,
      );
    } catch (recordError) {
      this.logger.error(`sheet sync ${c.id}: could not record failure: ${(recordError as Error).message}`);
    }
  }

  private recordRun(c: Claimed, action: string, payload: object, durationMs: number): Promise<void> {
    return this.audit.record({
      orgId: c.organization_id,
      actorType: 'system',
      action,
      entityType: 'lead_source',
      entityId: c.id,
      payload: payload as Prisma.InputJsonValue,
      durationMs,
    });
  }
}

/** Which of the candidates' phones and emails already belong to a lead, and whether that lead opted out. */
export async function contactFlags(prisma: PrismaService, orgId: string, candidates: BuiltRow[]) {
  const phones = [...new Set(candidates.map((b) => b.lead!.normalized_phone).filter((p): p is string => !!p))];
  const emails = [...new Set(candidates.map((b) => b.lead!.normalized_email).filter((e): e is string => !!e))];
  const known = { phones: new Map<string, boolean>(), emails: new Map<string, boolean>() };
  for (let i = 0; i < phones.length; i += CONTACT_CHUNK) {
    const found = await prisma.lead.findMany({
      where: { orgId, normalizedPhone: { in: phones.slice(i, i + CONTACT_CHUNK) } },
      select: { normalizedPhone: true, dncStatus: true },
    });
    for (const f of found) if (f.normalizedPhone) known.phones.set(f.normalizedPhone, (known.phones.get(f.normalizedPhone) ?? false) || f.dncStatus);
  }
  for (let i = 0; i < emails.length; i += CONTACT_CHUNK) {
    const found = await prisma.lead.findMany({
      where: { orgId, normalizedEmail: { in: emails.slice(i, i + CONTACT_CHUNK) } },
      select: { normalizedEmail: true, dncStatus: true },
    });
    for (const f of found) if (f.normalizedEmail) known.emails.set(f.normalizedEmail, (known.emails.get(f.normalizedEmail) ?? false) || f.dncStatus);
  }

  const inFile = { phones: new Set<string>(), emails: new Set<string>() };
  const reasons = new Map<number, string[]>();
  let possible = 0;
  let optedOut = 0;
  for (const b of candidates) {
    const p = b.lead!.normalized_phone;
    const e = b.lead!.normalized_email;
    const dnc = Boolean((p && known.phones.get(p)) || (e && known.emails.get(e)));
    const duplicate = Boolean((p && (known.phones.has(p) || inFile.phones.has(p))) || (e && (known.emails.has(e) || inFile.emails.has(e))));
    if (p) inFile.phones.add(p);
    if (e) inFile.emails.add(e);
    if (dnc) optedOut += 1;
    if (duplicate) possible += 1;
    const why = [...(dnc ? [DNC_REASON] : []), ...(duplicate ? [DUPLICATE_REASON] : [])];
    if (why.length) reasons.set(b.rowNumber, why);
  }
  return { possible, optedOut, reasons };
}

export function leadColumns(l: LeadFields, externalId: string | null) {
  return {
    firstName: l.first_name,
    lastName: l.last_name,
    email: l.email,
    normalizedEmail: l.normalized_email,
    emailValid: l.email_valid,
    phone: l.phone,
    normalizedPhone: l.normalized_phone,
    phoneValid: l.phone_valid,
    location: l.location,
    minBudget: l.min_budget,
    maxBudget: l.max_budget,
    bedrooms: l.bedrooms,
    motivation: l.motivation,
    customFields: l.custom_fields as Prisma.InputJsonValue,
    externalLeadId: externalId ? externalId.slice(0, 255) : null,
  };
}

export function leadValuesRow(leadId: string, l: LeadFields, externalId: string | null, reviewReasons: string[], dnc: boolean): Prisma.Sql {
  return Prisma.sql`(${leadId}::uuid, ${l.first_name}::varchar, ${l.last_name}::varchar, ${l.email}::varchar,
    ${l.normalized_email}::varchar, ${l.email_valid}::boolean, ${l.phone}::varchar, ${l.normalized_phone}::varchar,
    ${l.phone_valid}::boolean, ${l.location}::varchar, ${l.min_budget}::numeric, ${l.max_budget}::numeric,
    ${l.bedrooms}::int, ${l.motivation}::text, ${JSON.stringify(l.custom_fields)}::jsonb,
    ${externalId ? externalId.slice(0, 255) : null}::varchar, ${reviewReasons}::text[], ${dnc}::boolean)`;
}

const MATERIAL_FIELDS = ['first_name', 'last_name', 'phone', 'email', 'location', 'min_budget', 'max_budget', 'bedrooms', 'motivation'] as const;

/** After a mapping change: does the sheet now say something different about a mapped field? */
export function materialDiffers(lead: Record<string, unknown>, incoming: LeadFields, mappedTargets: Set<string>): boolean {
  const norm = (v: unknown): string | number | null => {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Prisma.Decimal) return v.toNumber();
    if (typeof v === 'number') return v;
    return String(v).trim();
  };
  return MATERIAL_FIELDS.some((f) => mappedTargets.has(f) && norm(lead[f]) !== norm((incoming as unknown as Record<string, unknown>)[f]));
}

export function toStored(rows: { sourceFieldKey: string; targetField: string; transform: Prisma.JsonValue }[]): StoredMapping[] {
  return rows.map((r) => ({ source_field_key: r.sourceFieldKey, target_field: r.targetField, transform: r.transform as unknown as StoredMapping['transform'] }));
}

function jitter(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

function describe(error: unknown): { code: string; message: string } {
  if (error instanceof SyncError) return { code: error.code, message: error.message };
  if (error instanceof HttpException) {
    const body = error.getResponse() as { error?: { code?: string; message?: string } };
    return { code: body?.error?.code ?? 'GOOGLE_REQUEST_FAILED', message: body?.error?.message ?? 'Google request failed.' };
  }
  if (error instanceof GoogleApiError) return { code: `GOOGLE_${error.kind}`, message: error.message };
  return { code: 'INTERNAL', message: 'The import failed unexpectedly. It is safe to run it again.' };
}
