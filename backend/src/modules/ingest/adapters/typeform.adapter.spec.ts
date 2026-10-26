import { describe, expect, it } from 'vitest';
import { TypeformAdapter } from './typeform.adapter';
import { InvalidPayloadError } from './types';

const adapter = new TypeformAdapter();

/**
 * A realistic `form_response` payload exercising the answer types a real
 * estate intake form actually uses: a single choice, a multi choice, a legal
 * opt-in, a question inside a group, an unanswered optional, and a hidden UTM.
 */
const payload = {
  event_id: '01HXEVENT',
  event_type: 'form_response',
  form_response: {
    form_id: 'abc123',
    token: 'resp_tok_1',
    landed_at: '2026-09-15T09:59:00Z',
    submitted_at: '2026-09-15T10:00:00Z',
    definition: {
      id: 'abc123',
      title: 'Buyer Inquiry',
      fields: [
        { id: 'f_name', ref: 'name', type: 'short_text', title: 'Your name' },
        { id: 'f_email', ref: 'email', type: 'email', title: 'Email address' },
        { id: 'f_phone', ref: 'phone', type: 'phone_number', title: 'Best number' },
        {
          id: 'f_when',
          ref: 'when',
          type: 'multiple_choice',
          title: 'When are you looking to move?',
          choices: [
            { id: 'c_asap', ref: 'asap', label: 'ASAP / under 30 days' },
            { id: 'c_1_3', ref: '1-3', label: '1-3 months' },
          ],
        },
        {
          id: 'f_must',
          ref: 'must',
          type: 'multiple_choice',
          title: 'Must-haves',
          choices: [
            { id: 'c_garage', ref: 'garage', label: 'Garage' },
            { id: 'c_schools', ref: 'schools', label: 'Good schools' },
            { id: 'c_pool', ref: 'pool', label: 'Pool' },
          ],
        },
        { id: 'f_legal', ref: 'legal', type: 'legal', title: 'May we contact you?' },
        { id: 'f_notes', ref: 'notes', type: 'long_text', title: 'Anything else?' },
      ],
    },
    answers: [
      { type: 'text', text: 'Brandon Hayes', field: { id: 'f_name', ref: 'name', type: 'short_text' } },
      { type: 'email', email: 'b.hayes@example.com', field: { id: 'f_email', ref: 'email', type: 'email' } },
      { type: 'phone_number', phone_number: '+15125550291', field: { id: 'f_phone', ref: 'phone', type: 'phone_number' } },
      {
        type: 'choice',
        choice: { id: 'c_asap', ref: 'asap', label: 'ASAP / under 30 days' },
        field: { id: 'f_when', ref: 'when', type: 'multiple_choice' },
      },
      {
        type: 'choices',
        choices: { ids: ['c_garage', 'c_schools'], refs: ['garage', 'schools'], labels: ['Garage', 'Good schools'] },
        field: { id: 'f_must', ref: 'must', type: 'multiple_choice' },
      },
      { type: 'boolean', boolean: true, field: { id: 'f_legal', ref: 'legal', type: 'legal' } },
    ],
    hidden: { utm_source: 'google' },
  },
};

describe('TypeformAdapter', () => {
  it('extracts delivery-level identifiers used for idempotency', () => {
    const d = adapter.parse(payload);
    expect(d.providerEventId).toBe('01HXEVENT');
    expect(d.providerSubmissionId).toBe('resp_tok_1');
    expect(d.providerFormId).toBe('abc123');
    expect(d.providerFormName).toBe('Buyer Inquiry');
    expect(d.eventType).toBe('form_response');
    expect(d.submittedAt?.toISOString()).toBe('2026-09-15T10:00:00.000Z');
  });

  it('keys answers by field id and labels them from the definition', () => {
    const d = adapter.parse(payload);
    const email = d.answers.find((a) => a.key === 'f_email')!;
    expect(email).toMatchObject({ label: 'Email address', type: 'email', scalarText: 'b.hayes@example.com' });
    const phone = d.answers.find((a) => a.key === 'f_phone')!;
    expect(phone).toMatchObject({ type: 'phone_number', scalarText: '+15125550291' });
  });

  it('takes a choice answer by its label and keeps every option the question offers', () => {
    const d = adapter.parse(payload);
    const when = d.answers.find((a) => a.key === 'f_when')!;
    expect(when.textValues).toEqual(['ASAP / under 30 days']);
    expect(when.optionIds).toEqual(['c_asap']);
    expect(when.allOptions).toEqual([
      { id: 'c_asap', text: 'ASAP / under 30 days' },
      { id: 'c_1_3', text: '1-3 months' },
    ]);
  });

  it('resolves a multi choice to every selected label', () => {
    const d = adapter.parse(payload);
    const must = d.answers.find((a) => a.key === 'f_must')!;
    expect(must.textValues).toEqual(['Garage', 'Good schools']);
    expect(must.scalarText).toBe('Garage, Good schools');
    expect(must.allOptions).toHaveLength(3);
  });

  it('renders a boolean as "true"/"false" text', () => {
    const d = adapter.parse(payload);
    expect(d.answers.find((a) => a.key === 'f_legal')!.scalarText).toBe('true');
  });

  it('catalogues every defined question, answered or not, with option sets', () => {
    const d = adapter.parse(payload);
    const keys = d.fields.map((f) => f.key);
    expect(keys).toContain('f_notes'); // unanswered
    expect(d.fields.find((f) => f.key === 'f_when')!.options).toHaveLength(2);
    expect(d.answers.find((a) => a.key === 'f_notes')).toBeUndefined();
  });

  it('carries hidden fields along as plain text answers', () => {
    const d = adapter.parse(payload);
    expect(d.answers.find((a) => a.key === 'hidden_utm_source')).toMatchObject({
      label: 'utm_source',
      type: 'hidden',
      scalarText: 'google',
    });
  });

  it('flattens questions nested inside a group', () => {
    const d = adapter.parse({
      event_id: 'e',
      event_type: 'form_response',
      form_response: {
        form_id: 'f',
        token: 't',
        definition: {
          title: 'Grouped',
          fields: [
            {
              id: 'g1',
              type: 'group',
              title: 'Contact',
              properties: { fields: [{ id: 'inner', type: 'email', title: 'Email' }] },
            },
          ],
        },
        answers: [{ type: 'email', email: 'x@y.z', field: { id: 'inner', type: 'email' } }],
      },
    });
    expect(d.fields.map((f) => f.key)).toEqual(['inner']);
    expect(d.answers[0]).toMatchObject({ key: 'inner', label: 'Email', type: 'email' });
  });

  it('accepts answer types it has never seen rather than rejecting the submission', () => {
    const d = adapter.parse({
      event_id: 'e',
      event_type: 'form_response',
      form_response: {
        form_id: 'f',
        token: 't',
        definition: { title: 'X', fields: [{ id: 'q', type: 'hologram', title: 'Wave' }] },
        answers: [{ type: 'hologram', hologram: { frames: 3 }, field: { id: 'q', type: 'hologram' } }],
      },
    });
    expect(d.answers[0]).toMatchObject({ type: 'hologram', scalarText: '{"frames":3}' });
  });

  it('rejects a body that is not a Typeform payload at all', () => {
    expect(() => adapter.parse({ eventId: 'x', data: { fields: [] } })).toThrow(InvalidPayloadError);
    expect(() => adapter.parse('nope')).toThrow(InvalidPayloadError);
  });
});
