import { describe, expect, it } from 'vitest';
import type { Leaf } from './flatten';
import { expandFields, fieldsFromRows, suggestFields, validateFields, type MappingField } from './mapping';

const good: MappingField[] = [
  { path: 'name', target: 'full_name' },
  { path: 'contact.phone', target: 'phone' },
  { path: 'contact.email', target: 'email' },
  { path: 'budget', target: 'budget_range' },
  { path: 'beds', target: 'bedrooms' },
  { path: 'notes', target: 'motivation' },
  { path: 'consent', target: 'consent_status' },
  { path: 'meta.utm', target: 'utm_source' },
  { path: 'meta.source', target: '__custom__', customName: 'Source' },
];

const messages = (fields: MappingField[]) => validateFields(fields).map((e) => `${e.path}: ${e.message}`);

describe('validateFields', () => {
  it('accepts a complete mapping', () => {
    expect(validateFields(good)).toEqual([]);
  });

  it('requires a phone or an email', () => {
    expect(messages([{ path: 'name', target: 'full_name' }])).toEqual(['fields: Map at least one contact field: phone or email']);
  });

  it('refuses a column filled from two paths, however it is claimed', () => {
    expect(messages([...good, { path: 'other', target: 'first_name' }])).toEqual(['fields.9.target: First name is already filled from another path']);
    expect(messages([...good, { path: 'other', target: 'min_budget' }])).toEqual(['fields.9.target: Budget (min) is already filled from another path']);
  });

  it('refuses the same path mapped to the same field twice', () => {
    expect(messages([...good, { path: 'contact.phone', target: 'phone' }])).toContain('fields.9: The same path is mapped to the same field twice');
  });

  it('needs a unique name for every extra field, and names only on extra fields', () => {
    expect(messages([...good, { path: 'x', target: '__custom__' }])).toEqual(['fields.9.customName: Give the extra field a name']);
    expect(messages([...good, { path: 'x', target: '__custom__', customName: 'source' }])).toEqual(['fields.9.customName: Two paths are both named "source"']);
    expect(messages([...good, { path: 'x', target: '__custom__', customName: 'y'.repeat(61) }])[0]).toMatch(/under 60 characters/);
    expect(messages([{ path: 'p', target: 'phone', customName: 'nope' }])).toEqual(['fields.0.customName: Only an extra field takes a name']);
  });

  it('refuses a path the grammar cannot read, and an unknown target', () => {
    expect(messages([{ path: 'a..b', target: 'phone' }])[0]).toMatch(/not a path we can read/);
    expect(messages([{ path: 'a', target: 'timeline' as never }, { path: 'p', target: 'phone' }])).toEqual(['fields.0.target: "timeline" is not a field a webhook value can fill']);
  });
});

describe('expandFields / fieldsFromRows', () => {
  it('expands a full name and a budget range into two rows each, with the right transforms', () => {
    const rows = expandFields(good, 'US');
    expect(rows.map((r) => [r.source_field_key, r.target_field, r.transform])).toEqual([
      ['name', 'first_name', { kind: 'name_split', part: 'first' }],
      ['name', 'last_name', { kind: 'name_split', part: 'last' }],
      ['contact.phone', 'phone', { kind: 'phone_e164', defaultRegion: 'US' }],
      ['contact.email', 'email', { kind: 'email' }],
      ['budget', 'min_budget', { kind: 'currency_range', part: 'min' }],
      ['budget', 'max_budget', { kind: 'currency_range', part: 'max' }],
      ['beds', 'bedrooms', { kind: 'number' }],
      ['notes', 'motivation', { kind: 'text' }],
      ['consent', 'consent_status', { kind: 'boolean' }],
      ['meta.utm', 'utm_source', { kind: 'text', maxLen: 255 }],
      ['meta.source', '__custom__', { kind: 'text', maxLen: 500, label: 'Source' }],
    ]);
  });

  it('reads the saved rows back as the fields the owner chose', () => {
    const sort = (f: MappingField[]) => [...f].sort((a, b) => a.path.localeCompare(b.path) || a.target.localeCompare(b.target));
    expect(sort(fieldsFromRows(expandFields(good, 'US')))).toEqual(sort(good));
    // Separate first and last name columns stay separate.
    const split: MappingField[] = [
      { path: 'fn', target: 'first_name' },
      { path: 'ln', target: 'last_name' },
      { path: 'e', target: 'email' },
    ];
    expect(sort(fieldsFromRows(expandFields(split, 'US')))).toEqual(sort(split));
  });
});

describe('suggestFields', () => {
  const leaf = (path: string, value: string, type: Leaf['type'] = 'string'): Leaf => ({ path, value, type });

  it('guesses the obvious fields from path names and value shapes, and never a fixed-vocabulary one', () => {
    const leaves = [
      leaf('contact.email', 'ann@example.com'),
      leaf('contact.phone_number', '512-555-0101'),
      leaf('name', 'Ann Lee'),
      leaf('budget', '$400k - $500k'),
      leaf('when', 'ASAP'),
      leaf('meta', '{"a":1}', 'object'),
    ];
    const suggested = suggestFields(leaves, 'US');
    const byPath = Object.fromEntries(suggested.map((s) => [s.path, s.target]));
    expect(byPath).toMatchObject({
      'contact.email': 'email',
      'contact.phone_number': 'phone',
      name: 'full_name',
      budget: 'budget_range',
    });
    expect(suggested.some((s) => (s.target as string) === 'timeline')).toBe(false);
    expect(byPath['meta']).toBeUndefined();
  });

  it('returns nothing for a payload with no recognisable fields', () => {
    expect(suggestFields([leaf('id', '42', 'number'), leaf('ts', '1700000000', 'number')], 'US')).toEqual([]);
  });
});
