import { describe, expect, it } from 'vitest';
import { suggestMappings } from '@/ingest/processing/heuristics';
import { describeJotformForm } from '@/integration/providers/jotform/jotform-form-schema';
import { JotformAdapter } from './jotform.adapter';
import { InvalidPayloadError } from './types';

const adapter = new JotformAdapter();

const rawRequest = {
  slug: 'submit/231234567890/',
  event_id: '1700000000000_231234567890_abc',
  q3_fullName: { first: 'Asha', last: 'Verma' },
  q4_email: 'asha@example.test',
  q5_phoneNumber: { full: '(555) 201-3344' },
  q6_address: { addr_line1: '12 Elm St', addr_line2: '', city: 'Austin', state: 'TX', postal: '78701', country: '' },
  q7_timeline: '0-3 months',
  q8_interests: ['Pool', 'Garage'],
  q9_moveDate: { month: '01', day: '15', year: '2027' },
  timeToSubmit: '42',
};

/** What IngestController.jotform stores after reading the multipart fields. */
const delivery = (over: Record<string, unknown> = {}) => ({
  submissionID: '5912345678901234567',
  formID: '231234567890',
  formTitle: 'Buyer enquiry',
  rawRequest,
  ...over,
});

describe('a Jotform submission', () => {
  it('uses the submission id as the delivery identity', () => {
    const d = adapter.parse(delivery());
    expect(d.providerEventId).toBe('5912345678901234567');
    expect(d.providerSubmissionId).toBe('5912345678901234567');
    expect(d.providerFormId).toBe('231234567890');
    expect(d.providerFormName).toBe('Buyer enquiry');
  });

  it('flattens composite answers and skips Jotform’s own keys', () => {
    const byKey = Object.fromEntries(adapter.parse(delivery()).answers.map((a) => [a.key, a]));
    expect(Object.keys(byKey)).toEqual([
      'q3_fullName.first',
      'q3_fullName.last',
      'q4_email',
      'q5_phoneNumber',
      'q6_address',
      'q7_timeline',
      'q8_interests',
      'q9_moveDate',
    ]);
    expect(byKey['q3_fullName.first'].scalarText).toBe('Asha');
    expect(byKey['q3_fullName.last'].scalarText).toBe('Verma');
    expect(byKey.q4_email.scalarText).toBe('asha@example.test');
    expect(byKey.q5_phoneNumber).toMatchObject({ type: 'control_phone', scalarText: '(555) 201-3344' });
    expect(byKey.q6_address.scalarText).toBe('12 Elm St, Austin, TX, 78701');
    expect(byKey.q8_interests.textValues).toEqual(['Pool', 'Garage']);
    expect(byKey.q9_moveDate.scalarText).toBe('01/15/2027');
    expect(byKey.q5_phoneNumber.label).toBe('Phone number');
    expect(byKey.q5_phoneNumber.labelInferred).toBe(true);
  });

  it('reads a rawRequest that arrived as a JSON string', () => {
    const d = adapter.parse(delivery({ rawRequest: JSON.stringify(rawRequest) }));
    expect(d.answers.find((a) => a.key === 'q4_email')?.scalarText).toBe('asha@example.test');
  });

  it('builds a phone from area and number when there is no full value', () => {
    const d = adapter.parse(delivery({ rawRequest: { q5_phone: { area: '555', phone: '2013344' } } }));
    expect(d.answers[0].scalarText).toBe('555 2013344');
  });

  it('puts the country code in front when Jotform sends it as its own part', () => {
    const d = adapter.parse(delivery({ rawRequest: { q5_phone: { country: '91', area: '798', phone: '3789791' } } }));
    expect(d.answers[0].scalarText).toBe('+91 798 3789791');
    const full = adapter.parse(delivery({ rawRequest: { q5_phone: { country: '+1', full: '(415) 555-0100' } } }));
    expect(full.answers[0].scalarText).toBe('+1 (415) 555-0100');
  });

  it('rejects a body that is not a Jotform submission', () => {
    expect(() => adapter.parse({ hello: 'world' })).toThrow(InvalidPayloadError);
    expect(() => adapter.parse(delivery({ rawRequest: '{not json' }))).toThrow(InvalidPayloadError);
  });

  it('maps name, email and phone on a first delivery with no form description', () => {
    const targets = Object.fromEntries(suggestMappings(adapter.parse(delivery()).answers).map((s) => [s.targetField, s.sourceFieldKey]));
    expect(targets).toMatchObject({
      first_name: 'q3_fullName.first',
      last_name: 'q3_fullName.last',
      email: 'q4_email',
      phone: 'q5_phoneNumber',
    });
  });
});

describe('a Jotform form described before any submission', () => {
  const questions = {
    '1': { qid: '1', name: 'heading', text: 'Find your home', type: 'control_head', order: '1' },
    '3': { qid: '3', name: 'fullName', text: 'Full Name', type: 'control_fullname', order: '2' },
    '4': { qid: '4', name: 'email', text: 'Email', type: 'control_email', order: '3' },
    '5': { qid: '5', name: 'phoneNumber', text: 'Best number to reach you', type: 'control_phone', order: '4' },
    '7': { qid: '7', name: 'timeline', text: 'When are you looking to buy?', type: 'control_dropdown', order: '5', options: '0-3 months|3-6 months|6+ months' },
    '10': { qid: '10', name: 'consent', text: 'Contact me', type: 'control_checkbox', order: '6', options: 'I agree to be contacted' },
    '2': { qid: '2', name: 'submit', text: 'Submit', type: 'control_button', order: '7' },
  };

  it('uses the same keys the webhook delivers', () => {
    const described = describeJotformForm(questions).map((f) => f.key);
    const delivered = new Set(adapter.parse(delivery()).answers.map((a) => a.key));
    expect(described).toEqual(['q3_fullName.first', 'q3_fullName.last', 'q4_email', 'q5_phoneNumber', 'q7_timeline', 'q10_consent']);
    for (const key of described.filter((k) => k !== 'q10_consent')) expect(delivered.has(key)).toBe(true);
  });

  it('keeps question text, options and opt-in checkboxes', () => {
    const byKey = Object.fromEntries(describeJotformForm(questions).map((f) => [f.key, f]));
    expect(byKey['q3_fullName.first'].label).toBe('First name');
    expect(byKey.q7_timeline.options?.map((o) => o.text)).toEqual(['0-3 months', '3-6 months', '6+ months']);
    expect(byKey.q10_consent.booleanOptIn).toBe(true);
  });

  it('prebuilds email and phone from the control types', () => {
    const fields = describeJotformForm(questions).map((f) => ({ ...f, raw: null, textValues: [], scalarText: '' }));
    const targets = Object.fromEntries(suggestMappings(fields).map((s) => [s.targetField, s.sourceFieldKey]));
    expect(targets).toMatchObject({ email: 'q4_email', phone: 'q5_phoneNumber', first_name: 'q3_fullName.first', last_name: 'q3_fullName.last' });
  });
});
