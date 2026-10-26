import { HttpException, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppError } from '../../common/errors';
import { newId } from '../../common/ids';
import { TENANT_PRISMA, type GuardedPrisma } from '../../prisma/prisma.service';
import { HUBSPOT_PROVIDER } from '../crm/crm-records';
import { GOOGLE_PROVIDER, GoogleConnectionsService, type SessionIdentity } from './google-connections.service';
import { GoogleApiError, GoogleClient, SPREADSHEET_MIME } from './google.client';
import { GOOGLE_SHEETS_PROVIDER, READ_CHUNK_ROWS, SYNC_CONNECTION, SheetImportService, contactFlags, type RunStats } from './sheet-import.service';
import {
  FILE_UPLOAD_PROVIDER,
  FULL_NAME_TARGET,
  MAX_COLUMNS,
  MAX_DATA_ROWS,
  analyzeHeaders,
  buildRow,
  expandMapping,
  headerFingerprint,
  identityCandidates,
  suggestColumns,
  validateMapping,
  type ColumnMapping,
  type Identity,
  type SheetHeader,
  type StoredMapping,
} from './sheet-rows';
import type { CreateSourceBody, EnableBody, ReviewQuery, SaveMappingBody } from './schemas';

/** Rows the mapping and identity suggestions read: a sample of the first ones, as the heuristics expect (a blank row further down must not unsuggest an ID column). */
const SUGGEST_ROWS = 20;

const fail = (status: number, code: string, message: string) => new HttpException({ error: { code, message } }, status);

/** Where a reviewed row came from, as the review queue names it — sheets, uploaded files, a connected CRM. */
const REVIEW_SOURCE_PROVIDER = { google_sheets: GOOGLE_SHEETS_PROVIDER, file_upload: FILE_UPLOAD_PROVIDER, hubspot: HUBSPOT_PROVIDER } as const;
type ReviewKind = keyof typeof REVIEW_SOURCE_PROVIDER;

function reviewKind(provider: string): ReviewKind {
  const found = (Object.keys(REVIEW_SOURCE_PROVIDER) as ReviewKind[]).find((k) => REVIEW_SOURCE_PROVIDER[k] === provider);
  return found ?? 'google_sheets';
}

const SOURCE_SELECT = {
  id: true,
  name: true,
  external_form_id: true,
  external_form_name: true,
  provider_credential_id: true,
  ingest_status: true,
  mapping_status: true,
  mapping_version: true,
  sync_row_key_field: true,
  sync_fallback_ack_at: true,
  sync_next_at: true,
  sync_locked_at: true,
  last_success_at: true,
  last_failure_at: true,
  remote_error_code: true,
  remote_error_message: true,
  created_at: true,
} as const;
type SourceRow = Prisma.lead_sourcesGetPayload<{ select: typeof SOURCE_SELECT }>;

export interface SheetSourceDTO {
  id: string;
  name: string;
  spreadsheetId: string;
  sheetId: number;
  connectionId: string | null;
  /** NEEDS_MAPPING | PAUSED | ACTIVE */
  status: string | null;
  mappingStatus: string | null;
  identity: { mode: 'column'; fieldKey: string } | { mode: 'fallback' } | null;
  /** A sync is due now (owner-requested, scheduled, or a retry). */
  syncQueued: boolean;
  nextSyncAt: Date | null;
  syncing: boolean;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  pendingReview: number;
  createdAt: Date;
}

/** What "Start importing" did there and then: the first run, with the owner's ticks approved as they landed. */
export interface FirstRun {
  /** False: the run failed, and the source's lastErrorMessage says why. */
  ok: boolean;
  imported: number;
  approval: { approved: number; released: number; held: RunStats['autoHeld']; skipped: string[] };
}

/**
 * Owner-facing management of spreadsheet sources: create one for a tab,
 * preview it, save its mapping, switch it on or off, queue a sync, read its run
 * history and the review queue.
 *
 * Every lookup carries the caller's organization, so another tenant's source
 * id is simply not found. Nothing here imports rows — that is
 * SheetImportService, in the background.
 */
