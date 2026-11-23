import { describe, expect, it } from 'vitest';
import { CUSTOM_TARGET, FULL_NAME_TARGET, expandMapping } from '@/google-sheets/sheet-rows';
import { airtableRowKey, buildAirtableRow, cellToText, compatible, isReadOnly, kindOf, rowContext } from './airtable-records';
import type { AirtableField } from './types';

const field = (id: string, name: string, type: string): AirtableField => ({ id, name, type });

const FIELDS = [
  field('fldName', 'Name', 'singleLineText'),
  field('fldEmail', 'Email', 'email'),
  field('fldPhone', 'Phone', 'phoneNumber'),
  field('fldBudget', 'Budget', 'currency'),
  field('fldTags', 'Tags', 'multipleSelects'),
  field('fldDone', 'Done', 'checkbox'),
];

const ctx = (columns: { fieldKey: string; target: string }[]) =>
  rowContext(FIELDS, expandMapping(columns as never));

describe('reading an Airtable cell as text', () => {
  it.each([
    ['a string', 'Ana', 'Ana'],
    ['a number', 1250, '1250'],
    ['a checked box', true, 'true'],
    ['an unchecked box', false, ''],
    ['an empty cell Airtable omits', undefined, ''],
    ['a multiple select', ['Buyer', 'Hot'], 'Buyer, Hot'],
    ['a collaborator', { id: 'usr1', email: 'a@b.test', name: 'Ana' }, 'Ana'],
    ['a barcode', { text: '12345', type: 'upce' }, '12345'],
  ])('reads %s', (_name, value, expected) => {
    expect(cellToText(value)).toBe(expected);
  });

  it('never invents text for a value that has none', () => {
    // An attachment array of objects with no name/filename must not read as "[object Object]".
    expect(cellToText([{ id: 'att1', size: 10 }])).toBe('');
    expect(cellToText({ state: 'generated', isStale: false })).toBe('');
  });
});

describe('field type compatibility', () => {
  it('fills a phone only from something textual, because a number has lost its country code', () => {
    expect(compatible('phoneNumber', 'phone')).toBe(true);
    expect(compatible('singleLineText', 'phone')).toBe(true);
    // EstatePulse never guesses a country, and a number field cannot hold a leading '+'.
    expect(compatible('number', 'phone')).toBe(false);
    expect(compatible('date', 'phone')).toBe(false);
  });

  it('fills a budget from a number or from text the numeric transform can parse', () => {
    expect(compatible('currency', 'min_budget')).toBe(true);
    expect(compatible('number', 'max_budget')).toBe(true);
    expect(compatible('singleLineText', 'min_budget')).toBe(true);
    expect(compatible('dateTime', 'min_budget')).toBe(false);
  });

  it('refuses a checkbox everywhere but a custom field', () => {
    expect(compatible('checkbox', 'first_name')).toBe(false);
    expect(compatible('checkbox', FULL_NAME_TARGET)).toBe(false);
    expect(compatible('checkbox', CUSTOM_TARGET)).toBe(true);
  });

  it('allows a formula, whose value is validated when it is read, but not an attachment', () => {
    expect(compatible('formula', 'email')).toBe(true);
    expect(compatible('rollup', 'min_budget')).toBe(true);
    expect(compatible('multipleAttachments', 'first_name')).toBe(false);
    expect(compatible('button', 'location')).toBe(false);
  });

  it('knows which types Airtable computes and will not accept a write for', () => {
    for (const t of ['formula', 'rollup', 'count', 'multipleLookupValues', 'createdTime', 'lastModifiedTime', 'autoNumber', 'button']) {
      expect(isReadOnly(t)).toBe(true);
    }
    for (const t of ['singleLineText', 'email', 'phoneNumber', 'number', 'currency', 'checkbox', 'singleSelect', 'multipleSelects']) {
      expect(isReadOnly(t)).toBe(false);
    }
    expect(kindOf('singleSelect')).toBe('text');
    expect(kindOf('somethingAirtableAddedLater')).toBe('complex');
  });
});

