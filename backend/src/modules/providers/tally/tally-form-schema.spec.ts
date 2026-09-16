import { describe, expect, it } from 'vitest';
import { describeTallyForm, webhookFieldKey, type TallyBlock, type TallyQuestion } from './tally-form-schema';
import { suggestMappings } from '../../processing/heuristics';
import { applyTransform, type Transform } from '../../processing/transforms';
import type { NormalizedAnswer } from '../../ingest/adapters/types';

/**
 * Fixtures captured verbatim from a real Tally account (form `lbxX8o`), not
 * invented. The ids, uuids and the null title are exactly what the API returns
 * — including the consent checkbox, which is the awkward shape that motivated
 * most of the structural logic.
 */
const QUESTIONS: TallyQuestion[] = [
  {
    id: '2xELzL',
    type: 'INPUT_TEXT',
    title: 'First name',
    isDeleted: false,
    fields: [{ uuid: '879fa960-7bc8-408e-baa1-6edce6c83d3a', blockGroupUuid: '879fa960-7bc8-408e-baa1-6edce6c83d3a' }],
  },
  {
    id: 'xNX2Ey',
    type: 'INPUT_TEXT',
    title: 'Last name',
    isDeleted: false,
    fields: [{ uuid: 'd207f4b8-3faa-4b58-816f-d60fb99f4d33', blockGroupUuid: 'd207f4b8-3faa-4b58-816f-d60fb99f4d33' }],
  },
  {
    id: 'RBGR1J',
    type: 'INPUT_EMAIL',
    title: 'Email',
    isDeleted: false,
    fields: [{ uuid: 'cbb3b62f-cca6-469d-9511-add23625bb5f', blockGroupUuid: 'cbb3b62f-cca6-469d-9511-add23625bb5f' }],
  },
  // Null title, one checkbox: the newsletter/consent opt-in.
  {
    id: 'V1LVXv',
    type: 'CHECKBOXES',
    title: null,
    isDeleted: false,
    fields: [{ uuid: 'cfda3201-4c08-45f8-93f2-2bbf7d452158', blockGroupUuid: 'cfda3201-4c08-45f8-93f2-2bbf7d452158' }],
  },
  {
    id: 'd2EggK',
    type: 'INPUT_PHONE_NUMBER',
    title: 'Number we can reach you on',
    isDeleted: false,
    fields: [{ uuid: 'aaaaaaaa-0000-0000-0000-000000000001', blockGroupUuid: 'aaaaaaaa-0000-0000-0000-000000000001' }],
  },
  {
    id: 'YzPeeJ',
    type: 'MULTIPLE_CHOICE',
    title: 'When are you hoping to move?',
    isDeleted: false,
    fields: [{ uuid: 'acd28a62-ce7c-4d2c-aed8-c9f159b2cb4c', blockGroupUuid: 'acd28a62-ce7c-4d2c-aed8-c9f159b2cb4c' }],
  },
  {
    id: 'DvBbbZ',
    type: 'CHECKBOXES',
    title: 'Which areas are you looking at?',
    isDeleted: false,
    fields: [{ uuid: '4bc3d1de-3dc7-443b-84d4-507fffeace16', blockGroupUuid: '4bc3d1de-3dc7-443b-84d4-507fffeace16' }],
  },
];

const opt = (type: string, uuid: string, groupUuid: string, text: string | null, index: number): TallyBlock => ({
  type,
  uuid,
  groupUuid,
  payload: text === null ? { index } : { index, text },
});

const BLOCKS: TallyBlock[] = [
  // Layout blocks share the response and must be ignored.
  { type: 'FORM_TITLE', uuid: 'c745a878', groupUuid: '7850b95f', payload: { text: 'Lead generation form' } },
  { type: 'TEXT', uuid: '3c71b824', groupUuid: 'bd5535d8', payload: { text: 'Your information' } },
  { type: 'PAGE_BREAK', uuid: 'pb-1', groupUuid: 'pb-1' },

  // Consent: a single CHECKBOX whose payload carries no label.
  opt('CHECKBOX', '5492dbea-8e52-4572-8474-383c741df01c', 'cfda3201-4c08-45f8-93f2-2bbf7d452158', null, 0),

  // Timeline — deliberately out of order to prove `index` sorting.
  opt('MULTIPLE_CHOICE_OPTION', '5a527a59-f5a6-4f25-8173-5a7bd10fefd4', 'acd28a62-ce7c-4d2c-aed8-c9f159b2cb4c', '3-6 months', 1),
  opt('MULTIPLE_CHOICE_OPTION', '6dccb338-a809-4bcd-a068-8e0f0dc4cfbe', 'acd28a62-ce7c-4d2c-aed8-c9f159b2cb4c', '6+ months', 2),
  opt('MULTIPLE_CHOICE_OPTION', '8e5da791-70c2-4905-a2ac-5dc69023a38c', 'acd28a62-ce7c-4d2c-aed8-c9f159b2cb4c', '1-3 months', 0),

  // Areas — a genuine multi-select.
  opt('CHECKBOX', '6df9b961-1a2a-4759-9b72-c03eec9c4d0c', '4bc3d1de-3dc7-443b-84d4-507fffeace16', 'North Austin / The Domain', 0),
  opt('CHECKBOX', 'e30f3376-131d-4d27-a17c-cd31cb78d156', '4bc3d1de-3dc7-443b-84d4-507fffeace16', 'Downtown', 1),
  opt('CHECKBOX', 'f3f479c9-687b-4217-9ca7-6607182fedbb', '4bc3d1de-3dc7-443b-84d4-507fffeace16', 'South Congress', 2),
];

