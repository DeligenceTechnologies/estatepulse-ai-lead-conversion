import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConnectionMethod, IntegrationProvider, IngestStatus, LeadSourceProvider, MappingStatus, Prisma } from '@prisma/client';
import { AuditService } from '@/audit/audit.service';
import { AppError, httpError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import type { SaveMappingDto, CreateSheetSourceDto, EnableSheetDto, ReviewQueryDto } from './dto/sheets.dto';
import { GoogleConnectionsService, type SessionIdentity } from './google-connections.service';
import { GoogleApiError, GoogleClient, SPREADSHEET_MIME } from './google.client';
import { READ_CHUNK_ROWS, SheetImportService, contactFlags, toStored, type RunStats } from './sheet-import.service';
import {
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
  type StoredMapping,
} from './sheet-rows';

const SUGGEST_ROWS = 20;

const SOURCE_SELECT = {
  id: true,
  name: true,
  externalFormId: true,
  externalFormName: true,
  integrationId: true,
  ingestStatus: true,
  mappingStatus: true,
  mappingVersion: true,
  syncRowKeyField: true,
  syncFallbackAckAt: true,
  syncNextAt: true,
  syncLockedAt: true,
  lastSuccessAt: true,
  lastFailureAt: true,
  remoteErrorCode: true,
  remoteErrorMessage: true,
  createdAt: true,
} satisfies Prisma.LeadSourceSelect;

type SourceRow = Prisma.LeadSourceGetPayload<{ select: typeof SOURCE_SELECT }>;

const SHEET_SOURCE = { provider: LeadSourceProvider.GOOGLE_SHEETS, connectionMethod: ConnectionMethod.SYNC } as const;

/** Where a reviewed row came from, as the review queue names it: sheets, uploaded files, a connected CRM. */
const REVIEW_SOURCE_PROVIDER = {
  google_sheets: LeadSourceProvider.GOOGLE_SHEETS,
  file_upload: LeadSourceProvider.FILE_UPLOAD,
  hubspot: LeadSourceProvider.HUBSPOT,
} as const;
type ReviewKind = keyof typeof REVIEW_SOURCE_PROVIDER;

function reviewKind(provider: LeadSourceProvider): ReviewKind {
  return (Object.keys(REVIEW_SOURCE_PROVIDER) as ReviewKind[]).find((k) => REVIEW_SOURCE_PROVIDER[k] === provider) ?? 'google_sheets';
}

export interface SheetSourceDTO {
  id: string;
  name: string;
  spreadsheetId: string;
  sheetId: number;
  connectionId: string | null;
  status: string | null;
  mappingStatus: string | null;
  identity: { mode: 'column'; fieldKey: string } | { mode: 'fallback' } | null;
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

export interface FirstRun {
  ok: boolean;
  imported: number;
  approval: { approved: number; released: number; held: RunStats['autoHeld']; skipped: string[] };
}

/** One Google Sheets tab per lead source: pick it, map its columns, choose its row identity, switch it on. */
@Injectable()
export class SheetSourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: GoogleConnectionsService,
    private readonly google: GoogleClient,
    private readonly importer: SheetImportService,
    private readonly audit: AuditService,
  ) {}

  async list(orgId: string): Promise<SheetSourceDTO[]> {
    const [sources, pending] = await Promise.all([
      this.prisma.leadSource.findMany({
        where: { orgId, ...SHEET_SOURCE, archivedAt: null },
        select: SOURCE_SELECT,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.sheetImportRow.groupBy({ by: ['leadSourceId'], where: { orgId, reviewState: 'pending' }, _count: { _all: true } }),
    ]);
    const counts = new Map(pending.map((p) => [p.leadSourceId, p._count._all]));
    return sources.map((s) => toDTO(s, counts.get(s.id) ?? 0));
  }

  async create(who: SessionIdentity, body: CreateSheetSourceDto): Promise<SheetSourceDTO> {
    const orgId = who.organizationId;
    const { title } = await this.connections.withAccessToken(orgId, body.connectionId, async (token) => {
      const file = await this.google.driveFile(token, body.spreadsheetId);
      if (file.trashed) throw new GoogleApiError('NOT_FOUND', 'The spreadsheet is in the trash', 404);
      if (file.mimeType !== SPREADSHEET_MIME) throw httpError(400, 'GOOGLE_NOT_A_SPREADSHEET', 'That file is not a Google Sheets spreadsheet.');
      const meta = await this.google.spreadsheet(token, body.spreadsheetId);
      const tab = (meta.sheets ?? [])
        .map((s) => s.properties)
        .find((p) => p.sheetId === body.sheetId && (!p.sheetType || p.sheetType === 'GRID'));
      if (!tab) throw httpError(404, 'SHEET_TAB_NOT_FOUND', 'That tab is not in the spreadsheet.');
      return { title: `${meta.properties?.title ?? file.name} › ${tab.title}` };
    });

    const externalId = `${body.spreadsheetId}:${body.sheetId}`;
    const existing = await this.prisma.leadSource.findMany({
      where: { orgId, ...SHEET_SOURCE, externalFormId: externalId },
      select: { ...SOURCE_SELECT, archivedAt: true },
      orderBy: { createdAt: 'desc' },
    });
    const live = existing.find((s) => !s.archivedAt);
    if (live) {
      if (live.integrationId === body.connectionId) return this.dto(orgId, live);
      await this.prisma.leadSource.updateMany({ where: { id: live.id, orgId }, data: { integrationId: body.connectionId } });
      return this.dto(orgId, await this.mustFind(orgId, live.id));
    }

    const archived = existing[0];
    if (archived) {
      await this.prisma.leadSource.updateMany({
        where: { id: archived.id, orgId },
        data: {
          archivedAt: null,
          integrationId: body.connectionId,
          name: title.slice(0, 100),
          externalFormName: title.slice(0, 255),
          ingestStatus: archived.mappingStatus === MappingStatus.CONFIGURED ? IngestStatus.PAUSED : IngestStatus.NEEDS_MAPPING,
          syncNextAt: null,
        },
      });
      await this.record(who, 'sheet_source.restored', archived.id, {});
      return this.dto(orgId, await this.mustFind(orgId, archived.id));
    }

    let id: string;
    try {
      ({ id } = await this.prisma.leadSource.create({
        data: {
          orgId,
          name: title.slice(0, 100),
          code: `gsheet-${randomUUID().slice(-12)}`,
          ...SHEET_SOURCE,
          integrationId: body.connectionId,
          externalFormId: externalId,
          externalFormName: title.slice(0, 255),
          ingestStatus: IngestStatus.NEEDS_MAPPING,
          mappingStatus: MappingStatus.UNCONFIGURED,
        },
        select: { id: true },
      }));
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await this.prisma.leadSource.findFirst({
          where: { orgId, ...SHEET_SOURCE, externalFormId: externalId, archivedAt: null },
          select: SOURCE_SELECT,
        });
        if (winner) return this.dto(orgId, winner);
      }
      throw error;
    }
    await this.record(who, 'sheet_source.created', id, {});
    return this.dto(orgId, await this.mustFind(orgId, id));
  }

  /** What importing would do to each row right now, without writing anything. */
  async preview(orgId: string, sourceId: string) {
    const source = await this.mustFind(orgId, sourceId);
    const { spreadsheetId, sheetId } = parseExternal(source);
    const [saved, settings] = await Promise.all([
      this.savedMapping(orgId, sourceId),
      this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { defaultRegion: true } }),
    ]);
    const region = settings?.defaultRegion ?? 'US';

    const { tab, headerCells, data } = await this.connections.withAccessToken(orgId, source.integrationId ?? '', async (token) => {
      const meta = await this.google.spreadsheet(token, spreadsheetId);
      const t = (meta.sheets ?? []).map((s) => s.properties).find((p) => p.sheetId === sheetId);
      if (!t) throw httpError(404, 'TAB_MISSING', 'The connected tab no longer exists in the spreadsheet.');
      const columns = Math.min(t.gridProperties?.columnCount ?? MAX_COLUMNS, MAX_COLUMNS);
      const rowCount = t.gridProperties?.rowCount ?? 0;
      const [headerCells = []] = await this.google.readGrid(token, spreadsheetId, sheetId, 1, columns, 0);
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
    const flags = await contactFlags(this.prisma, orgId, verdicts.filter((v) => !v.issue && v.built.lead).map((v) => v.built));
    const rows = verdicts.map(({ built, issue }) => ({
      rowNumber: built.rowNumber,
      issue,
      lead: built.lead ?? null,
      reviewReasons: [...(flags.reasons.get(built.rowNumber) ?? []), ...built.reviewReasons],
    }));

    return {
      source: await this.dto(orgId, source),
      tab: { title: tab.title, rowCount: tab.gridProperties?.rowCount ?? null, columnCount: tab.gridProperties?.columnCount ?? null },
      headers: headers.map((h) => ({
        fieldKey: h.fieldKey,
        label: h.label,
        column: columnLetter(h.index),
        duplicate: h.duplicate,
        samples: sample.map((r) => (r[h.index] ?? '').trim()).filter(Boolean).slice(0, 2),
      })),
      mapping: { saved: Boolean(saved), columns, identity },
      identityCandidates: candidates,
      problems,
      rows,
    };
  }

  /** The row identity is locked once rows were imported with it: changing it would re-import every row. */
  async saveMapping(who: SessionIdentity, sourceId: string, body: SaveMappingDto): Promise<SheetSourceDTO> {
    const orgId = who.organizationId;
    const source = await this.mustFind(orgId, sourceId);
    const { spreadsheetId, sheetId } = parseExternal(source);
    const identity: Identity = body.identity.mode === 'column' ? { mode: 'column', fieldKey: body.identity.fieldKey! } : { mode: 'fallback' };
    const current = sourceIdentity(source);
    const identityChanged =
      !current || current.mode !== identity.mode || (current.mode === 'column' && identity.mode === 'column' && current.fieldKey !== identity.fieldKey);
    if (current && identityChanged) {
      const imported = await this.prisma.sheetImportRow.count({ where: { orgId, leadSourceId: sourceId } });
      if (imported > 0) throw httpError(409, 'IDENTITY_LOCKED', 'Rows were already imported with the current row identity, so it cannot change now.');
    }

    const [headers, settings] = await Promise.all([
      this.connections.withAccessToken(orgId, source.integrationId ?? '', async (token) => {
        const meta = await this.google.spreadsheet(token, spreadsheetId);
        const t = (meta.sheets ?? []).map((s) => s.properties).find((p) => p.sheetId === sheetId);
        if (!t) throw httpError(404, 'TAB_MISSING', 'The connected tab no longer exists in the spreadsheet.');
        const columns = Math.min(t.gridProperties?.columnCount ?? MAX_COLUMNS, MAX_COLUMNS);
        const [row = []] = await this.google.readGrid(token, spreadsheetId, sheetId, 1, columns, 0);
        return analyzeHeaders(row);
      }),
      this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { defaultRegion: true } }),
    ]);
    const columns = body.columns as ColumnMapping[];
    const errors = validateMapping(columns, identity, headers);
    if (errors.length > 0) throw new AppError('VALIDATION_ERROR', 'The mapping does not fit this sheet', errors);

    const stored = expandMapping(columns, settings?.defaultRegion ?? 'US');
    const newAck = identity.mode === 'fallback' && !source.syncFallbackAckAt;
    await this.prisma.$transaction(async (tx) => {
      await tx.leadSourceFieldMapping.deleteMany({ where: { orgId, leadSourceId: sourceId } });
      await tx.leadSourceFieldMapping.createMany({
        data: stored.map((m) => ({
          orgId,
          leadSourceId: sourceId,
          sourceFieldKey: m.source_field_key,
          targetField: m.target_field,
          transform: m.transform as unknown as Prisma.InputJsonValue,
          isActive: true,
          origin: 'USER' as const,
        })),
      });
      await tx.leadSource.updateMany({
        where: { id: sourceId, orgId },
        data: {
          mappingStatus: MappingStatus.CONFIGURED,
          mappingVersion: { increment: 1 },
          schemaFingerprint: headerFingerprint(headers),
          syncRowKeyField: identity.mode === 'column' ? identity.fieldKey : null,
          syncFallbackAckAt: identity.mode === 'fallback' ? (source.syncFallbackAckAt ?? new Date()) : null,
          syncFallbackAckBy: identity.mode === 'fallback' ? (newAck ? who.userId : undefined) : null,
          ingestStatus: source.ingestStatus === IngestStatus.NEEDS_MAPPING ? IngestStatus.PAUSED : undefined,
          remoteErrorCode: source.remoteErrorCode === 'HEADERS_CHANGED' ? null : undefined,
          remoteErrorMessage: source.remoteErrorCode === 'HEADERS_CHANGED' ? null : undefined,
        },
      });
    });
    await this.record(who, 'sheet_source.mapping_saved', sourceId, { columns: columns.length, identity: identity.mode });
    if (newAck) await this.record(who, 'sheet_source.fallback_identity_acknowledged', sourceId, {});
    return this.dto(orgId, await this.mustFind(orgId, sourceId));
  }

  async enable(who: SessionIdentity, sourceId: string, body: EnableSheetDto): Promise<SheetSourceDTO & { firstRun: FirstRun | null }> {
    const orgId = who.organizationId;
    const source = await this.mustFind(orgId, sourceId);
    if (source.mappingStatus !== MappingStatus.CONFIGURED || !sourceIdentity(source)) {
      throw httpError(409, 'MAPPING_REQUIRED', 'Save the column mapping and the row identity first.');
    }
    const credential = source.integrationId
      ? await this.prisma.integration.findFirst({
          where: { id: source.integrationId, orgId, provider: IntegrationProvider.google, revokedAt: null },
          select: { status: true },
        })
      : null;
    if (!credential) {
      throw httpError(
        409,
        'GOOGLE_REAUTH_REQUIRED',
        'This sheet’s Google connection was disconnected. Connect Google again, or pick the spreadsheet again with “Add a spreadsheet”.',
      );
    }
    if (credential.status !== 'active') throw httpError(409, 'GOOGLE_REAUTH_REQUIRED', 'Reconnect Google before switching this sheet on.');

    await this.prisma.leadSource.updateMany({
      where: { id: sourceId, orgId },
      data: { ingestStatus: IngestStatus.ACTIVE, syncNextAt: new Date(), remoteSyncedAt: null, remoteErrorCode: null, remoteErrorMessage: null },
    });
    const ticked = new Set(body.approveRows ?? []);
    await this.record(who, 'sheet_source.enabled', sourceId, { ticked: ticked.size });
    const run = await this.importer.runNow(orgId, sourceId, { rule: (b) => ticked.has(b.rowNumber), by: { userId: who.userId } });
    if (!run) this.importer.nudge();
    return {
      ...(await this.dto(orgId, await this.mustFind(orgId, sourceId))),
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
    const orgId = who.organizationId;
    await this.mustFind(orgId, sourceId);
    await this.prisma.leadSource.updateMany({ where: { id: sourceId, orgId }, data: { ingestStatus: IngestStatus.PAUSED, syncNextAt: null } });
    await this.record(who, 'sheet_source.paused', sourceId, {});
    return this.dto(orgId, await this.mustFind(orgId, sourceId));
  }

  async remove(who: SessionIdentity, sourceId: string): Promise<{ removed: true; pendingReview: number }> {
    const orgId = who.organizationId;
    await this.mustFind(orgId, sourceId);
    await this.prisma.leadSource.updateMany({
      where: { id: sourceId, orgId },
      data: { archivedAt: new Date(), ingestStatus: IngestStatus.PAUSED, syncNextAt: null },
    });
    const pendingReview = await this.prisma.sheetImportRow.count({ where: { orgId, leadSourceId: sourceId, reviewState: 'pending' } });
    await this.record(who, 'sheet_source.removed', sourceId, { pendingReview });
    return { removed: true, pendingReview };
  }

  async syncNow(who: SessionIdentity, sourceId: string): Promise<{ queued: true }> {
    const orgId = who.organizationId;
    const source = await this.mustFind(orgId, sourceId);
    if (source.ingestStatus !== IngestStatus.ACTIVE) throw httpError(409, 'SOURCE_PAUSED', 'Switch this sheet on before syncing it.');
    await this.prisma.leadSource.updateMany({ where: { id: sourceId, orgId }, data: { syncNextAt: new Date(), remoteSyncedAt: null } });
    this.importer.nudge();
    return { queued: true };
  }

  async runs(orgId: string, sourceId: string) {
    await this.mustFind(orgId, sourceId);
    const rows = await this.prisma.auditLog.findMany({
      where: { orgId, entityType: 'lead_source', entityId: sourceId, action: { in: ['sheet_sync.completed', 'sheet_sync.failed'] } },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { action: true, createdAt: true, payload: true, durationMs: true },
    });
    return rows.map((r) => ({ ok: r.action === 'sheet_sync.completed', at: r.createdAt, durationMs: r.durationMs, summary: r.payload }));
  }

  /** The import review queue across sheets and file uploads, newest first, keyset-paginated. */
  async review(orgId: string, q: ReviewQueryDto) {
    const limit = q.limit ?? 50;
    const cursor = decodeCursor(q.cursor);
    const kind = q.source ?? 'all';
    const scope: Prisma.SheetImportRowWhereInput = {
      orgId,
      reviewState: q.state ?? 'pending',
      leadId: { not: null },
      ...(q.sourceId ? { leadSourceId: q.sourceId } : {}),
      ...(kind === 'all' ? {} : { leadSource: { provider: REVIEW_SOURCE_PROVIDER[kind] } }),
    };
    const rows = await this.prisma.sheetImportRow.findMany({
      where: { ...scope, ...(cursor ? { OR: [{ createdAt: { lt: cursor.t } }, { createdAt: cursor.t, id: { lt: cursor.id } }] } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        rowNumber: true,
        missingSince: true,
        createdAt: true,
        reviewedAt: true,
        leadSource: { select: { id: true, name: true, provider: true } },
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
            dncStatus: true,
            reviewReasons: true,
          },
        },
      },
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const total = cursor ? undefined : await this.prisma.sheetImportRow.count({ where: scope });
    return {
      items: page.map((r) => ({
        rowId: r.id,
        rowNumber: r.rowNumber,
        missing: r.missingSince !== null,
        importedAt: r.createdAt,
        reviewedAt: r.reviewedAt,
        source: {
          id: r.leadSource.id,
          name: r.leadSource.name,
          kind: reviewKind(r.leadSource.provider),
        },
        lead: r.lead
          ? {
              id: r.lead.id,
              firstName: r.lead.firstName,
              lastName: r.lead.lastName,
              phone: r.lead.phone,
              email: r.lead.email,
              location: r.lead.location,
              minBudget: r.lead.minBudget === null ? null : Number(r.lead.minBudget),
              maxBudget: r.lead.maxBudget === null ? null : Number(r.lead.maxBudget),
              dncStatus: r.lead.dncStatus,
              reviewReasons: r.lead.reviewReasons,
            }
          : null,
      })),
      nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
      ...(total === undefined ? {} : { total }),
    };
  }

  private async mustFind(orgId: string, sourceId: string): Promise<SourceRow> {
    const row = await this.prisma.leadSource.findFirst({ where: { id: sourceId, orgId, ...SHEET_SOURCE, archivedAt: null }, select: SOURCE_SELECT });
    if (!row) throw httpError(404, 'SHEET_SOURCE_NOT_FOUND', 'No such spreadsheet source.');
    return row;
  }

  private async savedMapping(orgId: string, sourceId: string): Promise<StoredMapping[] | null> {
    const rows = await this.prisma.leadSourceFieldMapping.findMany({
      where: { orgId, leadSourceId: sourceId, isActive: true },
      select: { sourceFieldKey: true, targetField: true, transform: true },
    });
    return rows.length ? toStored(rows) : null;
  }

  private async dto(orgId: string, s: SourceRow): Promise<SheetSourceDTO> {
    const pending = await this.prisma.sheetImportRow.count({ where: { orgId, leadSourceId: s.id, reviewState: 'pending' } });
    return toDTO(s, pending);
  }

  private record(who: SessionIdentity, action: string, sourceId: string, payload: Prisma.InputJsonObject): Promise<void> {
    return this.audit.record({
      orgId: who.organizationId,
      actorType: 'user',
      actorId: who.userId,
      action,
      entityType: 'lead_source',
      entityId: sourceId,
      payload,
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
    connectionId: s.integrationId,
    status: s.ingestStatus,
    mappingStatus: s.mappingStatus,
    identity: sourceIdentity(s),
    syncQueued: s.syncNextAt !== null && s.syncNextAt.getTime() <= Date.now(),
    nextSyncAt: s.syncNextAt,
    syncing: s.syncLockedAt !== null,
    lastSuccessAt: s.lastSuccessAt,
    lastFailureAt: s.lastFailureAt,
    lastErrorCode: s.remoteErrorCode,
    lastErrorMessage: s.remoteErrorMessage,
    pendingReview,
    createdAt: s.createdAt,
  };
}

function sourceIdentity(s: { syncRowKeyField: string | null; syncFallbackAckAt: Date | null }): Identity | null {
  if (s.syncRowKeyField) return { mode: 'column', fieldKey: s.syncRowKeyField };
  if (s.syncFallbackAckAt) return { mode: 'fallback' };
  return null;
}

function parseExternal(s: { externalFormId: string | null }): { spreadsheetId: string; sheetId: number } {
  const [spreadsheetId = '', sheetId = ''] = (s.externalFormId ?? '').split(':');
  return { spreadsheetId, sheetId: Number(sheetId) };
}

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
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
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