@Injectable()
export class SheetSourcesService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma,
    private readonly connections: GoogleConnectionsService,
    private readonly google: GoogleClient,
    private readonly importer: SheetImportService,
  ) {}

  async list(organizationId: string): Promise<SheetSourceDTO[]> {
    const [sources, pending] = await Promise.all([
      this.prisma.lead_sources.findMany({
        where: {
          organization_id: organizationId,
          provider: GOOGLE_SHEETS_PROVIDER,
          connection_method: SYNC_CONNECTION,
          archived_at: null,
        },
        select: SOURCE_SELECT,
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.sheet_import_rows.groupBy({
        by: ['lead_source_id'],
        where: { organization_id: organizationId, review_state: 'pending' },
        _count: { _all: true },
      }),
    ]);
    const counts = new Map(pending.map((p) => [p.lead_source_id, p._count._all]));
    return sources.map((s) => toDTO(s, counts.get(s.id) ?? 0));
  }

  /**
   * Create the source for one tab — or return the one that already exists, so
   * a double click or a second attempt is harmless. An ARCHIVED source for the
   * same tab is brought back rather than replaced: its tracking rows are what
   * stop the next import from creating every lead a second time.
   */
  async create(who: SessionIdentity, body: CreateSourceBody): Promise<SheetSourceDTO> {
    const org = who.organizationId;
    const { title } = await this.connections.withAccessToken(org, body.connectionId, async (token) => {
      const file = await this.google.driveFile(token, body.spreadsheetId);
      if (file.trashed) throw new GoogleApiError('NOT_FOUND', 'The spreadsheet is in the trash', 404);
      if (file.mimeType !== SPREADSHEET_MIME) {
        throw fail(400, 'GOOGLE_NOT_A_SPREADSHEET', 'That file is not a Google Sheets spreadsheet.');
      }
      const meta = await this.google.spreadsheet(token, body.spreadsheetId);
      const tab = (meta.sheets ?? [])
        .map((s) => s.properties)
        .find((p) => p.sheetId === body.sheetId && (!p.sheetType || p.sheetType === 'GRID'));
      if (!tab) throw fail(404, 'SHEET_TAB_NOT_FOUND', 'That tab is not in the spreadsheet.');
      return { title: `${meta.properties?.title ?? file.name} › ${tab.title}` };
    });

    const externalId = `${body.spreadsheetId}:${body.sheetId}`;
    const existing = await this.prisma.lead_sources.findMany({
      where: {
        organization_id: org,
        provider: GOOGLE_SHEETS_PROVIDER,
        connection_method: SYNC_CONNECTION,
        external_form_id: externalId,
      },
      select: { ...SOURCE_SELECT, archived_at: true },
      orderBy: { created_at: 'desc' },
    });
    const live = existing.find((s) => !s.archived_at);
    if (live) {
      // Picked again through another connection (its old one was disconnected):
      // the read above just proved this one can open it, so the sheet moves to it.
      if (live.provider_credential_id === body.connectionId) return this.dto(org, live);
      await this.prisma.lead_sources.updateMany({
        where: { id: live.id, organization_id: org },
        data: { provider_credential_id: body.connectionId, updated_at: new Date() },
      });
      return this.dto(org, await this.mustFind(org, live.id));
    }

    const archived = existing[0];
    if (archived) {
      await this.prisma.lead_sources.updateMany({
        where: { id: archived.id, organization_id: org },
        data: {
          archived_at: null,
          provider_credential_id: body.connectionId,
          name: title.slice(0, 100),
          external_form_name: title.slice(0, 255),
          ingest_status: archived.mapping_status === 'CONFIGURED' ? 'PAUSED' : 'NEEDS_MAPPING',
          sync_next_at: null,
          updated_at: new Date(),
        },
      });
      await this.audit(who, 'sheet_source.restored', archived.id, {});
      return this.dto(org, await this.mustFind(org, archived.id));
    }

    const id = newId();
    try {
      await this.prisma.lead_sources.create({
        data: {
          id,
          organization_id: org,
          name: title.slice(0, 100),
          code: `gsheet-${id.slice(-12)}`,
          source_type: 'other',
          provider: GOOGLE_SHEETS_PROVIDER,
          connection_method: SYNC_CONNECTION,
          provider_credential_id: body.connectionId,
          external_form_id: externalId,
          external_form_name: title.slice(0, 255),
          ingest_status: 'NEEDS_MAPPING',
          mapping_status: 'UNCONFIGURED',
          is_active: true,
          default_consent_status: 'pending',
        },
      });
    } catch (e) {
      // Two clicks raced past the lookup; the partial unique index let one in.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const winner = await this.prisma.lead_sources.findFirst({
          where: { organization_id: org, provider: GOOGLE_SHEETS_PROVIDER, external_form_id: externalId, archived_at: null },
          select: SOURCE_SELECT,
        });
        if (winner) return this.dto(org, winner);
      }
      throw e;
    }
    await this.audit(who, 'sheet_source.created', id, {});
    return this.dto(org, await this.mustFind(org, id));
  }

  /**
   * The header row and every data row, as the import would see them under the
   * saved mapping — or under suggested ones before anything is saved — with the
   * flags the import would give them, so the owner can tick what to approve.
   * Read live from Google; nothing is written.
   */
  async preview(organizationId: string, sourceId: string) {
    const source = await this.mustFind(organizationId, sourceId);
    const { spreadsheetId, sheetId } = parseExternal(source);
    const [saved, org] = await Promise.all([
      this.savedMapping(organizationId, sourceId),
      this.prisma.organizations.findUnique({ where: { id: organizationId }, select: { default_region: true } }),
    ]);
    const region = org?.default_region ?? 'US';

    const { tab, headerCells, data } = await this.connections.withAccessToken(organizationId, source.provider_credential_id ?? '', async (token) => {
      const meta = await this.google.spreadsheet(token, spreadsheetId);
      const t = (meta.sheets ?? []).map((s) => s.properties).find((p) => p.sheetId === sheetId);
      if (!t) throw fail(404, 'TAB_MISSING', 'The connected tab no longer exists in the spreadsheet.');
      const columns = Math.min(t.gridProperties?.columnCount ?? MAX_COLUMNS, MAX_COLUMNS);
      const rowCount = t.gridProperties?.rowCount ?? 0;
      const [headerCells = []] = await this.google.readGrid(token, spreadsheetId, sheetId, 1, columns, 0);
      // Every data row, in the import's chunks (readTab); a chunk's trailing blank rows are not returned, so rows are numbered per chunk.
      const data: { rowNumber: number; cells: string[] }[] = [];
      let nonBlank = 0;
      for (let start = 1; start < rowCount && nonBlank <= MAX_DATA_ROWS; start += READ_CHUNK_ROWS) {
        const chunk = await this.google.readGrid(token, spreadsheetId, sheetId, Math.min(READ_CHUNK_ROWS, rowCount - start), columns, start);
        chunk.forEach((cells, i) => {
          if (cells.some((c) => c.trim())) nonBlank += 1;
          data.push({ rowNumber: start + i + 1, cells });
        });
      }
      return { tab: t, headerCells, data };
    });

    const headers = analyzeHeaders(headerCells);
    const sample = data.slice(0, SUGGEST_ROWS).map((r) => r.cells);
    const columns: ColumnMapping[] = saved ? toColumns(saved) : suggestColumns(headers, sample, region);
    const candidates = identityCandidates(headers, sample);
    const identity: Identity = sourceIdentity(source) ?? (candidates[0] ? { mode: 'column', fieldKey: candidates[0] } : { mode: 'fallback' });
    const problems = validateMapping(columns, identity, headers);

    const mappings = expandMapping(columns.filter((c) => headers.some((h) => h.fieldKey === c.fieldKey)), region);
    const ctx = {
      headerIndex: new Map(headers.filter((h) => h.fieldKey).map((h) => [h.fieldKey, h.index])),
      labels: new Map(headers.filter((h) => h.fieldKey).map((h) => [h.fieldKey, h.label])),
      mappings,
      identity,
      region,
    };
    const seen = new Set<string>();
    const verdicts = data
      .map(({ rowNumber, cells }) => {
        const built = buildRow(cells, rowNumber, ctx);
        const duplicate = Boolean(built.key && seen.has(built.key));
        if (built.key) seen.add(built.key);
        return { built, issue: built.issue ?? (duplicate ? 'DUPLICATE_IN_SHEET' : null) };
      })
      .filter((v) => !v.built.blank);
    // The flags the import gives: a possible duplicate, an opt-out — the rows the owner should look at before ticking.
    const flags = await contactFlags(
      this.prisma,
      organizationId,
      verdicts.filter((v) => !v.issue && v.built.lead).map((v) => v.built),
    );
    const rows = verdicts.map(({ built, issue }) => ({
      rowNumber: built.rowNumber,
      issue,
      lead: built.lead ?? null,
      reviewReasons: [...(flags.reasons.get(built.rowNumber) ?? []), ...built.reviewReasons],
    }));

    return {
      source: await this.dto(organizationId, source),
      tab: { title: tab.title, rowCount: tab.gridProperties?.rowCount ?? null, columnCount: tab.gridProperties?.columnCount ?? null },
      headers: headers.map((h) => ({
        fieldKey: h.fieldKey,
        label: h.label,
        column: columnLetter(h.index),
        duplicate: h.duplicate,
        // A couple of values so the owner can tell what the column holds. Shown, never stored.
        samples: sample.map((r) => (r[h.index] ?? '').trim()).filter(Boolean).slice(0, 2),
      })),
      mapping: { saved: Boolean(saved), columns, identity },
      identityCandidates: candidates,
      problems,
      rows,
    };
  }

  /**
   * Save the mapping and the row identity, validated against the header row as
   * it is NOW. Re-saving is also how an owner confirms a mapping after the
   * sheet's headers changed.
   */
  async saveMapping(who: SessionIdentity, sourceId: string, body: SaveMappingBody): Promise<SheetSourceDTO> {
    const org = who.organizationId;
    const source = await this.mustFind(org, sourceId);
    const { spreadsheetId, sheetId } = parseExternal(source);
    const identity: Identity = body.identity.mode === 'column' ? { mode: 'column', fieldKey: body.identity.fieldKey } : { mode: 'fallback' };

    // Rows already imported are keyed under the current identity. Changing it
    // would make every one of them look new and import the whole sheet again.
    const current = sourceIdentity(source);
    const identityChanged =
      !current ||
      current.mode !== identity.mode ||
      (current.mode === 'column' && identity.mode === 'column' && current.fieldKey !== identity.fieldKey);
    if (current && identityChanged) {
      const imported = await this.prisma.sheet_import_rows.count({ where: { organization_id: org, lead_source_id: sourceId } });
      if (imported > 0) {
        throw fail(409, 'IDENTITY_LOCKED', 'Rows were already imported with the current row identity, so it cannot change now.');
      }
    }

    const [headers, orgRow] = await Promise.all([
      this.connections.withAccessToken(org, source.provider_credential_id ?? '', async (token) => {
        const meta = await this.google.spreadsheet(token, spreadsheetId);
        const t = (meta.sheets ?? []).map((s) => s.properties).find((p) => p.sheetId === sheetId);
        if (!t) throw fail(404, 'TAB_MISSING', 'The connected tab no longer exists in the spreadsheet.');
        const columns = Math.min(t.gridProperties?.columnCount ?? MAX_COLUMNS, MAX_COLUMNS);
        const [row = []] = await this.google.readGrid(token, spreadsheetId, sheetId, 1, columns, 0);
        return analyzeHeaders(row);
      }),
      this.prisma.organizations.findUnique({ where: { id: org }, select: { default_region: true } }),
    ]);
    const errors = validateMapping(body.columns, identity, headers);
    if (errors.length > 0) throw new AppError('VALIDATION_ERROR', 'The mapping does not fit this sheet', errors);

    const stored = expandMapping(body.columns, orgRow?.default_region ?? 'US');
    const newAck = identity.mode === 'fallback' && !source.sync_fallback_ack_at;
    await this.prisma.$transaction(async (tx) => {
      await tx.lead_source_field_mappings.deleteMany({ where: { organization_id: org, lead_source_id: sourceId } });
      await tx.lead_source_field_mappings.createMany({
        data: stored.map((m) => ({
          id: newId(),
          organization_id: org,
          lead_source_id: sourceId,
          source_field_key: m.source_field_key,
          target_field: m.target_field,
          transform: m.transform as unknown as Prisma.InputJsonValue,
          is_active: true,
          origin: 'USER',
        })),
      });
      await tx.lead_sources.updateMany({
        where: { id: sourceId, organization_id: org },
        data: {
          mapping_status: 'CONFIGURED',
          mapping_version: { increment: 1 },
          schema_fingerprint: headerFingerprint(headers),
          sync_row_key_field: identity.mode === 'column' ? identity.fieldKey : null,
          sync_fallback_ack_at: identity.mode === 'fallback' ? (source.sync_fallback_ack_at ?? new Date()) : null,
          sync_fallback_ack_by: identity.mode === 'fallback' ? (newAck ? who.userId : undefined) : null,
          ingest_status: source.ingest_status === 'NEEDS_MAPPING' ? 'PAUSED' : undefined,
          remote_error_code: source.remote_error_code === 'HEADERS_CHANGED' ? null : undefined,
          remote_error_message: source.remote_error_code === 'HEADERS_CHANGED' ? null : undefined,
          updated_at: new Date(),
        },
      });
    });

    await this.audit(who, 'sheet_source.mapping_saved', sourceId, {
      columns: body.columns.length,
      identity: identity.mode,
    });
    if (newAck) {
      // The owner was told that an edit to phone, email or name will read as a
      // new person. This is the record that they accepted it.
      await this.audit(who, 'sheet_source.fallback_identity_acknowledged', sourceId, {});
    }
    return this.dto(org, await this.mustFind(org, sourceId));
  }

  /**
   * Switch on, and run the first import here and now: the rows the owner ticked
   * in the preview are approved as they land, the rest wait in Import Review —
   * as an uploaded file does. Refused unless it can actually run. Every later
   * sync approves nothing.
   */
  async enable(who: SessionIdentity, sourceId: string, body: EnableBody): Promise<SheetSourceDTO & { firstRun: FirstRun | null }> {
    const org = who.organizationId;
    const source = await this.mustFind(org, sourceId);
    if (source.mapping_status !== 'CONFIGURED' || !sourceIdentity(source)) {
      throw fail(409, 'MAPPING_REQUIRED', 'Save the column mapping and the row identity first.');
    }
    const credential = source.provider_credential_id
      ? await this.prisma.provider_credentials.findFirst({
          where: { id: source.provider_credential_id, organization_id: org, provider: GOOGLE_PROVIDER, revoked_at: null },
          select: { status: true },
        })
      : null;
    if (!credential) {
      throw fail(
        409,
        'GOOGLE_REAUTH_REQUIRED',
        'This sheet’s Google connection was disconnected. Connect Google again, or pick the spreadsheet again with “Add a spreadsheet”.',
      );
    }
    if (credential.status !== 'ACTIVE') {
      throw fail(409, 'GOOGLE_REAUTH_REQUIRED', 'Reconnect Google before switching this sheet on.');
    }
    await this.prisma.lead_sources.updateMany({
      where: { id: sourceId, organization_id: org },
      // A full read on switching on, as for "Sync now" (see syncNow).
      data: {
        ingest_status: 'ACTIVE',
        sync_next_at: new Date(),
        remote_synced_at: null,
        remote_error_code: null,
        remote_error_message: null,
        updated_at: new Date(),
      },
    });
    const ticked = new Set(body.approveRows ?? []);
    await this.audit(who, 'sheet_source.enabled', sourceId, { ticked: ticked.size });
    const run = await this.importer.runNow(org, sourceId, { rule: (b) => ticked.has(b.rowNumber), by: { userId: who.userId } });
    // A sweep got there first: it runs the import, and every row waits in Import Review.
    if (!run) this.importer.nudge();
    return {
      ...(await this.dto(org, await this.mustFind(org, sourceId))),
      firstRun: run
        ? {
            ok: run.ok,
            imported: run.stats.inserted,
            approval: { approved: run.stats.autoApproved, released: run.stats.autoReleased, held: run.stats.autoHeld, skipped: [] },
          }
        : null,
    };
  }

  async pause(who: SessionIdentity, sourceId: string): Promise<SheetSourceDTO> {
    const org = who.organizationId;
    await this.mustFind(org, sourceId);
    await this.prisma.lead_sources.updateMany({
      where: { id: sourceId, organization_id: org },
      data: { ingest_status: 'PAUSED', sync_next_at: null, updated_at: new Date() },
    });
    await this.audit(who, 'sheet_source.paused', sourceId, {});
    return this.dto(org, await this.mustFind(org, sourceId));
  }

  /**
   * Remove a sheet: archived, never deleted. It stops syncing for good; its
   * leads and tracking rows stay, and pending ones remain in Import Review for
   * the owner to decide. Picking the same tab again restores it, mapping and
   * all, without importing anything twice (see create).
   */
  async remove(who: SessionIdentity, sourceId: string): Promise<{ removed: true; pendingReview: number }> {
    const org = who.organizationId;
    await this.mustFind(org, sourceId);
    await this.prisma.lead_sources.updateMany({
      where: { id: sourceId, organization_id: org },
      data: { archived_at: new Date(), ingest_status: 'PAUSED', sync_next_at: null, updated_at: new Date() },
    });
    const pendingReview = await this.prisma.sheet_import_rows.count({
      where: { organization_id: org, lead_source_id: sourceId, review_state: 'pending' },
    });
    await this.audit(who, 'sheet_source.removed', sourceId, { pendingReview });
    return { removed: true, pendingReview };
  }

  /** Queue a sync. Runs in the background; the response does not wait for it. */
  async syncNow(who: SessionIdentity, sourceId: string): Promise<{ queued: true }> {
    const org = who.organizationId;
    const source = await this.mustFind(org, sourceId);
    if (source.ingest_status !== 'ACTIVE') throw fail(409, 'SOURCE_PAUSED', 'Switch this sheet on before syncing it.');
    await this.prisma.lead_sources.updateMany({
      where: { id: sourceId, organization_id: org },
      // remote_synced_at = null: the owner asked, so read it in full whatever
      // Drive's version says — that version trails an edit by several seconds,
      // and the probe (SHEETS_VERSION_PROBE) would skip the read they just asked for.
      data: { sync_next_at: new Date(), remote_synced_at: null },
    });
    this.importer.nudge();
    return { queued: true };
  }

  /** The last runs: counters, durations and row-numbered error codes. No cell values. */
  async runs(organizationId: string, sourceId: string) {
    await this.mustFind(organizationId, sourceId);
    const rows = await this.prisma.audit_logs.findMany({
      where: {
        organization_id: organizationId,
        entity_type: 'lead_source',
        entity_id: sourceId,
        action: { in: ['sheet_sync.completed', 'sheet_sync.failed'] },
      },
      orderBy: { created_at: 'desc' },
      take: 20,
      select: { action: true, created_at: true, payload: true, response_time_ms: true },
    });
    return rows.map((r) => ({
      ok: r.action === 'sheet_sync.completed',
      at: r.created_at,
      durationMs: r.response_time_ms,
      summary: r.payload,
    }));
  }

  /**
   * Imported leads waiting for review, newest first, keyset-paginated on
   * (created_at, id) — the partial index idx_sheet_import_rows_pending.
   */
  async review(organizationId: string, q: ReviewQuery) {
    const cursor = decodeCursor(q.cursor);
    // One queue for both imports; `source` narrows it to sheets or uploaded files.
    const scope = {
      organization_id: organizationId,
      review_state: q.state,
      // A row whose lead was deleted out of band has nothing left to decide: not shown, not counted.
      lead_id: { not: null },
      ...(q.sourceId ? { lead_source_id: q.sourceId } : {}),
      ...(q.source === 'all' ? {} : { lead_sources: { provider: REVIEW_SOURCE_PROVIDER[q.source] } }),
    };
    const rows = await this.prisma.sheet_import_rows.findMany({
      where: {
        ...scope,
        ...(cursor
          ? { OR: [{ created_at: { lt: cursor.t } }, { created_at: cursor.t, id: { lt: cursor.id } }] }
          : {}),
      },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      select: {
        id: true,
        row_number: true,
        missing_since: true,
        created_at: true,
        reviewed_at: true,
        lead_sources: { select: { id: true, name: true, provider: true } },
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
            dnc_status: true,
            review_reasons: true,
          },
        },
      },
    });
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    const total = cursor ? undefined : await this.prisma.sheet_import_rows.count({ where: scope });
    return {
      items: page.map((r) => ({
        rowId: r.id,
        rowNumber: r.row_number,
        /** No longer in the sheet (deleted there). The lead is kept; reject it if it should not be worked. */
        missing: r.missing_since !== null,
        importedAt: r.created_at,
        reviewedAt: r.reviewed_at,
        source: {
          id: r.lead_sources.id,
          name: r.lead_sources.name,
          kind: reviewKind(r.lead_sources.provider),
        },
        lead: r.leads
          ? {
              id: r.leads.id,
              firstName: r.leads.first_name,
              lastName: r.leads.last_name,
              phone: r.leads.phone,
              email: r.leads.email,
              location: r.leads.location,
              minBudget: r.leads.min_budget === null ? null : Number(r.leads.min_budget),
              maxBudget: r.leads.max_budget === null ? null : Number(r.leads.max_budget),
              dncStatus: r.leads.dnc_status,
              reviewReasons: r.leads.review_reasons,
            }
          : null,
      })),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last.created_at, last.id) : null,
      ...(total === undefined ? {} : { total }),
    };
  }

  // -------------------------------------------------------------------------

  private async mustFind(organizationId: string, sourceId: string): Promise<SourceRow> {
    const row = await this.prisma.lead_sources.findFirst({
      where: {
        id: sourceId,
        organization_id: organizationId,
        provider: GOOGLE_SHEETS_PROVIDER,
        connection_method: SYNC_CONNECTION,
        archived_at: null,
      },
      select: SOURCE_SELECT,
    });
    if (!row) throw fail(404, 'SHEET_SOURCE_NOT_FOUND', 'No such spreadsheet source.');
    return row;
  }

  private async savedMapping(organizationId: string, sourceId: string): Promise<StoredMapping[] | null> {
    const rows = await this.prisma.lead_source_field_mappings.findMany({
      where: { organization_id: organizationId, lead_source_id: sourceId, is_active: true },
      select: { source_field_key: true, target_field: true, transform: true },
    });
    return rows.length ? (rows as unknown as StoredMapping[]) : null;
  }

  private async dto(organizationId: string, s: SourceRow): Promise<SheetSourceDTO> {
    const pending = await this.prisma.sheet_import_rows.count({
      where: { organization_id: organizationId, lead_source_id: s.id, review_state: 'pending' },
    });
    return toDTO(s, pending);
  }

  private async audit(who: SessionIdentity, action: string, sourceId: string, payload: object): Promise<void> {
    await this.prisma.audit_logs.create({
      data: {
        id: newId(),
        organization_id: who.organizationId,
        actor_type: 'user',
        actor_id: who.userId,
        action,
        entity_type: 'lead_source',
        entity_id: sourceId,
        payload: payload as Prisma.InputJsonValue,
      },
    });
  }
}

