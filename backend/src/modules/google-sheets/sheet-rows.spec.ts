import { describe, expect, it } from 'vitest';
import {
  PHONE_UNPARSED_REASON,
  analyzeHeaders,
  buildRow,
  expandMapping,
  headerFingerprint,
  identityCandidates,
  suggestColumns,
  validateMapping,
  type ColumnMapping,
  type Identity,
} from './sheet-rows';

const HEADER = ['Lead ID', 'Name', 'Phone', 'Email', 'Budget', 'Beds', 'Notes'];
const headers = analyzeHeaders(HEADER);
const COLUMNS: ColumnMapping[] = [
  { fieldKey: 'name', target: 'full_name' },
  { fieldKey: 'phone', target: 'phone' },
  { fieldKey: 'email', target: 'email' },
  { fieldKey: 'budget', target: 'min_budget' },
  { fieldKey: 'budget', target: 'max_budget' },
  { fieldKey: 'beds', target: 'bedrooms' },
  { fieldKey: 'notes', target: '__custom__' },
];
const BY_ID: Identity = { mode: 'column', fieldKey: 'lead id' };

const ctx = (identity: Identity = BY_ID, columns = COLUMNS) => ({
  headerIndex: new Map(headers.filter((h) => h.fieldKey).map((h) => [h.fieldKey, h.index])),
  labels: new Map(headers.filter((h) => h.fieldKey).map((h) => [h.fieldKey, h.label])),
  mappings: expandMapping(columns, 'US'),
  identity,
  region: 'US',
});
const row = (cells: string[], identity?: Identity) => buildRow(cells, 7, ctx(identity));

describe('headers', () => {
  it('keys ignore case and spacing; blank cells cannot be mapped; repeats are ambiguous', () => {
    const h = analyzeHeaders(['  Email ', 'email', '', 'Phone  Number']);
    expect(h.map((x) => x.fieldKey)).toEqual(['email', 'email', '', 'phone number']);
    expect(h.map((x) => x.duplicate)).toEqual([true, true, false, false]);
  });

  it('fingerprint ignores column order but not a rename', () => {
    const a = headerFingerprint(analyzeHeaders(['A', 'B']));
    expect(headerFingerprint(analyzeHeaders(['B', 'A']))).toBe(a);
    expect(headerFingerprint(analyzeHeaders(['A', 'C']))).not.toBe(a);
  });
});

describe('validateMapping', () => {
  it('accepts a complete mapping', () => {
    expect(validateMapping(COLUMNS, BY_ID, headers)).toEqual([]);
  });

  it('requires a name and a contact column', () => {
    const msgs = validateMapping([{ fieldKey: 'notes', target: '__custom__' }], { mode: 'fallback' }, headers).map((e) => e.message);
    expect(msgs.some((m) => /name/.test(m))).toBe(true);
    expect(msgs.some((m) => /phone or email/.test(m))).toBe(true);
  });

  it('refuses a column the sheet does not have, and an identity column that is missing', () => {
    const errors = validateMapping([...COLUMNS, { fieldKey: 'zip', target: 'location' }], { mode: 'column', fieldKey: 'crm id' }, headers);
    expect(errors.map((e) => e.path)).toEqual(expect.arrayContaining(['columns.7.fieldKey', 'identity.fieldKey']));
  });

  it('refuses an ambiguous (repeated) header', () => {
    const dup = analyzeHeaders(['Name', 'Phone', 'Phone']);
    const errors = validateMapping([{ fieldKey: 'name', target: 'first_name' }, { fieldKey: 'phone', target: 'phone' }], { mode: 'fallback' }, dup);
    expect(errors[0].message).toMatch(/more than once/);
  });

  it('refuses one field filled from two columns, including a full name plus a first name', () => {
    const errors = validateMapping(
      [...COLUMNS, { fieldKey: 'notes', target: 'first_name' }],
      BY_ID,
      headers,
    );
    expect(errors.some((e) => /already filled/.test(e.message))).toBe(true);
  });
});

