import readWorkbook from 'read-excel-file/node';

/**
 * Pure file parsing: bytes in, a grid of trimmed cell strings out. No database,
 * no request. Everything downstream (headers, mapping, row building) is the same
 * code the Google Sheets import uses, so a CSV cell and a sheet cell are read
 * identically.
 *
 * What a file may be is decided from its bytes, never from the Content-Type the
 * browser sent: a CSV is text with no NUL bytes, an XLSX is a ZIP. The extension
 * must agree, so a renamed executable is refused whatever it claims to be.
 */

export type FileKind = 'csv' | 'xlsx';

/** A cell longer than this is truncated: no lead field holds more, and it bounds memory. */
export const MAX_CELL_CHARS = 2_000;
/** The XLSX may inflate to at most this much XML (a 5 MB zip bomb would otherwise exhaust memory). */
export const MAX_XLSX_INFLATED_BYTES = 64 * 1024 * 1024;

/** A parsed file: the chosen worksheet's cells, and the worksheets it could have been. */
export interface ParsedFile {
  grid: string[][];
  /** Worksheet names, in workbook order. Empty for a CSV. */
  sheets: string[];
  /** The worksheet the grid came from; null for a CSV. */
  sheet: string | null;
}

export class FileParseError extends Error {
  constructor(
    readonly code: 'UNSUPPORTED_FILE' | 'MALFORMED_FILE' | 'EMPTY_FILE' | 'SHEET_NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'FileParseError';
  }
}

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** Which parser the file gets, from its extension AND its leading bytes. */
export function detectKind(filename: string, bytes: Buffer): FileKind {
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const isZip = bytes.length >= 4 && bytes.subarray(0, 4).equals(ZIP_MAGIC);
  if (ext === 'xlsx') {
    if (!isZip) throw new FileParseError('MALFORMED_FILE', 'This .xlsx file is not an Excel workbook.');
    return 'xlsx';
  }
  if (ext === 'csv') {
    if (isZip) throw new FileParseError('MALFORMED_FILE', 'This .csv file is not a text file.');
    // Text never contains NUL; a binary renamed to .csv does (UTF-16 is handled before this).
    const sample = decodeText(bytes.subarray(0, 4096));
    if (sample.includes('\u0000')) throw new FileParseError('MALFORMED_FILE', 'This .csv file is not a text file.');
    return 'csv';
  }
  if (ext === 'xls') {
    throw new FileParseError(
      'UNSUPPORTED_FILE',
      'Old Excel (.xls) files are not supported. Save the file as .xlsx or .csv and upload that.',
    );
  }
  throw new FileParseError('UNSUPPORTED_FILE', 'Upload a CSV (.csv) or Excel (.xlsx) file.');
}

/** `sheet` picks a worksheet of an XLSX by name; the first one otherwise. Ignored for a CSV. */
export async function parseFile(kind: FileKind, bytes: Buffer, sheet: string | null = null): Promise<ParsedFile> {
  const parsed: ParsedFile =
    kind === 'csv' ? { grid: parseCsv(decodeText(bytes)), sheets: [], sheet: null } : await parseXlsx(bytes, sheet);
  // Trailing blank rows are not data, whatever the file says.
  const { grid } = parsed;
  while (grid.length && grid[grid.length - 1].every((c) => !c)) grid.pop();
  if (grid.length === 0) {
    throw new FileParseError('EMPTY_FILE', parsed.sheets.length > 1 ? `Worksheet “${parsed.sheet}” is empty.` : 'The file is empty.');
  }
  return parsed;
}

// --- CSV --------------------------------------------------------------------------

/**
 * Bytes to text. UTF-8 (with or without a BOM) when it decodes cleanly; otherwise
 * Windows-1252, which is what Excel on Windows writes as "CSV". A UTF-16 BOM is
 * honoured too (Excel's "Unicode Text").
 */
export function decodeText(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const body = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return new TextDecoder('windows-1252').decode(body);
  }
}

