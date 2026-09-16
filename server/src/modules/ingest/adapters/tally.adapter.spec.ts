import { describe, expect, it } from 'vitest';
import { TallyAdapter } from './tally.adapter';
import { InvalidPayloadError } from './types';

const adapter = new TallyAdapter();

/**
 * A realistic payload exercising the field types a real estate intake form
 * actually uses, including the awkward ones: a choice field whose value is
 * option UUIDs, an unanswered optional, and a hidden UTM field.
 */
const payload = {
  eventId: 'evt_01HX',
  eventType: 'FORM_RESPONSE',
  createdAt: '2026-09-15T10:00:00.000Z',
  data: {
    responseId: 'resp_abc',
    submissionId: 'sub_abc',
    respondentId: 'rsp_1',
    formId: 'form_1',
    formName: 'Buyer Inquiry',
    createdAt: '2026-09-15T09:59:58.000Z',
    fields: [
      { key: 'question_1', label: 'Your name', type: 'INPUT_TEXT', value: 'Brandon Hayes' },
      { key: 'question_2', label: 'Email address', type: 'INPUT_EMAIL', value: 'b.hayes@example.com' },
      { key: 'question_3', label: 'Best number', type: 'INPUT_PHONE_NUMBER', value: '+15125550291' },
      {
        key: 'question_4',
        label: 'When are you looking to move?',
        type: 'MULTIPLE_CHOICE',
        value: ['opt_a'],
        options: [
          { id: 'opt_a', text: 'ASAP / under 30 days' },
          { id: 'opt_b', text: '1-3 months' },
        ],
      },
      {
        key: 'question_5',
        label: 'Must-haves',
        type: 'CHECKBOXES',
        value: ['opt_x', 'opt_y'],
        options: [
          { id: 'opt_x', text: 'Garage' },
          { id: 'opt_y', text: 'Good schools' },
          { id: 'opt_z', text: 'Pool' },
        ],
      },
      { key: 'question_6', label: 'Anything else?', type: 'TEXTAREA', value: null },
      { key: 'question_7', label: 'utm_source', type: 'HIDDEN_FIELDS', value: 'google' },
    ],
  },
};

describe('TallyAdapter', () => {
  it('extracts delivery-level identifiers used for idempotency', () => {
    const d = adapter.parse(payload);
    expect(d.providerEventId).toBe('evt_01HX');
    expect(d.providerSubmissionId).toBe('resp_abc');
    expect(d.providerFormId).toBe('form_1');
    expect(d.providerFormName).toBe('Buyer Inquiry');
    expect(d.submittedAt?.toISOString()).toBe('2026-09-15T09:59:58.000Z');
  });

  it('resolves choice-field option IDs to their display text', () => {
    const d = adapter.parse(payload);
    const timeline = d.answers.find((a) => a.key === 'question_4')!;

    // The bug this guards: storing "opt_a" instead of the answer the human gave.
    expect(timeline.textValues).toEqual(['ASAP / under 30 days']);
    expect(timeline.scalarText).toBe('ASAP / under 30 days');
    // Option ids are retained so a renamed option can be auto-healed later.
    expect(timeline.optionIds).toEqual(['opt_a']);
  });

  it('resolves multi-select checkboxes to every selected option text', () => {
    const d = adapter.parse(payload);
    const musts = d.answers.find((a) => a.key === 'question_5')!;
    expect(musts.textValues).toEqual(['Garage', 'Good schools']);
    expect(musts.scalarText).toBe('Garage, Good schools');
  });

  it('treats an unanswered optional question as empty, not as a parse failure', () => {
    const d = adapter.parse(payload);
    const optional = d.answers.find((a) => a.key === 'question_6')!;
    expect(optional.textValues).toEqual([]);
    expect(optional.scalarText).toBe('');
  });

  it('captures the observed form schema including option sets', () => {
    const d = adapter.parse(payload);
    expect(d.fields).toHaveLength(7);

    const timelineField = d.fields.find((f) => f.key === 'question_4')!;
    // Options must be persisted: the mapping UI keys value_map on option TEXT,
    // so it needs the text to render choices.
    expect(timelineField.options).toEqual([
      { id: 'opt_a', text: 'ASAP / under 30 days' },
      { id: 'opt_b', text: '1-3 months' },
    ]);
  });

  it('warns but does not throw when an option id has no matching option', () => {
    const stale = structuredClone(payload);
    stale.data.fields[3].value = ['opt_deleted'];

    const d = adapter.parse(stale);
    expect(d.warnings).toContainEqual(
      expect.objectContaining({ code: 'UNRESOLVED_OPTION', fieldKey: 'question_4' }),
    );
    // The raw id is kept so the answer is still recoverable — one stale option
    // reference must never cost us the whole lead.
    expect(d.answers.find((a) => a.key === 'question_4')!.textValues).toEqual(['opt_deleted']);
  });

  it('accepts field types it has never seen rather than rejecting the submission', () => {
    const exotic = structuredClone(payload);
    (exotic.data.fields as unknown[]).push({
      key: 'question_99',
      label: 'Rate us',
      type: 'SOME_FUTURE_TALLY_TYPE',
      value: 5,
    });

    const d = adapter.parse(exotic);
    expect(d.answers.find((a) => a.key === 'question_99')!.scalarText).toBe('5');
  });

  it('rejects a body that is not a Tally payload at all', () => {
    expect(() => adapter.parse({ hello: 'world' })).toThrow(InvalidPayloadError);
  });
});