function toDTO(s: SourceRow, pendingReview: number): SheetSourceDTO {
  const { spreadsheetId, sheetId } = parseExternal(s);
  return {
    id: s.id,
    name: s.name,
    spreadsheetId,
    sheetId,
    connectionId: s.provider_credential_id,
    status: s.ingest_status,
    mappingStatus: s.mapping_status,
    identity: sourceIdentity(s),
    syncQueued: s.sync_next_at !== null && s.sync_next_at.getTime() <= Date.now(),
    nextSyncAt: s.sync_next_at,
    syncing: s.sync_locked_at !== null,
    lastSuccessAt: s.last_success_at,
    lastFailureAt: s.last_failure_at,
    lastErrorCode: s.remote_error_code,
    lastErrorMessage: s.remote_error_message,
    pendingReview,
    createdAt: s.created_at,
  };
}

function sourceIdentity(s: { sync_row_key_field: string | null; sync_fallback_ack_at: Date | null }): Identity | null {
  if (s.sync_row_key_field) return { mode: 'column', fieldKey: s.sync_row_key_field };
  if (s.sync_fallback_ack_at) return { mode: 'fallback' };
  return null;
}

function parseExternal(s: { external_form_id: string | null }): { spreadsheetId: string; sheetId: number } {
  const [spreadsheetId = '', sheetId = ''] = (s.external_form_id ?? '').split(':');
  return { spreadsheetId, sheetId: Number(sheetId) };
}

/** Stored mapping rows back to the API's column list; a split name is one "full name" column. */
function toColumns(stored: StoredMapping[]): ColumnMapping[] {
  const splitKeys = new Set(
    stored.filter((m) => m.target_field === 'first_name' && m.transform?.kind === 'name_split').map((m) => m.source_field_key),
  );
  const out: ColumnMapping[] = [];
  for (const m of stored) {
    if (splitKeys.has(m.source_field_key) && (m.target_field === 'first_name' || m.target_field === 'last_name')) {
      if (m.target_field === 'first_name') out.push({ fieldKey: m.source_field_key, target: FULL_NAME_TARGET });
      continue;
    }
    out.push({ fieldKey: m.source_field_key, target: m.target_field as ColumnMapping['target'] });
  }
  return out;
}

function columnLetter(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function encodeCursor(t: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: t.toISOString(), id })).toString('base64url');
}

function decodeCursor(cursor: string | undefined): { t: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const { t, id } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { t: string; id: string };
    const date = new Date(t);
    if (Number.isNaN(date.getTime()) || typeof id !== 'string') throw new Error('bad cursor');
    return { t: date, id };
  } catch {
    throw new AppError('VALIDATION_ERROR', 'Invalid cursor');
  }
}

export type { SheetHeader };
