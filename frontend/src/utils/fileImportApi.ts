import { apiFetch, apiUpload } from '../lib/api';
import { crmEnabled } from './crmApi';
import { googleSheetsEnabled, isSheetsDisabled, type ApproveResult, type ColumnMapping, type ImportKind, type PreviewLead } from './googleSheetsApi';
import type { OutreachChoice } from './outreachApi';

/**
 * Lead import from an uploaded CSV / XLSX (owner only).
 *
 * The file is parsed on the server, which is the only judge of what it holds.
 * Preview and import both send the file: nothing is kept on the server between
 * the two, so a preview can never become leads without the owner's click.
 */

const BASE = '/integrations/file-import';

export interface FileImportLimits {
  maxBytes: number;
  maxRows: number;
  accept: string[];
}

export type RowIssue = 'NO_NAME' | 'NO_CONTACT' | 'DUPLICATE_IN_FILE' | 'NO_ROW_ID' | 'DUPLICATE_IN_SHEET';

export interface FilePreview {
  file: {
    name: string;
    size: number;
    kind: 'csv' | 'xlsx';
    rows: number;
    /** A workbook's worksheets (none for a CSV), and the one this preview read. */
    sheets: string[];
    sheet: string | null;
  };
  headers: { fieldKey: string; label: string; column: string; duplicate: boolean; samples: string[] }[];
  mapping: { columns: ColumnMapping[]; problems: { path: string; message: string }[] };
  counts: {
    total: number;
    blank: number;
    importable: number;
    withWarnings: number;
    errors: number;
    skipped: Partial<Record<RowIssue, number>>;
    possibleDuplicates: number;
    optedOut: number;
  };
  errorSample: { row: number; code: RowIssue }[];
  /** The first rows (up to 200), each with its verdict. */
  rows: { rowNumber: number; issue: RowIssue | null; lead: PreviewLead | null; reviewReasons: string[] }[];
}

export interface ImportBatch {
  id: string;
  kind: ImportKind;
  name: string;
  status: string | null;
  createdAt: string;
  completedAt: string | null;
  importedBy: { id: string; name: string } | null;
  file: { size: number | null; kind: string | null; sheet: string | null } | null;
  /** Uploaded files only; a sheet's runs are on its card. */
  rows: {
    total?: number;
    blank?: number;
    imported?: number;
    withWarnings?: number;
    skipped?: Partial<Record<RowIssue, number>>;
    possibleDuplicates?: number;
    dncInherited?: number;
    /** "Only clean" imports: flagged rows that were not imported at all. */
    flaggedLeftOut?: number;
  } | null;
  errorSample: { row: number; code: RowIssue }[];
  review: { pending: number; approved: number; rejected: number };
  /** On an import: what happened to the rows approved as they landed. Null on a retry that imported nothing. */
  approval?: ApproveResult | null;
}

/** How far an upload has got, 0 to 1. */
export type Progress = (fraction: number) => void;

export const getFileImportLimits = (): Promise<FileImportLimits> => apiFetch<FileImportLimits>(`${BASE}/config`, { auth: true });

/** These routes exist only where the server has FILE_IMPORT_ENABLED=1; elsewhere every one answers 404. */
export const fileImportEnabled = (): Promise<boolean> =>
  getFileImportLimits().then(
    () => true,
    (e) => !isSheetsDisabled(e),
  );

/** Import Review is open while any import is switched on — sheets, files, or a CRM. */
export const importReviewEnabled = (): Promise<boolean> =>
  Promise.all([googleSheetsEnabled(), fileImportEnabled(), crmEnabled('hubspot')]).then(([sheets, files, crm]) => sheets || files || crm);

function form(file: File, fields: Record<string, string | undefined>): FormData {
  const fd = new FormData();
  fd.append('file', file, file.name);
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) fd.append(k, v);
  return fd;
}

/** `sheet` names the worksheet of a workbook; the first is read when it is null. */
export const previewFile = (
  file: File,
  columns: ColumnMapping[] | null,
  sheet: string | null,
  onProgress?: Progress,
): Promise<FilePreview> =>
  apiUpload<FilePreview>(
    `${BASE}/preview`,
    form(file, { mapping: columns ? JSON.stringify(columns) : undefined, sheet: sheet ?? undefined }),
    onProgress,
  );

/** `clientToken` names this upload: sending it again returns the same batch. */
export const importFile = (
  file: File,
  columns: ColumnMapping[],
  clientToken: string,
  sheet: string | null,
  /** Row numbers to approve as they are imported (the ticked ones); the rest wait in Import Review. */
  approveRows: number[] | null,
  /** Import only the rows without any flag, approved at once; flagged rows are left out entirely. */
  onlyClean: boolean,
  onProgress?: Progress,
  /** How the rows approved on import launch (outreach scheduling on); without it they launch now. */
  outreach?: OutreachChoice,
): Promise<ImportBatch> =>
  apiUpload<ImportBatch>(
    `${BASE}/batches`,
    form(file, {
      mapping: JSON.stringify(columns),
      clientToken,
      sheet: sheet ?? undefined,
      approveRows: !onlyClean && approveRows ? JSON.stringify(approveRows) : undefined,
      onlyClean: onlyClean ? '1' : undefined,
      outreach: outreach ? JSON.stringify(outreach) : undefined,
    }),
    onProgress,
  );

export const importHistory = (): Promise<ImportBatch[]> =>
  apiFetch<{ imports: ImportBatch[] }>(`${BASE}/history`, { auth: true }).then((r) => r.imports);

/** Rejects the upload's pending rows, keeps its approved leads, and drops it from history. */
export const removeImport = (id: string): Promise<{ removed: true; rejected: number; approvedKept: number }> =>
  apiFetch<{ removed: true; rejected: number; approvedKept: number }>(`${BASE}/batches/${id}`, { method: 'DELETE', auth: true });

/** Why a chosen file cannot be sent, before any upload — the server checks again. */
export function fileProblem(file: { name: string; size: number }, limits: FileImportLimits): string | null {
  const ext = file.name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? '';
  if (!limits.accept.includes(ext)) {
    return ext === '.xls'
      ? 'Old Excel (.xls) files are not supported. Save it as .xlsx or .csv first.'
      : `Choose a ${limits.accept.join(' or ')} file.`;
  }
  if (file.size === 0) return 'That file is empty.';
  if (file.size > limits.maxBytes) return `That file is ${formatBytes(file.size)}; the limit is ${formatBytes(limits.maxBytes)}.`;
  return null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The sample file: the columns the import recognises on its own, with one example row. */
export const TEMPLATE_CSV =
  'Full Name,Phone,Email,Location,Budget,Bedrooms,Notes\r\n' +
  'Jane Doe,+1 512-555-0101,jane@example.com,Austin TX,"$300,000 - $450,000",3,Prefers mornings\r\n';

export function downloadTemplate(): void {
  const url = URL.createObjectURL(new Blob([TEMPLATE_CSV], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'estatepulse-leads-template.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
