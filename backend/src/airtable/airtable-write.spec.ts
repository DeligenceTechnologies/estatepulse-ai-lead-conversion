import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { CUSTOM_TARGET } from '@/google-sheets/sheet-rows';
import { airtableMerge, airtableRowKey, outboundHash, toAirtableFields } from './airtable-records';
import { recordIdOf } from './airtable-sync.service';
import { verifyMac } from './airtable-webhooks.controller';
import { DEFAULT_SYNC_CONFIG, readSyncConfig, readsIn, writesOut } from './sync-config';
import type { AirtableField } from './types';

/**
 * Writing back to Airtable, and the rules that keep two-way sync from
 * destroying data: what may be written, what an echo looks like, and what
 * happens when both sides changed.
 */

const FIELDS = new Map<string, AirtableField>(
  (
    [
      { id: 'fldName', name: 'Name', type: 'singleLineText' },
      { id: 'fldEmail', name: 'Email', type: 'email' },
      { id: 'fldPhone', name: 'Phone', type: 'phoneNumber' },
      { id: 'fldBudget', name: 'Budget', type: 'currency' },
      { id: 'fldTags', name: 'Tags', type: 'multipleSelects' },
      { id: 'fldCalc', name: 'Score', type: 'formula' },
      { id: 'fldLink', name: 'Agent', type: 'multipleRecordLinks' },
    ] as AirtableField[]
  ).map((f) => [f.id, f]),
);

const map = (pairs: [string, string][]) => pairs.map(([source_field_key, target_field]) => ({ source_field_key, target_field, transform: { kind: 'text' as const } }));

describe('what EstatePulse writes to Airtable', () => {
  it('sends only mapped fields, so an Airtable column we know nothing about is untouched', () => {
    const fields = toAirtableFields({ first_name: 'Ana', email: 'ana@example.test' }, map([['fldName', 'first_name']]), FIELDS);

    expect(fields).toEqual({ fldName: 'Ana' });
    expect(fields).not.toHaveProperty('fldEmail');
  });

  it('never writes a field Airtable computes, which would fail the whole batch', () => {
    const fields = toAirtableFields({ first_name: 'Ana' }, map([['fldCalc', 'first_name'], ['fldName', 'first_name']]), FIELDS);

    expect(fields).not.toHaveProperty('fldCalc');
    expect(fields).toEqual({ fldName: 'Ana' });
  });

  it('never writes a custom field: there is no single lead column behind it', () => {
    expect(toAirtableFields({ first_name: 'Ana' }, map([['fldTags', CUSTOM_TARGET]]), FIELDS)).toEqual({});
  });

  it('leaves out a value the lead does not have, rather than clearing what someone typed in Airtable', () => {
    // `undefined` means "we hold nothing for this"; it must not become a null that empties the cell.
    const fields = toAirtableFields({ first_name: 'Ana' }, map([['fldName', 'first_name'], ['fldEmail', 'email']]), FIELDS);
    expect(Object.keys(fields)).toEqual(['fldName']);
  });

  it('clears a cell only when the lead explicitly holds nothing there', () => {
    expect(toAirtableFields({ email: null }, map([['fldEmail', 'email']]), FIELDS)).toEqual({ fldEmail: null });
  });

  it('shapes each value for the field type it is going into', () => {
    expect(toAirtableFields({ max_budget: 450000 }, map([['fldBudget', 'max_budget']]), FIELDS)).toEqual({ fldBudget: 450000 });
    // A currency field takes a number, even when the lead stored it as text.
    expect(toAirtableFields({ max_budget: '£450,000' as never }, map([['fldBudget', 'max_budget']]), FIELDS)).toEqual({ fldBudget: 450000 });
    // A multiple-select cell is a list, even of one.
    expect(toAirtableFields({ motivation: 'Buyer' }, map([['fldTags', 'motivation']]), FIELDS)).toEqual({ fldTags: ['Buyer'] });
  });

  it('never writes a linked record: that needs the id of a row we do not have', () => {
    // With typecast on, a plain name here would have Airtable CREATE a row in
    // the other table. Writing is skipped; reading it is still fine.
    const fields = toAirtableFields({ first_name: 'Ana' }, map([['fldLink', 'first_name'], ['fldName', 'first_name']]), FIELDS);

    expect(fields).not.toHaveProperty('fldLink');
    expect(fields).toEqual({ fldName: 'Ana' });
  });

  it('skips a field that is no longer in the table instead of sending an unknown id', () => {
    expect(toAirtableFields({ first_name: 'Ana' }, map([['fldDeleted', 'first_name']]), FIELDS)).toEqual({});
  });
});

