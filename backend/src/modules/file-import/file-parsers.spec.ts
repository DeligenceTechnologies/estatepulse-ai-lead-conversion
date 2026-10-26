import { describe, expect, it } from 'vitest';
import {
  FileParseError,
  MAX_CELL_CHARS,
  cellText,
  decodeText,
  detectKind,
  parseCsv,
  parseFile,
  parseXlsx,
  sniffDelimiter,
  zipInflatedBytes,
} from './file-parsers';
import { xlsxFixture, zip } from './xlsx-fixture.test';

describe('CSV', () => {
  it('reads quoted fields, embedded delimiters and newlines, doubled quotes, and every line ending', () => {
    const text = 'Name,Phone,Notes\r\n"Doe, Jane",+1 512-555-0101,"says ""hi""\nand bye"\rJohn,,\n';
    expect(parseCsv(text)).toEqual([
      ['Name', 'Phone', 'Notes'],
      ['Doe, Jane', '+1 512-555-0101', 'says "hi"\nand bye'],
      ['John', '', ''],
    ]);
  });

  it('keeps a phone as text: the + and leading zeros survive', () => {
    expect(parseCsv('p\n+15125550101\n00123')).toEqual([['p'], ['+15125550101'], ['00123']]);
  });

  it('keeps blank cells in place and an empty trailing cell', () => {
    expect(parseCsv('a,b,c\n1,,3\n,,')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', '3'],
      ['', '', ''],
    ]);
  });

  it('sniffs semicolons, tabs and pipes from the header line', () => {
    expect(sniffDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(sniffDelimiter('a\tb\n1\t2')).toBe('\t');
    expect(sniffDelimiter('a|b|c')).toBe('|');
    expect(sniffDelimiter('"x;y",b\n')).toBe(',');
    expect(parseCsv('Name;Email\nAnn;ann@example.test')).toEqual([
      ['Name', 'Email'],
      ['Ann', 'ann@example.test'],
    ]);
  });

  it('decodes UTF-8 with a BOM, Windows-1252, and UTF-16LE', () => {
    expect(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Zoë', 'utf8')]))).toBe('Zoë');
    expect(decodeText(Buffer.from([0x5a, 0x6f, 0xeb]))).toBe('Zoë');
    expect(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Zoë', 'utf16le')]))).toBe('Zoë');
  });

  it('truncates an oversized cell and never evaluates a formula-looking value', () => {
    const big = 'x'.repeat(MAX_CELL_CHARS + 50);
    const rows = parseCsv(`a\n${big}\n=HYPERLINK("x")`);
    expect(rows[1][0]).toHaveLength(MAX_CELL_CHARS);
    expect(rows[2][0]).toBe('=HYPERLINK("x")');
  });
});

describe('XLSX', () => {
  it('reads strings, numbers, dates, booleans and skipped (blank) cells from the first sheet', async () => {
    const file = xlsxFixture([
      ['Name', 'Phone', 'Seen', 'Beds', 'VIP'],
      ['Jane', 5125550101, { date: new Date(Date.UTC(2026, 0, 15)) }, 3, true],
      ['John', null, null, 2.5, false],
      [null, null, null, null, null],
    ]);
    const { grid, sheets, sheet } = await parseFile('xlsx', file);
    expect({ sheets, sheet }).toEqual({ sheets: ['Leads'], sheet: 'Leads' });
    expect(grid).toEqual([
      ['Name', 'Phone', 'Seen', 'Beds', 'VIP'],
      ['Jane', '5125550101', '2026-01-15', '3', 'TRUE'],
      ['John', '', '', '2.5', 'FALSE'],
    ]);
  });

  it('writes a large integer without an exponent', () => {
    expect(cellText(15125550101)).toBe('15125550101');
    expect(cellText(1e15)).toBe('1000000000000000');
  });

  it('measures the inflated size from the central directory and refuses a bomb before inflating', async () => {
    const small = xlsxFixture([['a'], ['b']]);
    expect(zipInflatedBytes(small)).toBeGreaterThan(100);
    expect(zipInflatedBytes(small)).toBeLessThan(10_000);
    // Lie in the directory: the sheet claims to inflate to 4 GB.
    const bomb = Buffer.from(small);
    const eocd = bomb.length - 22;
    let offset = bomb.readUInt32LE(eocd + 16);
    for (let n = 0; n < bomb.readUInt16LE(eocd + 10); n++) {
      bomb.writeUInt32LE(0xfffffff0, offset + 24);
      offset += 46 + bomb.readUInt16LE(offset + 28) + bomb.readUInt16LE(offset + 30) + bomb.readUInt16LE(offset + 32);
    }
    await expect(parseXlsx(bomb)).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' });
  });

  it('refuses a ZIP that is not a workbook, and a damaged one', async () => {
    const notExcel = zip([{ name: 'readme.txt', data: 'hello' }]);
    await expect(parseXlsx(notExcel)).rejects.toBeInstanceOf(FileParseError);
    await expect(parseXlsx(Buffer.from('PK\u0003\u0004garbage'))).rejects.toMatchObject({ code: 'MALFORMED_FILE' });
  });
});

describe('XLSX worksheets', () => {
  const book = () =>
    xlsxFixture([
      { name: 'Leads', rows: [['Name'], ['First sheet']] },
      { name: 'Archive', rows: [['Name'], ['Second sheet']] },
      { name: 'Empty', rows: [] },
    ]);

  it('lists every worksheet and reads the first unless one is named', async () => {
    const first = await parseFile('xlsx', book());
    expect(first.sheets).toEqual(['Leads', 'Archive', 'Empty']);
    expect(first.sheet).toBe('Leads');
    expect(first.grid).toEqual([['Name'], ['First sheet']]);
    const second = await parseFile('xlsx', book(), 'Archive');
    expect(second.sheet).toBe('Archive');
    expect(second.grid).toEqual([['Name'], ['Second sheet']]);
  });

  it('names a worksheet that is missing or empty', async () => {
    await expect(parseFile('xlsx', book(), 'Nope')).rejects.toMatchObject({ code: 'SHEET_NOT_FOUND' });
    await expect(parseFile('xlsx', book(), 'Empty')).rejects.toMatchObject({ code: 'EMPTY_FILE', message: /Worksheet “Empty” is empty/ });
  });

  it('a CSV has no worksheets, and ignores the name', async () => {
    const r = await parseFile('csv', Buffer.from('a\n1'), 'Whatever');
    expect(r).toEqual({ grid: [['a'], ['1']], sheets: [], sheet: null });
  });
});

describe('detectKind', () => {
  const PK = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]);
  it('needs the extension and the bytes to agree', () => {
    expect(detectKind('leads.csv', Buffer.from('a,b\n1,2'))).toBe('csv');
    expect(detectKind('LEADS.XLSX', PK)).toBe('xlsx');
    expect(() => detectKind('leads.xlsx', Buffer.from('a,b'))).toThrow(/not an Excel workbook/);
    expect(() => detectKind('leads.csv', PK)).toThrow(/not a text file/);
    expect(() => detectKind('leads.csv', Buffer.from([0x41, 0x00, 0x42]))).toThrow(/not a text file/);
  });
  it('names the formats it does not take', () => {
    expect(() => detectKind('leads.xls', Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))).toThrow(/\.xls/);
    expect(() => detectKind('leads.pdf', Buffer.from('%PDF'))).toThrow(/CSV .* or Excel/);
    expect(() => detectKind('leads', Buffer.from('a,b'))).toThrow(FileParseError);
  });
  it('an empty file is refused after parsing', async () => {
    await expect(parseFile('csv', Buffer.from('\n\n'))).rejects.toMatchObject({ code: 'EMPTY_FILE' });
  });
});
