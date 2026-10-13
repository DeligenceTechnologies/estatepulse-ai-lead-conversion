import { HttpException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { AppError } from '../../common/errors';
import { newId } from '../../common/ids';
import { TENANT_PRISMA, type GuardedPrisma } from '../../prisma/prisma.service';
import { EventsBus } from '../events/events.bus';
import type { SessionIdentity } from '../google-sheets/google-connections.service';
import { DNC_REASON, DUPLICATE_REASON, GOOGLE_SHEETS_PROVIDER, RunStats, SheetImportService } from '../google-sheets/sheet-import.service';
import { SheetReviewService } from '../google-sheets/sheet-review.service';
import {
  FILE_IMPORT_REVIEW_REASON,
  FILE_UPLOAD_PROVIDER,
  MAX_DATA_ROWS,
  UPLOAD_CONNECTION,
  analyzeHeaders,
  buildRow,
  expandMapping,
  suggestColumns,
  validateMapping,
  type BuiltRow,
  type ColumnMapping,
  type Identity,
  type RowIssue,
} from '../google-sheets/sheet-rows';
import { FileParseError, detectKind, parseFile, type FileKind, type ParsedFile } from './file-parsers';

/** What multer hands over; declared here so the types package is not needed. */
export interface UploadedFileLike {
  originalname: string;
  size: number;
  buffer: Buffer;
}

export type ImportKind = 'google_sheets' | 'file_upload';

/** Rows shown in the preview table. Counts cover every row; the table shows the first of them. */
const PREVIEW_ROWS = 200;
/** Row numbers and codes only, never cell values. */
const ERROR_SAMPLE_LIMIT = 100;
/** Phones or emails per duplicate lookup, keeping each IN list bounded. */
const CONTACT_CHUNK = 2_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

const fail = (status: number, code: string, message: string, details?: { path: string; message: string }[]) =>
  new HttpException({ error: { code, message, ...(details ? { details } : {}) } }, status);

/** A removal rejects at most this many pending rows per statement, like the review endpoint. */
const REJECT_BATCH = 500;

/** One uploaded file, read under a mapping: what would be imported, and why not. */
interface Analysis {
  kind: FileKind;
  /** Worksheets in the workbook (none for a CSV), and the one that was read. */
  sheets: string[];
  sheet: string | null;
  headers: ReturnType<typeof analyzeHeaders>;
  columns: ColumnMapping[];
  problems: { path: string; message: string }[];
  dataRows: number;
  blank: number;
  /** Rows that can be imported, in file order, already unique by identity. */
  candidates: BuiltRow[];
  /** Every non-blank row, in order, with its verdict. */
  rows: { built: BuiltRow; issue: RowIssue | null }[];
  skipped: Partial<Record<RowIssue, number>>;
  errorSample: { row: number; code: RowIssue }[];
}

/**
 * Importing leads from an uploaded CSV or XLSX.
 *
 * A file is read on the server, twice at most: once for the preview and once to
 * import. Nothing is stored between the two — the browser sends the file again
 * with the mapping the owner settled on — so there is no temporary upload to
 * secure or clean up, and a preview can never turn into leads on its own.
 *
 * An upload becomes one lead_source (provider FILE_UPLOAD) and its rows are
 * written by the Google Sheets engine: paused leads with a review reason, one
 * tracking row each, in the same Import Review queue. The upload's own token
 * is the source's code, so the same request sent twice imports once.
 */
@Injectable()
export class FileImportService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma,
    private readonly importer: SheetImportService,
    private readonly reviews: SheetReviewService,
    private readonly events: EventsBus,
    private readonly config: ConfigService,
  ) {}

  get maxBytes(): number {
    return Number(this.config.get('FILE_IMPORT_MAX_BYTES') ?? DEFAULT_MAX_BYTES);
  }

  /** The limits the upload form enforces before sending anything. */
  limits() {
    return { maxBytes: this.maxBytes, maxRows: MAX_DATA_ROWS, accept: ['.csv', '.xlsx'] };
  }

  /** Read the file (one worksheet of it, for a workbook) and say what an import would do. Writes nothing. */
  async preview(organizationId: string, file: UploadedFileLike, columns: ColumnMapping[] | null, sheet: string | null) {
    const a = await this.analyze(organizationId, file, columns, sheet);
    const dup = await this.duplicates(organizationId, a.candidates);
    // Data warnings only (a bad email, an unparseable phone); duplicates and
    // opt-outs have their own counts, and the batch summary counts the same way.
    const withWarnings = a.candidates.filter((b) => b.reviewReasons.length > 0).length;
    const errors = Object.values(a.skipped).reduce((n, x) => n + (x ?? 0), 0);
    return {
      file: { name: file.originalname, size: file.size, kind: a.kind, rows: a.dataRows, sheets: a.sheets, sheet: a.sheet },
      headers: a.headers.map((h) => ({
        fieldKey: h.fieldKey,
        label: h.label,
        column: columnLetter(h.index),
        duplicate: h.duplicate,
        samples: [] as string[],
      })),
      mapping: { columns: a.columns, problems: a.problems },
      counts: {
        total: a.dataRows,
        blank: a.blank,
        importable: a.candidates.length,
        withWarnings,
        errors,
        skipped: a.skipped,
        possibleDuplicates: dup.possible,
        optedOut: dup.optedOut,
      },
      errorSample: a.errorSample,
      rows: a.rows.slice(0, PREVIEW_ROWS).map(({ built, issue }) => ({
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

  /**
   * Import the file: every importable row becomes a paused lead awaiting review.
   * `clientToken` names this upload; sending it again returns the same batch.
   */
  async commit(who: SessionIdentity, file: UploadedFileLike, columns: ColumnMapping[], clientToken: string, sheet: string | null) {
    const org = who.organizationId;
    const a = await this.analyze(org, file, columns, sheet);
    if (a.problems.length > 0) throw new AppError('VALIDATION_ERROR', 'The column mapping does not fit this file', a.problems);
    if (a.candidates.length === 0) {
      throw fail(400, 'NO_IMPORTABLE_ROWS', 'No row in this file has a name and a usable phone or email, so there is nothing to import.');
    }

    const code = `upload-${clientToken}`;
    const select = { id: true, default_consent_status: true, last_success_at: true } as const;
    let source = await this.prisma.lead_sources.findFirst({ where: { organization_id: org, code }, select });
    if (!source) {
      const id = newId();
      const region =
        (await this.prisma.organizations.findUnique({ where: { id: org }, select: { default_region: true } }))?.default_region ?? 'US';
      // "book.xlsx › Leads" when the workbook had a choice of worksheets, as a sheet source is named.
      const name = a.sheets.length > 1 ? `${file.originalname} › ${a.sheet}` : file.originalname;
      try {
        await this.prisma.$transaction([
          this.prisma.lead_sources.create({
            data: {
              id,
              organization_id: org,
              name: name.slice(0, 100),
              code,
              source_type: 'other',
              provider: FILE_UPLOAD_PROVIDER,
              connection_method: UPLOAD_CONNECTION,
              external_form_name: file.originalname.slice(0, 255),
              ingest_status: 'IMPORTING',
              mapping_status: 'CONFIGURED',
              mapping_version: 1,
              // Rows are recognised by name, phone and email: a file has no sync to disturb.
              sync_fallback_ack_at: new Date(),
              sync_fallback_ack_by: who.userId,
              is_active: true,
              default_consent_status: 'pending',
            },
          }),
          this.prisma.lead_source_field_mappings.createMany({
            data: expandMapping(a.columns, region).map((m) => ({
              id: newId(),
              organization_id: org,
              lead_source_id: id,
              source_field_key: m.source_field_key,
              target_field: m.target_field,
              transform: m.transform as unknown as Prisma.InputJsonValue,
              is_active: true,
              origin: 'USER',
            })),
          }),
        ]);
      } catch (e) {
        // The same upload sent twice at once: lead_sources_code_unique let one in.
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      }
      source = await this.prisma.lead_sources.findFirst({ where: { organization_id: org, code }, select });
      if (!source) throw fail(500, 'INTERNAL', 'The import could not be recorded. It is safe to try again.');
    }

    // Already imported under this token (a retry): the same batch, nothing twice.
    // Not yet finished (a crash mid-way): the engine skips rows it already holds.
    if (!source.last_success_at) {
      const stats = new RunStats(0);
      await this.importer.importRows(org, source.id, source.default_consent_status, a.candidates, stats, FILE_IMPORT_REVIEW_REASON);
      const now = new Date();
      await this.prisma.lead_sources.updateMany({
        where: { id: source.id, organization_id: org },
        data: { last_success_at: now, ingest_status: 'COMPLETED', updated_at: now },
      });
      await this.prisma.audit_logs.create({
        data: {
          id: newId(),
          organization_id: org,
          actor_type: 'user',
          actor_id: who.userId,
          action: 'file_import.completed',
          entity_type: 'lead_source',
          entity_id: source.id,
          payload: {
            fileName: file.originalname.slice(0, 255),
            fileSize: file.size,
            kind: a.kind,
            sheet: a.sheet,
            rows: {
              total: a.dataRows,
              blank: a.blank,
              imported: stats.inserted,
              withWarnings: a.candidates.filter((b) => b.reviewReasons.length > 0).length,
              skipped: a.skipped,
              possibleDuplicates: stats.possibleDuplicates,
              dncInherited: stats.dncInherited,
            },
            errorSample: a.errorSample,
          } as Prisma.InputJsonValue,
        },
      });
      if (stats.inserted > 0) this.events.publish({ organizationId: org, type: 'lead.created', leadSourceId: source.id });
    }
    const batch = (await this.history(org, source.id))[0];
    if (!batch) throw fail(500, 'INTERNAL', 'The import finished but could not be read back.');
    return batch;
  }

  /**
   * Remove an upload: its rows still waiting for review are rejected (closed,
   * never contacted — exactly as "Reject" would), leads the owner already
   * approved are kept, and the batch leaves the history and the filters. Its
   * tracking rows and audit records stay, so the rejected rows remain on the
   * Rejected tab under the file's name.
   */
  async remove(who: SessionIdentity, batchId: string) {
    const org = who.organizationId;
    const source = await this.prisma.lead_sources.findFirst({
      where: { id: batchId, organization_id: org, provider: FILE_UPLOAD_PROVIDER, archived_at: null },
      select: { id: true },
    });
    if (!source) throw fail(404, 'IMPORT_NOT_FOUND', 'No such file import.');
    const pending = await this.prisma.sheet_import_rows.findMany({
      where: { organization_id: org, lead_source_id: batchId, review_state: 'pending' },
      select: { id: true },
      orderBy: { created_at: 'asc' },
    });
    let rejected = 0;
    for (let i = 0; i < pending.length; i += REJECT_BATCH) {
      rejected += (
        await this.reviews.reject(
          who,
          pending.slice(i, i + REJECT_BATCH).map((p) => p.id),
        )
      ).rejected;
    }
    const now = new Date();
    await this.prisma.lead_sources.updateMany({
      where: { id: batchId, organization_id: org },
      data: { archived_at: now, ingest_status: 'REMOVED', updated_at: now },
    });
    const approvedKept = await this.prisma.sheet_import_rows.count({
      where: { organization_id: org, lead_source_id: batchId, review_state: 'approved' },
    });
    await this.prisma.audit_logs.create({
      data: {
        id: newId(),
        organization_id: org,
        actor_type: 'user',
        actor_id: who.userId,
        action: 'file_import.removed',
        entity_type: 'lead_source',
        entity_id: batchId,
        payload: { rejected, approvedKept },
      },
    });
    return { removed: true as const, rejected, approvedKept };
  }

  /**
   * Every import, newest first: uploaded files and connected sheets alike, with
   * where their rows stand in review. A removed sheet or upload is left out.
   */
  async history(organizationId: string, onlyId?: string) {
    const sources = await this.prisma.lead_sources.findMany({
      where: {
        organization_id: organizationId,
        ...(onlyId ? { id: onlyId } : {}),
        provider: { in: [FILE_UPLOAD_PROVIDER, GOOGLE_SHEETS_PROVIDER] },
        archived_at: null,
      },
      select: { id: true, name: true, provider: true, ingest_status: true, created_at: true, last_success_at: true },
      orderBy: { created_at: 'desc' },
      take: 200,
    });
    if (sources.length === 0) return [];
    const ids = sources.map((s) => s.id);
    const fileIds = sources.filter((s) => s.provider === FILE_UPLOAD_PROVIDER).map((s) => s.id);
    const [counts, audits] = await Promise.all([
      this.prisma.sheet_import_rows.groupBy({
        by: ['lead_source_id', 'review_state'],
        where: { organization_id: organizationId, lead_source_id: { in: ids } },
        _count: { _all: true },
      }),
      fileIds.length
        ? this.prisma.audit_logs.findMany({
            where: {
              organization_id: organizationId,
              action: 'file_import.completed',
              entity_type: 'lead_source',
              entity_id: { in: fileIds },
            },
            orderBy: { created_at: 'desc' },
            select: { entity_id: true, actor_id: true, payload: true },
          })
        : Promise.resolve([]),
    ]);
    const actorIds = [...new Set(audits.map((a) => a.actor_id).filter((x): x is string => !!x))];
    const users = actorIds.length
      ? await this.prisma.users.findMany({
          where: { id: { in: actorIds }, organization_members: { some: { organization_id: organizationId } } },
          select: { id: true, first_name: true, last_name: true, email: true },
        })
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));
    const auditOf = new Map<string, (typeof audits)[number]>();
    for (const a of audits) if (a.entity_id && !auditOf.has(a.entity_id)) auditOf.set(a.entity_id, a);
    const review = new Map<string, { pending: number; approved: number; rejected: number }>();
    for (const c of counts) {
      const r = review.get(c.lead_source_id) ?? { pending: 0, approved: 0, rejected: 0 };
      r[c.review_state as 'pending' | 'approved' | 'rejected'] = c._count._all;
      review.set(c.lead_source_id, r);
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
      const by = audit?.actor_id ? userById.get(audit.actor_id) : undefined;
      const kind: ImportKind = s.provider === FILE_UPLOAD_PROVIDER ? 'file_upload' : 'google_sheets';
      return {
        id: s.id,
        kind,
        name: s.name,
        status: s.ingest_status,
        createdAt: s.created_at,
        completedAt: kind === 'file_upload' ? s.last_success_at : null,
        importedBy: by ? { id: by.id, name: [by.first_name, by.last_name].filter(Boolean).join(' ') || by.email } : null,
        file: payload ? { size: payload.fileSize ?? null, kind: payload.kind ?? null, sheet: payload.sheet ?? null } : null,
        rows: payload?.rows ?? null,
        errorSample: payload?.errorSample ?? [],
        review: review.get(s.id) ?? { pending: 0, approved: 0, rejected: 0 },
      };
    });
  }

  // -------------------------------------------------------------------------

  private async analyze(
    organizationId: string,
    file: UploadedFileLike,
    columns: ColumnMapping[] | null,
    sheet: string | null,
  ): Promise<Analysis> {
    if (!file?.buffer) throw fail(400, 'NO_FILE', 'Choose a CSV or Excel file to upload.');
    if (file.size > this.maxBytes) {
      throw fail(
        400,
        'FILE_TOO_LARGE',
        `The file is larger than ${Math.round(this.maxBytes / 1_048_576)} MB. Split it and upload the parts.`,
      );
    }
    let kind: FileKind;
    let parsed: ParsedFile;
    try {
      kind = detectKind(file.originalname, file.buffer);
      parsed = await parseFile(kind, file.buffer, sheet);
    } catch (e) {
      if (e instanceof FileParseError) throw fail(400, e.code, e.message);
      throw e;
    }
    const { grid } = parsed;
    const headers = analyzeHeaders(grid[0]);
    if (!headers.some((h) => h.fieldKey)) throw fail(400, 'NO_HEADER_ROW', 'The first row must hold the column headings.');
    const data = grid.slice(1);
    const nonBlank = data.filter((r) => r.some((c) => c)).length;
    if (nonBlank > MAX_DATA_ROWS) {
      throw fail(
        400,
        'FILE_TOO_MANY_ROWS',
        `This file has more than ${MAX_DATA_ROWS.toLocaleString('en-US')} rows. Split it and upload the parts.`,
      );
    }

    const region =
      (await this.prisma.organizations.findUnique({ where: { id: organizationId }, select: { default_region: true } }))?.default_region ??
      'US';
    const sample = data.slice(0, 20);
    const mapping = columns ?? suggestColumns(headers, sample, region);
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
    return {
      kind,
      sheets: parsed.sheets,
      sheet: parsed.sheet,
      headers,
      columns: mapping,
      problems,
      dataRows: data.length,
      blank,
      candidates,
      rows,
      skipped,
      errorSample,
    };
  }

  /**
   * For the preview: which rows share a phone or email with a lead this
   * organization already has (pending imports included), or with an earlier row
   * of the file — and which match someone who opted out. The import itself
   * re-checks all of this when it writes.
   */
  private async duplicates(organizationId: string, candidates: BuiltRow[]) {
    const phones = [...new Set(candidates.map((b) => b.lead!.normalized_phone).filter((p): p is string => !!p))];
    const emails = [...new Set(candidates.map((b) => b.lead!.normalized_email).filter((e): e is string => !!e))];
    const known = { phones: new Map<string, boolean>(), emails: new Map<string, boolean>() };
    for (const [field, values, into] of [
      ['normalized_phone', phones, known.phones],
      ['normalized_email', emails, known.emails],
    ] as const) {
      for (let i = 0; i < values.length; i += CONTACT_CHUNK) {
        const found = await this.prisma.leads.findMany({
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