describe('buildRow', () => {
  const cells = ['EP-1001', 'Aarav Sharma', '1 512-555-0101', 'AARAV@Example.test', '$300,000 - $450,000', '3', 'Wants a yard'];

  it('normalizes with the same rules as the form pipeline', () => {
    const r = row(cells);
    expect(r.issue).toBeUndefined();
    expect(r.lead).toMatchObject({
      first_name: 'Aarav',
      last_name: 'Sharma',
      phone: '+15125550101',
      normalized_phone: '+15125550101',
      phone_valid: true,
      email: 'aarav@example.test',
      normalized_email: 'aarav@example.test',
      email_valid: true,
      min_budget: 300000,
      max_budget: 450000,
      bedrooms: 3,
      custom_fields: { Notes: 'Wants a yard' },
    });
    expect(r.externalId).toBe('EP-1001');
    expect(r.reviewReasons).toEqual([]);
  });

  it('a row with nothing in the mapped columns is blank, not an error', () => {
    expect(row(['', '', '', '', '', '', '']).blank).toBe(true);
  });

  it.each([
    ['NO_ROW_ID', ['', 'Aarav Sharma', '512-555-0101', '', '', '', '']],
    ['NO_NAME', ['EP-2', '', '512-555-0101', 'a@example.test', '', '', '']],
    ['NO_CONTACT', ['EP-3', 'Aarav', 'call me', 'not-an-email', '', '', '']],
  ])('%s', (issue, c) => {
    expect(row(c as string[]).issue).toBe(issue);
  });

  it('a refused row keeps its ID identity, so it is not mistaken for a deleted one', () => {
    const r = row(['EP-1001', 'Aarav', 'call me', 'not-an-email', '', '', '']);
    expect(r.issue).toBe('NO_CONTACT');
    expect(r.key).toBe(row(cells).key);
  });

  it('keeps an unparseable phone when the email works, and flags it for review', () => {
    const r = row(['EP-4', 'Aarav', '12345', 'a@example.test', '', '', '']);
    expect(r.issue).toBeUndefined();
    expect(r.lead?.normalized_phone).toBeNull();
    expect(r.reviewReasons).toContain(PHONE_UNPARSED_REASON);
  });

  it('keeps an invalid email when the phone works, and says so exactly once', () => {
    const r = row(['EP-5', 'Aarav', '512-555-0101', 'not-an-email', '', '', '']);
    expect(r.issue).toBeUndefined();
    expect(r.lead).toMatchObject({ email: 'not-an-email', email_valid: false, normalized_email: null });
    expect(r.reviewReasons.filter((x) => /not-an-email/.test(x))).toHaveLength(1);
  });

  it('demotes an implausible value to custom fields instead of losing it', () => {
    const r = row(['EP-5', 'Aarav', '512-555-0101', '', '', '50', '']);
    expect(r.lead?.bedrooms).toBeNull();
    expect(r.lead?.custom_fields).toMatchObject({ 'Bedrooms (unvalidated)': '50' });
  });

  it('identity by ID column ignores the row number and every other cell', () => {
    const a = buildRow(cells, 2, ctx());
    const b = buildRow([...cells.slice(0, 6), 'Changed notes'], 99, ctx());
    expect(b.key).toBe(a.key);
    expect(b.hash).not.toBe(a.hash);
  });

  it('fallback identity follows phone, email and name — an edit makes a new identity', () => {
    const fb: Identity = { mode: 'fallback' };
    const a = row(cells, fb);
    expect(row([...cells.slice(0, 6), 'other notes'], fb).key).toBe(a.key);
    expect(row(['EP-1001', 'Aarav Shah', ...cells.slice(2)], fb).key).not.toBe(a.key);
    expect(row(['EP-1001', 'Aarav Sharma', '512-555-0199', ...cells.slice(3)], fb).key).not.toBe(a.key);
  });

  it('the content hash does not depend on whitespace in unmapped formatting', () => {
    expect(row([' EP-1001 ', ' Aarav Sharma ', ...cells.slice(2)]).hash).toBe(row(cells).hash);
  });
});

describe('suggestions', () => {
  it('suggests sheet-safe targets only, with a name column as full name', () => {
    const h = analyzeHeaders(['Full Name', 'Mobile', 'Email Address', 'Timeline', 'Consent']);
    const s = suggestColumns(h, [['Priya Patel', '512-555-0102', 'p@example.test', '0-3 months', 'yes']], 'US');
    expect(s).toEqual(
      expect.arrayContaining([
        { fieldKey: 'full name', target: 'full_name' },
        { fieldKey: 'mobile', target: 'phone' },
        { fieldKey: 'email address', target: 'email' },
      ]),
    );
    expect(s.map((x) => x.target)).not.toContain('timeline');
    expect(s.map((x) => x.target)).not.toContain('consent_status');
  });

  it('offers an id-like column for identity, and never a phone or email column', () => {
    const sample = [
      ['EP-1', 'a@example.test', '512-555-0101'],
      ['EP-2', 'b@example.test', '512-555-0102'],
    ];
    expect(identityCandidates(analyzeHeaders(['Lead ID', 'Email', 'Phone']), sample)).toEqual(['lead id']);
  });

  it('offers an unnamed code-like unique column, but not unique free text or amounts', () => {
    const sample = [
      ['CRM-77', 'Test lead 1', '$205,000 - $305,000'],
      ['CRM-78', 'Test lead 2', '$210,000 - $310,000'],
    ];
    expect(identityCandidates(analyzeHeaders(['Ref Code', 'Notes', 'Budget']), sample)).toEqual(['ref code']);
  });
});