describe('building a row from an Airtable record', () => {
  const mapping = [
    { fieldKey: 'fldName', target: FULL_NAME_TARGET },
    { fieldKey: 'fldEmail', target: 'email' },
    { fieldKey: 'fldPhone', target: 'phone' },
    { fieldKey: 'fldBudget', target: 'max_budget' },
    { fieldKey: 'fldTags', target: CUSTOM_TARGET },
  ];

  it('keys the row by the Airtable record id, not by email or phone', () => {
    const row = buildAirtableRow(
      { id: 'recABC123', fields: { fldName: 'Ana Patel', fldEmail: 'ana@example.test', fldPhone: '+14155550123' } },
      0,
      ctx(mapping),
    );

    expect(row.externalId).toBe('recABC123');
    expect(row.key).toBe(airtableRowKey('recABC123'));
    expect(row.lead).toMatchObject({ first_name: 'Ana', last_name: 'Patel', normalized_email: 'ana@example.test' });
  });

  it('keeps the key stable when the contact details change, so the same record updates its lead', () => {
    const before = buildAirtableRow({ id: 'recABC123', fields: { fldName: 'Ana', fldEmail: 'ana@example.test' } }, 0, ctx(mapping));
    const after = buildAirtableRow({ id: 'recABC123', fields: { fldName: 'Ana', fldEmail: 'moved@example.test' } }, 0, ctx(mapping));

    expect(after.key).toBe(before.key);
    // ...but the content fingerprint moves, which is what tells the sync something changed.
    expect(after.hash).not.toBe(before.hash);
  });

  it('fingerprints only the mapped values, so an edit to an unmapped Airtable field is not a change', () => {
    const base = { fldName: 'Ana', fldEmail: 'ana@example.test' };
    const mapped = buildAirtableRow({ id: 'rec1', fields: base }, 0, ctx(mapping));
    const unmappedChanged = buildAirtableRow({ id: 'rec1', fields: { ...base, fldDone: true } }, 0, ctx(mapping));

    expect(unmappedChanged.hash).toBe(mapped.hash);
  });

  it('never fills a lead field from a column the owner did not map', () => {
    const onlyName = [
      { fieldKey: 'fldName', target: FULL_NAME_TARGET },
      { fieldKey: 'fldEmail', target: 'email' },
    ];
    const row = buildAirtableRow(
      { id: 'rec1', fields: { fldName: 'Ana', fldEmail: 'ana@example.test', fldBudget: 450000, fldPhone: '+14155550123' } },
      0,
      ctx(onlyName),
    );

    expect(row.lead?.max_budget).toBeNull();
    expect(row.lead?.phone).toBeNull();
  });

  it('carries an unmapped-but-chosen field verbatim as a custom field, under its Airtable name', () => {
    const row = buildAirtableRow({ id: 'rec1', fields: { fldName: 'Ana', fldEmail: 'ana@example.test', fldTags: ['Buyer', 'Hot'] } }, 0, ctx(mapping));
    expect(row.lead?.custom_fields).toEqual({ Tags: 'Buyer, Hot' });
  });

  it('refuses a record with no way to reach the person, and still keys it so it is not read as deleted', () => {
    const row = buildAirtableRow({ id: 'recNoContact', fields: { fldName: 'Ana' } }, 0, ctx(mapping));

    expect(row.issue).toBeTruthy();
    expect(row.lead).toBeUndefined();
    expect(row.key).toBe(airtableRowKey('recNoContact'));
  });

  it('reports an empty record as skippable rather than blank, and keeps its key', () => {
    // A sheet row with nothing in it is noise. An Airtable record always exists,
    // so one with no mapped values is reported with an issue and still keyed —
    // otherwise the next sync would read it as a record that had been deleted.
    const row = buildAirtableRow({ id: 'recEmpty', fields: { fldDone: true } }, 0, ctx(mapping));

    expect(row.blank).toBe(false);
    expect(row.issue).toBe('NO_NAME');
    expect(row.key).toBe(airtableRowKey('recEmpty'));
  });
});