describe('describeTallyForm', () => {
  const fields = describeTallyForm(QUESTIONS, BLOCKS);
  const byId = (id: string) => fields.find((f) => f.externalQuestionId === id)!;

  it('derives the webhook field key from the question id', () => {
    expect(byId('YzPeeJ').key).toBe('question_YzPeeJ');
    expect(webhookFieldKey('2xELzL')).toBe('question_2xELzL');
  });

  it('keeps Tally question types verbatim — they already match the webhook vocabulary', () => {
    expect(byId('d2EggK').type).toBe('INPUT_PHONE_NUMBER');
    expect(byId('YzPeeJ').type).toBe('MULTIPLE_CHOICE');
    expect(byId('DvBbbZ').type).toBe('CHECKBOXES');
  });

  it('joins option blocks to their question by groupUuid, in author order', () => {
    expect(byId('YzPeeJ').options?.map((o) => o.text)).toEqual(['1-3 months', '3-6 months', '6+ months']);
    expect(byId('YzPeeJ').options?.[0].id).toBe('8e5da791-70c2-4905-a2ac-5dc69023a38c');
  });

  it('ignores layout blocks and never attaches them to a question', () => {
    expect(fields.every((f) => !(f.options ?? []).some((o) => o.text === 'Your information'))).toBe(true);
  });

  it('treats a lone untitled checkbox as a boolean opt-in, not a choice set', () => {
    const consent = byId('V1LVXv');
    expect(consent.booleanOptIn).toBe(true);
    expect(consent.options ?? []).toEqual([]);
    // Null title must not crash, and must not fabricate a meaning.
    expect(consent.label).toMatch(/untitled/i);
  });

  it('treats a multi-option checkbox question as a real multi-select', () => {
    const areas = byId('DvBbbZ');
    expect(areas.booleanOptIn).toBe(false);
    expect(areas.options).toHaveLength(3);
  });
});

/**
 * The claim the whole pre-mapping feature rests on: a form's SCHEMA alone —
 * no submitted values — is enough for the existing heuristics to produce a
 * usable mapping. If this breaks, connecting a form stops being better than
 * waiting for the first submission.
 */
describe('pre-mapping a form nobody has submitted yet', () => {
  const synthetic: NormalizedAnswer[] = describeTallyForm(QUESTIONS, BLOCKS).map((f) => ({
    key: f.key,
    label: f.label,
    type: f.type,
    raw: null,
    textValues: [],
    scalarText: '', // no values exist — shapeBonus() short-circuits on this
    ...(f.options ? { allOptions: f.options } : {}),
  }));

  const suggestions = suggestMappings(synthetic, 'US');
  const target = (t: string) => suggestions.find((s) => s.targetField === t);

  it('maps email and phone from the field type alone', () => {
    expect(target('email')?.sourceFieldKey).toBe('question_RBGR1J');
    expect(target('phone')?.sourceFieldKey).toBe('question_d2EggK');
    expect(target('email')?.confidence).toBeGreaterThanOrEqual(0.99);
  });

  it('maps first and last name from their labels', () => {
    expect(target('first_name')?.sourceFieldKey).toBe('question_2xELzL');
    expect(target('last_name')?.sourceFieldKey).toBe('question_xNX2Ey');
  });

  it('builds a COMPLETE timeline enum map with no submissions to learn from', () => {
    const timeline = target('timeline');
    expect(timeline?.sourceFieldKey).toBe('question_YzPeeJ');

    const t = timeline!.transform as Extract<Transform, { kind: 'enum_map' }>;
    expect(t.kind).toBe('enum_map');
    expect(t.byOptionText).toEqual({
      '1-3 months': '1_to_3_months',
      '3-6 months': '3_to_6_months',
      '6+ months': 'over_6_months',
    });
  });

  it('actually transforms a later answer through that pre-built map', () => {
    // Proves the map is not merely well-shaped: the value a respondent picks
    // tomorrow resolves to a canonical enum today.
    const t = target('timeline')!.transform as Transform;
    expect(applyTransform(t, ['3-6 months'], '3-6 months', 'US').value).toBe('3_to_6_months');
    expect(applyTransform(t, ['6+ months'], '6+ months', 'US').value).toBe('over_6_months');
  });

  it('never auto-maps consent — an untitled checkbox must not be guessed at', () => {
    expect(suggestions.some((s) => s.sourceFieldKey === 'question_V1LVXv')).toBe(false);
    expect(target('consent_status')).toBeUndefined();
  });
});
