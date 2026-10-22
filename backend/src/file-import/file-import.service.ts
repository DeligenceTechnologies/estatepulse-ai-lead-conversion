import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConnectionMethod, IngestStatus, LeadSourceProvider, MappingStatus, Prisma } from '@prisma/client';
import { AuditService } from '@/audit/audit.service';
import { AppError, httpError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import type { IntegrationEnv } from '@/common/utils/interface';
import { EventsBus } from '@/events/events.bus';
import { outreachRequest, type OutreachChoice } from '@/outreach/batches';
import { summaryOf } from '@/outreach/schedule';
import type { ApprovalResult } from '@/google-sheets/approval';
import type { SessionIdentity } from '@/google-sheets/google-connections.service';
import { RunStats, SheetImportService, contactFlags, type Approval } from '@/google-sheets/sheet-import.service';
import { SheetReviewService } from '@/google-sheets/sheet-review.service';
import {
  FILE_IMPORT_REVIEW_REASON,
  MAX_DATA_ROWS,
  analyzeHeaders,
  buildRow,
  expandMapping,
  suggestColumns,
  validateMapping,
  type BuiltRow,
  type ColumnMapping,
  type Identity,
  type RowIssue,
} from '@/google-sheets/sheet-rows';
import { FileParseError, detectKind, parseFile, type FileKind, type ParsedFile } from './file-parsers';

export interface UploadedFileLike {
  originalname: string;
  size: number;
  buffer: Buffer;
}

export type ImportKind = 'google_sheets' | 'file_upload';

const ERROR_SAMPLE_LIMIT = 100;
const REJECT_BATCH = 500;

interface Analysis {
  kind: FileKind;
  sheets: string[];
  sheet: string | null;
  headers: ReturnType<typeof analyzeHeaders>;
  columns: ColumnMapping[];
  problems: { path: string; message: string }[];
  dataRows: number;
  blank: number;
  candidates: BuiltRow[];
  rows: { built: BuiltRow; issue: RowIssue | null }[];
  skipped: Partial<Record<RowIssue, number>>;
  errorSample: { row: number; code: RowIssue }[];
}

/**
 * CSV and Excel uploads. Each upload is its own lead source, so the same row
 * tracking, duplicate and do-not-contact checks and review queue as a Google
 * Sheets sync apply. The client's token makes a retried commit a no-op.
 */
@Injectable()
export class FileImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly importer: SheetImportService,
    private readonly reviews: SheetReviewService,
    private readonly events: EventsBus,
    private readonly audit: AuditService,
    private readonly config: ConfigService<IntegrationEnv, true>,
  ) {}

  get maxBytes(): number {
    return this.config.get('FILE_IMPORT_MAX_BYTES', { infer: true });
  }

  limits() {
    return { maxBytes: this.maxBytes, maxRows: MAX_DATA_ROWS, accept: ['.csv', '.xlsx'] };
  }

  async preview(orgId: string, file: UploadedFileLike | undefined, columns: ColumnMapping[] | null, sheet: string | null) {
    const a = await this.analyze(orgId, file, columns, sheet);
    const dup = await contactFlags(this.prisma, orgId, a.candidates);
    return {
      file: { name: file!.originalname, size: file!.size, kind: a.kind, rows: a.dataRows, sheets: a.sheets, sheet: a.sheet },
      headers: a.headers.map((h) => ({ fieldKey: h.fieldKey, label: h.label, column: columnLetter(h.index), duplicate: h.duplicate, samples: [] as string[] })),
      mapping: { columns: a.columns, problems: a.problems },
      counts: {
        total: a.dataRows,
        blank: a.blank,
        importable: a.candidates.length,
        withWarnings: a.candidates.filter((b) => b.reviewReasons.length > 0).length,
        errors: Object.values(a.skipped).reduce((n, x) => n + (x ?? 0), 0),
        skipped: a.skipped,
        possibleDuplicates: dup.possible,
        optedOut: dup.optedOut,
      },
      errorSample: a.errorSample,
      rows: a.rows.map(({ built, issue }) => ({
        rowNumber: built.rowNumber,
        issue,
        lead: built.lead
          ? {
              first_name: built.lead.first_name,
              last_name: built.lead.last_name,
              phone: built.lead.phone,
              normalized_phone: built.lead.normalized_phone,
              email: built.lead.email,
              email_valid: built.lead.email_valid,
              location: built.lead.location,
              min_budget: built.lead.min_budget,
              max_budget: built.lead.max_budget,
              bedrooms: built.lead.bedrooms,
            }
          : null,
        reviewReasons: [...(dup.reasons.get(built.rowNumber) ?? []), ...built.reviewReasons],
      })),
    };
  }

  async commit(
    who: SessionIdentity,
    file: UploadedFileLike | undefined,
    columns: ColumnMapping[],
    clientToken: string,
    sheet: string | null,
    approveRows: number[],
    onlyClean = false,
    choice?: OutreachChoice,
  ) {
    const orgId = who.organizationId;
    const a = await this.analyze(orgId, file, columns, sheet);
    if (a.problems.length > 0) throw new AppError('VALIDATION_ERROR', 'The column mapping does not fit this file', a.problems);
    if (a.candidates.length === 0) {
      throw httpError(400, 'NO_IMPORTABLE_ROWS', 'No row in this file has a name and a usable phone or email, so there is nothing to import.');
    }

    let toImport = a.candidates;
    let flaggedLeftOut = 0;
    if (onlyClean) {
      const dup = await contactFlags(this.prisma, orgId, a.candidates);
      toImport = a.candidates.filter((b) => b.reviewReasons.length === 0 && !dup.reasons.has(b.rowNumber));
      flaggedLeftOut = a.candidates.length - toImport.length;
      if (toImport.length === 0) throw httpError(400, 'NO_CLEAN_ROWS', 'Every importable row in this file is flagged, so there is nothing to import this way.');
    }
    const ticked = new Set(approveRows);
    const by = { userId: who.userId };
    // Only rows approved on import launch; with none, there is no schedule to check.
    const approving = onlyClean || ticked.size > 0;
    const outreach = approving ? await outreachRequest(this.prisma, this.config.get('OUTREACH_SCHEDULING_ENABLED', { infer: true }), orgId, by, choice) : undefined;
    const approvalRule: Approval = { by, rule: onlyClean ? () => true : (b) => ticked.has(b.rowNumber), outreach };

    const code = `upload-${clientToken}`.slice(0, 50);
    const select = { id: true, defaultConsentStatus: true, lastSuccessAt: true } as const;
    let source = await this.prisma.leadSource.findFirst({ where: { orgId, code }, select });
    if (!source) {
      const settings = await this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { defaultRegion: true } });
      const name = a.sheets.length > 1 ? `${file!.originalname} › ${a.sheet}` : file!.originalname;
      try {
        await this.prisma.$transaction(async (tx) => {
          const created = await tx.leadSource.create({
            data: {
              orgId,
              name: name.slice(0, 100),
              code,
              provider: LeadSourceProvider.FILE_UPLOAD,
              connectionMethod: ConnectionMethod.UPLOAD,
              externalFormName: file!.originalname.slice(0, 255),
              ingestStatus: IngestStatus.IMPORTING,
              mappingStatus: MappingStatus.CONFIGURED,
              mappingVersion: 1,
              syncFallbackAckAt: new Date(),
              syncFallbackAckBy: who.userId,
            },
            select: { id: true },
          });
          await tx.leadSourceFieldMapping.createMany({
            data: expandMapping(a.columns, settings?.defaultRegion ?? 'US').map((m) => ({
              orgId,
              leadSourceId: created.id,
              sourceFieldKey: m.source_field_key,
              targetField: m.target_field,
              transform: m.transform as unknown as Prisma.InputJsonValue,
              isActive: true,
              origin: 'USER' as const,
            })),
          });
        });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
      }
      source = await this.prisma.leadSource.findFirst({ where: { orgId, code }, select });
      if (!source) throw httpError(500, 'INTERNAL', 'The import could not be recorded. It is safe to try again.');
    }

    let approval: ApprovalResult | null = null;
    if (!source.lastSuccessAt) {
      const stats = new RunStats(0);
      await this.importer.importRows(orgId, source.id, source.defaultConsentStatus, toImport, stats, FILE_IMPORT_REVIEW_REASON, approvalRule);
      approval = {
        approved: stats.autoApproved,
        released: stats.autoReleased,
        held: stats.autoHeld as ApprovalResult['held'],
        skipped: [],
        ...(outreach?.batchId ? { outreach: summaryOf(outreach) } : {}),
      };
      await this.prisma.leadSource.updateMany({
        where: { id: source.id, orgId },
        data: { lastSuccessAt: new Date(), ingestStatus: IngestStatus.COMPLETED },
      });
      await this.audit.record({
        orgId,
        actorType: 'user',
        actorId: who.userId,
        action: 'file_import.completed',
        entityType: 'lead_source',
        entityId: source.id,
        payload: {
          fileName: file!.originalname.slice(0, 255),
          fileSize: file!.size,
          kind: a.kind,
          sheet: a.sheet,
          rows: {
            total: a.dataRows,
            blank: a.blank,
            imported: stats.inserted,
            withWarnings: toImport.filter((b) => b.reviewReasons.length > 0).length,
            flaggedLeftOut,
            approved: stats.autoApproved,
            skipped: a.skipped,
            possibleDuplicates: stats.possibleDuplicates,
            dncInherited: stats.dncInherited,
          },
          errorSample: a.errorSample,
        } as Prisma.InputJsonValue,
      });
      if (stats.inserted > 0) this.events.publish({ organizationId: orgId, type: 'lead.created', leadSourceId: source.id });
    }

    const batch = (await this.history(orgId, source.id))[0];
    if (!batch) throw httpError(500, 'INTERNAL', 'The import finished but could not be read back.');
    return { ...batch, approval };
  }

  /** Rejects whatever is still pending review; approved leads stay. */
  async remove(who: SessionIdentity, batchId: string) {
    const orgId = who.organizationId;
    const source = await this.prisma.leadSource.findFirst({
      where: { id: batchId, orgId, provider: LeadSourceProvider.FILE_UPLOAD, archivedAt: null },
      select: { id: true },
    });
    if (!source) throw httpError(404, 'IMPORT_NOT_FOUND', 'No such file import.');
    const pending = await this.prisma.sheetImportRow.findMany({
      where: { orgId, leadSourceId: batchId, reviewState: 'pending' },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    let rejected = 0;
    for (let i = 0; i < pending.length; i += REJECT_BATCH) {
      rejected += (await this.reviews.reject(who, pending.slice(i, i + REJECT_BATCH).map((p) => p.id))).rejected;
    }
    await this.prisma.leadSource.updateMany({
      where: { id: batchId, orgId },
      data: { archivedAt: new Date(), ingestStatus: IngestStatus.REMOVED },
    });
    const approvedKept = await this.prisma.sheetImportRow.count({ where: { orgId, leadSourceId: batchId, reviewState: 'approved' } });
    await this.audit.record({
      orgId,
      actorType: 'user',
      actorId: who.userId,
      action: 'file_import.removed',
      entityType: 'lead_source',
      entityId: batchId,
      payload: { rejected, approvedKept },
    });
    return { removed: true as const, rejected, approvedKept };
  }

  async history(orgId: string, onlyId?: string) {
    const sources = await this.prisma.leadSource.findMany({
      where: {
        orgId,
        ...(onlyId ? { id: onlyId } : {}),
        provider: { in: [LeadSourceProvider.FILE_UPLOAD, LeadSourceProvider.GOOGLE_SHEETS] },
        archivedAt: null,
      },
      select: { id: true, name: true, provider: true, ingestStatus: true, createdAt: true, lastSuccessAt: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    if (sources.length === 0) return [];
    const ids = sources.map((s) => s.id);
    const fileIds = sources.filter((s) => s.provider === LeadSourceProvider.FILE_UPLOAD).map((s) => s.id);
    const [counts, audits] = await Promise.all([
      this.prisma.sheetImportRow.groupBy({
        by: ['leadSourceId', 'reviewState'],
        where: { orgId, leadSourceId: { in: ids }, leadId: { not: null } },
        _count: { _all: true },
      }),
      fileIds.length
        ? this.prisma.auditLog.findMany({
            where: { orgId, action: 'file_import.completed', entityType: 'lead_source', entityId: { in: fileIds } },
            orderBy: { createdAt: 'desc' },
            select: { entityId: true, actorId: true, payload: true },
          })
        : Promise.resolve([]),
    ]);
    const actorIds = [...new Set(audits.map((a) => a.actorId).filter((x): x is string => !!x))];
    const users = actorIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: actorIds }, orgId }, select: { id: true, firstName: true, lastName: true, email: true } })
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));
    const auditOf = new Map<string, (typeof audits)[number]>();
    for (const a of audits) if (a.entityId && !auditOf.has(a.entityId)) auditOf.set(a.entityId, a);
    const review = new Map<string, { pending: number; approved: number; rejected: number }>();
    for (const c of counts) {
      const r = review.get(c.leadSourceId) ?? { pending: 0, approved: 0, rejected: 0 };
      r[c.reviewState] = c._count._all;
      review.set(c.leadSourceId, r);
    }

    return sources.map((s) => {
      const audit = auditOf.get(s.id);
      const payload = (audit?.payload ?? null) as {
        fileSize?: number;
        kind?: string;
        sheet?: string | null;
        rows?: Record<string, unknown>;
        errorSample?: unknown;
      } | null;
      const by = audit?.actorId ? userById.get(audit.actorId) : undefined;
      const kind: ImportKind = s.provider === LeadSourceProvider.FILE_UPLOAD ? 'file_upload' : 'google_sheets';
      return {
        id: s.id,
        kind,
        name: s.name,
        status: s.ingestStatus,
        createdAt: s.createdAt,
        completedAt: kind === 'file_upload' ? s.lastSuccessAt : null,
        importedBy: by ? { id: by.id, name: [by.firstName, by.lastName].filter(Boolean).join(' ') || by.email } : null,
        file: payload ? { size: payload.fileSize ?? null, kind: payload.kind ?? null, sheet: payload.sheet ?? null } : null,
        rows: payload?.rows ?? null,
        errorSample: payload?.errorSample ?? [],
        review: review.get(s.id) ?? { pending: 0, approved: 0, rejected: 0 },
      };
    });
  }

  private async analyze(orgId: string, file: UploadedFileLike | undefined, columns: ColumnMapping[] | null, sheet: string | null): Promise<Analysis> {
    if (!file?.buffer) throw httpError(400, 'NO_FILE', 'Choose a CSV or Excel file to upload.');
    if (file.size > this.maxBytes) {
      throw httpError(400, 'FILE_TOO_LARGE', `The file is larger than ${Math.round(this.maxBytes / 1_048_576)} MB. Split it and upload the parts.`);
    }
    let kind: FileKind;
    let parsed: ParsedFile;
    try {
      kind = detectKind(file.originalname, file.buffer);
      parsed = await parseFile(kind, file.buffer, sheet);
    } catch (error) {
      if (error instanceof FileParseError) throw httpError(400, error.code, error.message);
      throw error;
    }

    const { grid } = parsed;
    const headers = analyzeHeaders(grid[0]);
    if (!headers.some((h) => h.fieldKey)) throw httpError(400, 'NO_HEADER_ROW', 'The first row must hold the column headings.');
    const data = grid.slice(1);
    if (data.filter((r) => r.some((c) => c)).length > MAX_DATA_ROWS) {
      throw httpError(400, 'FILE_TOO_MANY_ROWS', `This file has more than ${MAX_DATA_ROWS.toLocaleString('en-US')} rows. Split it and upload the parts.`);
    }

    const settings = await this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { defaultRegion: true } });
    const region = settings?.defaultRegion ?? 'US';
    const mapping = columns ?? suggestColumns(headers, data.slice(0, 20), region);
    const identity: Identity = { mode: 'fallback' };
    const problems = validateMapping(mapping, identity, headers);
    const usable = mapping.filter((c) => headers.some((h) => h.fieldKey === c.fieldKey && !h.duplicate));
    const ctx = {
      headerIndex: new Map(headers.filter((h) => h.fieldKey).map((h) => [h.fieldKey, h.index])),
      labels: new Map(headers.filter((h) => h.fieldKey).map((h) => [h.fieldKey, h.label])),
      mappings: expandMapping(usable, region),
      identity,
      region,
    };

    const seen = new Set<string>();
    const rows: Analysis['rows'] = [];
    const candidates: BuiltRow[] = [];
    const skipped: Partial<Record<RowIssue, number>> = {};
    const errorSample: { row: number; code: RowIssue }[] = [];
    let blank = 0;
    const skip = (built: BuiltRow, code: RowIssue) => {
      skipped[code] = (skipped[code] ?? 0) + 1;
      if (errorSample.length < ERROR_SAMPLE_LIMIT) errorSample.push({ row: built.rowNumber, code });
      rows.push({ built, issue: code });
    };
    data.forEach((cells, i) => {
      const built = buildRow(cells, i + 2, ctx);
      if (built.blank) {
        blank += 1;
        return;
      }
      if (built.issue) return skip(built, built.issue);
      if (seen.has(built.key!)) return skip(built, 'DUPLICATE_IN_FILE');
      seen.add(built.key!);
      candidates.push(built);
      rows.push({ built, issue: null });
    });

    return { kind, sheets: parsed.sheets, sheet: parsed.sheet, headers, columns: mapping, problems, dataRows: data.length, blank, candidates, rows, skipped, errorSample };
  }
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