describe('loop prevention', () => {
  it('fingerprints the exact cells written, so the same write always hashes the same', () => {
    const a = toAirtableFields({ first_name: 'Ana', email: 'a@b.test' }, map([['fldName', 'first_name'], ['fldEmail', 'email']]), FIELDS);
    const b = toAirtableFields({ email: 'a@b.test', first_name: 'Ana' }, map([['fldEmail', 'email'], ['fldName', 'first_name']]), FIELDS);

    // Key order must not change the fingerprint, or every push would look like a change.
    expect(outboundHash(a)).toBe(outboundHash(b));
  });

  it('gives a different fingerprint once a value really changes', () => {
    const before = toAirtableFields({ first_name: 'Ana' }, map([['fldName', 'first_name']]), FIELDS);
    const after = toAirtableFields({ first_name: 'Anna' }, map([['fldName', 'first_name']]), FIELDS);
    expect(outboundHash(before)).not.toBe(outboundHash(after));
  });
});

describe('never writing to another source’s record', () => {
  it('writes only when the lead’s external id really is this tracking row’s record', () => {
    expect(recordIdOf('recABC', airtableRowKey('recABC'))).toBe('recABC');
  });

  it('refuses when the lead carries an id from some other source', () => {
    // The lead was linked to a HubSpot contact, or to a record in another table:
    // writing to it would put one organization's lead into another's record.
    expect(recordIdOf('901', airtableRowKey('recABC'))).toBeNull();
    expect(recordIdOf(null, airtableRowKey('recABC'))).toBeNull();
  });
});

describe('merging a change that came from Airtable', () => {
  const base = { first_name: 'Ana', email: 'ana@example.test' };

  it('takes Airtable’s value when nothing changed here since the last sync', () => {
    const r = airtableMerge(base, { ...base }, { ...base, first_name: 'Anna' });
    expect(r.apply).toEqual(['first_name']);
    expect(r.conflicts).toEqual([]);
  });

  it('reports a conflict, and writes nothing, when both sides changed the same field', () => {
    const r = airtableMerge(base, { ...base, first_name: 'Annie' }, { ...base, first_name: 'Anna' });
    expect(r.apply).toEqual([]);
    expect(r.conflicts).toEqual(['first_name']);
  });

  it('fills a field EstatePulse never had', () => {
    const r = airtableMerge(base, { ...base, location: null }, { ...base, location: 'Leeds' });
    expect(r.apply).toEqual(['location']);
  });

  it('never blanks a lead from an emptied Airtable cell', () => {
    const r = airtableMerge(base, { ...base }, { ...base, first_name: '' });
    expect(r.apply).toEqual([]);
    expect(r.conflicts).toEqual([]);
  });

  it('ignores a field Airtable has not touched since the last sync', () => {
    const r = airtableMerge(base, { ...base, first_name: 'Annie' }, { ...base });
    expect(r.apply).toEqual([]);
    expect(r.conflicts).toEqual([]);
  });

  it('treats everything as new when there is no previous sync to compare against', () => {
    const r = airtableMerge(null, { first_name: 'Annie' }, { first_name: 'Anna', email: 'a@b.test' });
    // Nothing is known to be unchanged, so a value we also hold is a conflict, not an overwrite.
    expect(r.conflicts).toEqual(['first_name']);
    expect(r.apply).toEqual(['email']);
  });
});