/** The delimiter is whichever of , ; tab | the first line uses most, outside quotes. */
export function sniffDelimiter(text: string): string {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const counts = new Map<string, number>([
    [',', 0],
    [';', 0],
    ['\t', 0],
    ['|', 0],
  ]);
  let quoted = false;
  for (const ch of firstLine) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && counts.has(ch)) counts.set(ch, counts.get(ch)! + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0][0] || ',';
}

/**
 * RFC 4180 with the usual tolerance: any of CRLF / LF / CR ends a row, a quoted
 * field may hold the delimiter and newlines, and "" inside quotes is one quote.
 * Every value is kept as text — nothing is parsed as a number, a date or a
 * formula — so a phone keeps its leading + and its zeros.
 */
export function parseCsv(text: string, delimiter = sniffDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  const push = () => {
    row.push(cell.length > MAX_CELL_CHARS ? cell.slice(0, MAX_CELL_CHARS) : cell);
    cell = '';
  };
  const endRow = () => {
    push();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) push();
    else if (ch === '\n') endRow();
    else if (ch === '\r') {
      endRow();
      if (text[i + 1] === '\n') i += 1;
    } else cell += ch;
    i += 1;
  }
  if (cell !== '' || row.length > 0) endRow();
  return rows.map((r) => r.map((c) => c.trim()));
}

// --- XLSX -------------------------------------------------------------------------

/**
 * What the ZIP would inflate to, read from its central directory before anything
 * is inflated. A ZIP64 archive is refused outright: no lead file needs it.
 */
export function zipInflatedBytes(bytes: Buffer): number {
  // End-of-central-directory record: signature 0x06054b50, within the last 64 KB + 22.
  const start = Math.max(0, bytes.length - 65_557);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= start; i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new FileParseError('MALFORMED_FILE', 'This .xlsx file is damaged (no ZIP directory).');
  const entries = bytes.readUInt16LE(eocd + 10);
  let offset = bytes.readUInt32LE(eocd + 16);
  if (entries === 0xffff || offset === 0xffffffff) throw new FileParseError('UNSUPPORTED_FILE', 'ZIP64 workbooks are not supported.');
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) {
      throw new FileParseError('MALFORMED_FILE', 'This .xlsx file is damaged (bad ZIP directory).');
    }
    const size = bytes.readUInt32LE(offset + 24);
    if (size === 0xffffffff) throw new FileParseError('UNSUPPORTED_FILE', 'ZIP64 workbooks are not supported.');
    total += size;
    offset += 46 + bytes.readUInt16LE(offset + 28) + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return total;
}

/**
 * One worksheet — the named one, or the first — every cell as text. Dates become
 * YYYY-MM-DD; numbers never use exponents. The workbook is read whole (its
 * inflated size is bounded above) so the other worksheets can be offered.
 */
export async function parseXlsx(bytes: Buffer, sheet: string | null = null): Promise<ParsedFile> {
  if (zipInflatedBytes(bytes) > MAX_XLSX_INFLATED_BYTES) {
    throw new FileParseError('UNSUPPORTED_FILE', 'This workbook is too large to import. Export the leads sheet as CSV instead.');
  }
  let book: { sheet: string; data: (string | number | boolean | Date | null)[][] }[];
  try {
    book = (await readWorkbook(bytes)) as typeof book;
  } catch {
    throw new FileParseError('MALFORMED_FILE', 'This .xlsx file could not be read. Save it again from Excel and retry.');
  }
  if (book.length === 0) throw new FileParseError('EMPTY_FILE', 'This workbook has no worksheets.');
  const sheets = book.map((s) => s.sheet);
  const chosen = sheet === null ? book[0] : book.find((s) => s.sheet === sheet);
  if (!chosen) throw new FileParseError('SHEET_NOT_FOUND', `There is no worksheet called “${sheet}” in this workbook.`);
  return { grid: chosen.data.map((r) => r.map(cellText)), sheets, sheet: chosen.sheet };
}

export function cellText(v: string | number | boolean | Date | null): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  if (typeof v === 'number') return (Number.isInteger(v) ? v.toFixed(0) : String(v)).slice(0, MAX_CELL_CHARS);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v).trim().slice(0, MAX_CELL_CHARS);
}
