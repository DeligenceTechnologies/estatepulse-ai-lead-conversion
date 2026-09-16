import { describe, expect, it } from 'vitest';
import { prebuildMappings, schemaFingerprint, toSyntheticAnswers } from './prebuild-mapping';
import type { DescribedField } from '../providers/tally/tally-form-schema';

const field = (over: Partial<DescribedField>): DescribedField => ({
  key: 'question_x',
  label: 'Question',
  type: 'INPUT_TEXT',
  externalQuestionId: 'x',
  booleanOptIn: false,
  ...over,
});

/** Mirrors a real Tally lead form, consent checkbox and all. */
const FORM: DescribedField[] = [
  field({ key: 'question_2xELzL', label: 'First name', type: 'INPUT_TEXT', externalQuestionId: '2xELzL' }),
  field({ key: 'question_RBGR1J', label: 'Email', type: 'INPUT_EMAIL', externalQuestionId: 'RBGR1J' }),
  field({ key: 'question_d2EggK', label: 'Number we can reach you on', type: 'INPUT_PHONE_NUMBER', externalQuestionId: 'd2EggK' }),
  field({
    key: 'question_YzPeeJ',
    label: 'When are you hoping to move?',
    type: 'MULTIPLE_CHOICE',
    externalQuestionId: 'YzPeeJ',
    options: [
      { id: 'o1', text: '1-3 months' },
      { id: 'o2', text: '3-6 months' },
      { id: 'o3', text: '6+ months' },
    ],
  }),
  // The consent checkbox: null title on the real form, so it arrives here with
  // a generated label and the boolean-opt-in flag set.
  field({ key: 'question_V1LVXv', label: 'Untitled checkboxes', type: 'CHECKBOXES', externalQuestionId: 'V1LVXv', booleanOptIn: true }),
];

describe('prebuildMappings', () => {
  const result = prebuildMappings(FORM, 'US');
  const target = (t: string) => result.mappings.find((m) => m.targetField === t);

  it('maps the contactable fields from a schema with no answers in it', () => {
    expect(target('email')?.sourceFieldKey).toBe('question_RBGR1J');
    expect(target('phone')?.sourceFieldKey).toBe('question_d2EggK');
    expect(target('first_name')?.sourceFieldKey).toBe('question_2xELzL');
  });

  it('builds the dropdown enum map from the option set alone', () => {
    const t = target('timeline')!.transform as { kind: string; byOptionText: Record<string, string> };
    expect(t.kind).toBe('enum_map');
    expect(t.byOptionText['3-6 months']).toBe('3_to_6_months');
  });

  /**
   * The compliance rule. Getting consent wrong means texting somebody who never
   * agreed, and unlike every other field that mistake is invisible until a
   * complaint arrives — so it is the one target a schema may never decide.
   */
  it('never pre-maps consent, and says so instead of staying silent', () => {
    expect(target('consent_status')).toBeUndefined();
    expect(result.withheld).toContain('consent_status');
  });

  it('reports what was left over so the UI can be honest about it', () => {
    expect(result.fields).toBe(5);
    // Counted over distinct SOURCE fields, not targets: one question may
    // legitimately feed two targets (a full name, a budget range).
    const mappedFields = new Set(result.mappings.map((m) => m.sourceFieldKey));
    expect(mappedFields.size + result.unmapped).toBe(result.fields);
  });

  it('synthesises answers with no values, which is what keeps shapeBonus out', () => {
    const answers = toSyntheticAnswers(FORM);
    expect(answers.every((a) => a.scalarText === '' && a.textValues.length === 0)).toBe(true);
    // Options must survive: they are the whole basis of the enum map.
    expect(answers.find((a) => a.key === 'question_YzPeeJ')?.allOptions).toHaveLength(3);
  });
});

/**
 * Regression: fuzzy label matching scores "first name" at ~0.78 against
 * "last name" — comfortably over the threshold. On a form with no surname
 * question that was enough for one field to claim both targets, so every lead
 * came out named "Priya Priya". Near-opposites need an explicit veto, not a
 * higher score threshold.
 */
describe('name fields are not mistaken for each other', () => {
  const only = (label: string) =>
    prebuildMappings([field({ key: 'q1', label })], 'US').mappings.map((m) => m.targetField).sort();

  it('a lone "First name" claims first_name and nothing else', () => {
    expect(only('First name')).toEqual(['first_name']);
  });

  it('a lone "Last name" or "Surname" claims only last_name', () => {
    expect(only('Last name')).toEqual(['last_name']);
    expect(only('Surname')).toEqual(['last_name']);
  });

  it('still splits a single full-name question into both', () => {
    expect(only('Full name')).toEqual(['first_name', 'last_name']);
    expect(only('Your name')).toEqual(['first_name', 'last_name']);
  });

  it('keeps them 1:1 when the form asks for both separately', () => {
    const both = prebuildMappings(
      [field({ key: 'q_first', label: 'First name' }), field({ key: 'q_last', label: 'Last name' })],
      'US',
    ).mappings;
    expect(both.find((m) => m.targetField === 'first_name')?.sourceFieldKey).toBe('q_first');
    expect(both.find((m) => m.targetField === 'last_name')?.sourceFieldKey).toBe('q_last');
  });
});

describe('schemaFingerprint', () => {
  it('is a fixed-width hash — schema_fingerprint is VARCHAR(64)', () => {
    expect(schemaFingerprint(FORM)).toHaveLength(64);
  });

  it('ignores question order but notices a renamed question', () => {
    const reordered = [...FORM].reverse();
    expect(schemaFingerprint(reordered)).toBe(schemaFingerprint(FORM));

    const renamed = FORM.map((f) => (f.key === 'question_RBGR1J' ? { ...f, label: 'Work email' } : f));
    expect(schemaFingerprint(renamed)).not.toBe(schemaFingerprint(FORM));
  });
});