describe('sync direction', () => {
  it('defaults to reading only, so connecting a table never writes to it', () => {
    expect(DEFAULT_SYNC_CONFIG.direction).toBe('import');
    expect(readSyncConfig(null)).toEqual(DEFAULT_SYNC_CONFIG);
    expect(writesOut(readSyncConfig(null))).toBe(false);
  });

  it.each([
    ['import', true, false],
    ['export', false, true],
    ['two_way', true, true],
  ])('%s reads=%s writes=%s', (direction, reads, writes) => {
    const c = readSyncConfig({ direction });
    expect(readsIn(c)).toBe(reads);
    expect(writesOut(c)).toBe(writes);
  });

  it('falls back to the safe default for a value it does not recognise', () => {
    expect(readSyncConfig({ direction: 'delete_everything' })).toEqual(DEFAULT_SYNC_CONFIG);
  });
});

describe('verifying an Airtable notification', () => {
  const secret = Buffer.from('a-very-secret-key').toString('base64');
  const body = Buffer.from(JSON.stringify({ base: { id: 'appX' }, webhook: { id: 'achY' }, timestamp: 't' }));
  const sign = (b: Buffer, s: string) => `hmac-sha256=${createHmac('sha256', Buffer.from(s, 'base64')).update(b).digest('hex')}`;

  it('accepts a MAC made with the webhook’s own secret, base64-decoded as Airtable documents', () => {
    expect(verifyMac(body, secret, sign(body, secret))).toBe(true);
  });

  it('rejects a MAC from a different secret, a tampered body, and a missing header', () => {
    const other = Buffer.from('another-key').toString('base64');
    expect(verifyMac(body, secret, sign(body, other))).toBe(false);
    expect(verifyMac(Buffer.from('{"base":{"id":"appEVIL"}}'), secret, sign(body, secret))).toBe(false);
    expect(verifyMac(body, secret, undefined)).toBe(false);
    expect(verifyMac(body, secret, '')).toBe(false);
    expect(verifyMac(body, secret, 'hmac-sha256=deadbeef')).toBe(false);
  });
});

/**
 * The loop that emptied a Name column on a live base, pinned so it cannot
 * come back.
 *
 * One Airtable Name maps to TWO lead fields, both stored against the same
 * field id. Written as two cells, the second won: the column became the
 * surname, the surname was read back as the whole name, last_name emptied,
 * and the next write sent null and cleared the column outright.
 */
describe('a Name column that was split into first and last', () => {
  const split = [
    { source_field_key: 'fldName', target_field: 'first_name', transform: { kind: 'name_split' as const, part: 'first' as const } },
    { source_field_key: 'fldName', target_field: 'last_name', transform: { kind: 'name_split' as const, part: 'last' as const } },
  ];

  it('is joined back into one value, not written twice', () => {
    expect(toAirtableFields({ first_name: 'Ava', last_name: 'Chen' }, split, FIELDS)).toEqual({ fldName: 'Ava Chen' });
  });

  it('survives a round trip unchanged, which is what stopped it eroding', () => {
    const once = toAirtableFields({ first_name: 'Ava', last_name: 'Chen' }, split, FIELDS);
    // What Airtable now holds, split again on the way in, written out again.
    const backIn = { first_name: String(once.fldName).split(' ')[0], last_name: String(once.fldName).split(' ').slice(1).join(' ') };
    expect(toAirtableFields(backIn, split, FIELDS)).toEqual(once);
  });

  it('writes the first name alone when a lead has no surname, rather than clearing the column', () => {
    expect(toAirtableFields({ first_name: 'Ava', last_name: null }, split, FIELDS)).toEqual({ fldName: 'Ava' });
  });

  it('never clears a name: a lead cannot exist without one, so an empty join means we are missing it', () => {
    expect(toAirtableFields({ first_name: null, last_name: null }, split, FIELDS)).toEqual({});
    expect(toAirtableFields({}, split, FIELDS)).toEqual({});
  });
});
