import { describe, expect, it } from 'vitest';
import type { NormalizedAnswer } from '../ingest/adapters/types';
import type { Leaf } from './flatten';
import { expandFields, fieldsFromRows, suggestFields, suggestFromAnswers, validateFields, type MappingField } from './mapping';

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
    expect(messages([{ path: 'a', target: 'status' as never }, { path: 'p', target: 'phone' }])).toEqual(['fields.0.target: "status" is not a field a webhook value can fill']);
  });

  it('lets a fixed-vocabulary field be filled only through an option map with known values', () => {
    const base: MappingField = { path: 'p', target: 'phone' };
    expect(messages([base, { path: 'q', target: 'timeline' }])).toEqual(['fields.1.transform: Timeline needs an option map; only a form\'s choice question can fill it']);
    expect(messages([base, { path: 'q', target: 'timeline', transform: { kind: 'enum_map', byOptionText: { asap: 'soon' } } }])[0]).toMatch(/"soon" is not one of/);
    expect(messages([base, { path: 'q', target: 'timeline', transform: { kind: 'enum_map', byOptionText: { asap: 'under_30_days' } } }])).toEqual([]);
    expect(messages([{ ...base, transform: { kind: 'enum_map', byOptionText: {} } }])).toEqual(['fields.0.transform: Only a timeline, intent or financing field takes an option map']);
  });
});

describe('enum targets through the rows', () => {
  const field: MappingField = { path: 'question_4', target: 'timeline', transform: { kind: 'enum_map', byOptionText: { 'asap / under 30 days': 'under_30_days' } } };
  it('stores the option map as the transform and reads it back', () => {
    const rows = expandFields([{ path: 'e', target: 'email' }, field], 'US');
    expect(rows[1]).toEqual({ source_field_key: 'question_4', target_field: 'timeline', transform: { kind: 'enum_map', byOptionText: { 'asap / under 30 days': 'under_30_days' }, fallback: null } });
    expect(fieldsFromRows(rows)).toEqual([{ path: 'e', target: 'email' }, { ...field, transform: { ...field.transform, fallback: null } }]);
  });
});

describe('suggestFromAnswers (a form provider\'s questions)', () => {
  const answer = (key: string, label: string, type: string, text: string, allOptions?: { id: string; text: string }[]): NormalizedAnswer => ({
    key,
    label,
    type,
    raw: text,
    textValues: text ? [text] : [],
    scalarText: text,
    ...(allOptions ? { allOptions } : {}),
  });

  it('keeps the provider\'s own guesses, option maps included', () => {
    const suggested = suggestFromAnswers(
      [
        answer('question_1', 'Your name', 'INPUT_TEXT', 'Ann Lee'),
        answer('question_2', 'Email address', 'INPUT_EMAIL', 'ann@example.com'),
        answer('question_3', 'Phone', 'INPUT_PHONE_NUMBER', '(512) 555-0101'),
        answer('question_4', 'When are you looking to move?', 'MULTIPLE_CHOICE', 'ASAP / under 30 days', [
          { id: 'a', text: 'ASAP / under 30 days' },
          { id: 'b', text: '1-3 months' },
        ]),
      ],
      'US',
    );
    const byPath = Object.fromEntries(suggested.map((s) => [s.path, s]));
    expect(byPath['question_1']).toEqual({ path: 'question_1', target: 'full_name' });
    expect(byPath['question_2']).toEqual({ path: 'question_2', target: 'email' });
    expect(byPath['question_3']).toEqual({ path: 'question_3', target: 'phone' });
    expect(byPath['question_4']).toEqual({
      path: 'question_4',
      target: 'timeline',
      transform: { kind: 'enum_map', byOptionText: { 'asap / under 30 days': 'under_30_days', '1-3 months': '1_to_3_months' }, fallback: null },
    });
    // The buying_intent guess on the same question carries an empty map: not offered.
    expect(suggested.filter((s) => s.path === 'question_4')).toHaveLength(1);
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
