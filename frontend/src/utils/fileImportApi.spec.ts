import { describe, expect, it } from 'vitest';
import { TEMPLATE_CSV, fileProblem, formatBytes } from './fileImportApi';

const limits = { maxBytes: 5 * 1024 * 1024, maxRows: 10_000, accept: ['.csv', '.xlsx'] };

describe('fileProblem', () => {
  it('accepts a CSV or XLSX within the limit, whatever the case of the name', () => {
    expect(fileProblem({ name: 'Leads.CSV', size: 10 }, limits)).toBeNull();
    expect(fileProblem({ name: 'leads.xlsx', size: limits.maxBytes }, limits)).toBeNull();
  });
  it('names the problem: wrong type, old Excel, empty, too big', () => {
    expect(fileProblem({ name: 'leads.pdf', size: 10 }, limits)).toMatch(/\.csv or \.xlsx/);
    expect(fileProblem({ name: 'leads', size: 10 }, limits)).toMatch(/\.csv or \.xlsx/);
    expect(fileProblem({ name: 'leads.xls', size: 10 }, limits)).toMatch(/\.xls/);
    expect(fileProblem({ name: 'leads.csv', size: 0 }, limits)).toMatch(/empty/);
    expect(fileProblem({ name: 'leads.csv', size: limits.maxBytes + 1 }, limits)).toMatch(/limit is 5\.0 MB/);
  });
});

describe('template', () => {
  it('holds the recognised headings and one example row, with a + phone and a quoted budget', () => {
    const [header, row] = TEMPLATE_CSV.split('\r\n');
    expect(header).toBe('Full Name,Phone,Email,Location,Budget,Bedrooms,Notes');
    expect(row).toContain('+1 512-555-0101');
    expect(row).toContain('"$300,000 - $450,000"');
  });
  it('formats sizes for people', () => {
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(40 * 1024)).toBe('40 KB');
    expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.5 MB');
  });
});
