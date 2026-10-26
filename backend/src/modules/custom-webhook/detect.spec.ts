import { describe, expect, it } from 'vitest';
import { detectAdapter } from './detect';

const tally = {
  eventId: 'evt_1',
  eventType: 'FORM_RESPONSE',
  data: { formId: 'f1', formName: 'Buyer Inquiry', fields: [{ key: 'question_1', label: 'Your name', type: 'INPUT_TEXT', value: 'Ann' }] },
};

const typeform = {
  event_id: 'ev1',
  event_type: 'form_response',
  form_response: {
    form_id: 'tf1',
    token: 'tok',
    submitted_at: '2026-10-16T10:00:00Z',
    definition: { title: 'Buyers', fields: [{ id: 'q1', ref: 'name', type: 'short_text', title: 'Your name' }] },
    answers: [{ type: 'text', text: 'Ann Lee', field: { id: 'q1', ref: 'name', type: 'short_text' } }],
  },
};

describe('detectAdapter', () => {
  it('recognises a Tally webhook payload', () => {
    expect(detectAdapter(tally)?.provider).toBe('TALLY');
    expect(detectAdapter({ data: { responseId: 'r', fields: [] } })?.provider).toBe('TALLY');
  });

  it('recognises a Typeform webhook payload', () => {
    expect(detectAdapter(typeform)?.provider).toBe('TYPEFORM');
  });

  it('reads anything else as plain JSON', () => {
    expect(detectAdapter({ name: 'Ann', contact: { phone: '+1' } })).toBeNull();
    expect(detectAdapter({ data: { fields: 'not an array' }, eventType: 'x' })).toBeNull();
    // fields without keys: shaped like Tally only at a glance
    expect(detectAdapter({ eventType: 'x', data: { fields: [{ value: 1 }] } })).toBeNull();
    // the markers without the fields array
    expect(detectAdapter({ eventType: 'FORM_RESPONSE', data: {} })).toBeNull();
    // a form_response key with nothing Typeform-like inside
    expect(detectAdapter({ form_response: { note: 'x' } })).toBeNull();
    expect(detectAdapter([tally])).toBeNull();
    expect(detectAdapter(null)).toBeNull();
    expect(detectAdapter('string')).toBeNull();
  });
});
