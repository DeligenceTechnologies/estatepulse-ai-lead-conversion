import { describe, expect, it } from 'vitest';
import { GoogleFormsAdapter } from './google-forms.adapter';
import { InvalidPayloadError } from './types';

const adapter = new GoogleFormsAdapter();

const payload = (over: Record<string, unknown> = {}) => ({
  source: 'google_forms',
  version: 1,
  sourceId: '0c6f0a9e-2a1b-4e4b-9c2f-0a1b2c3d4e5f',
  formId: '1FAIpQLSdExampleFormId',
  formTitle: 'Buyer enquiry',
  responseId: 'ACYDBNj_response_1',
  submittedAt: '2026-11-12T10:00:00.000Z',
  questions: [
    { key: 'q_full_name', itemId: '101', title: 'Full name', type: 'TEXT', values: ['Manish Baghel'] },
    { key: 'q_email', itemId: '102', title: 'Email', type: 'TEXT', values: ['manish@example.test'] },
    { key: 'q_phone', itemId: '103', title: 'Phone', type: 'TEXT', values: ['+91 90248 48980'] },
  ],
  ...over,
});

describe('a Google Forms response the Apps Script delivered', () => {
  it('is read into answers, with the response id as the delivery identity', () => {
    const d = adapter.parse(payload());

    // The response id is what the dedupe key is built from; without it the
    // same response could become two leads.
    expect(d.providerEventId).toBe('ACYDBNj_response_1');
    expect(d.providerSubmissionId).toBe('ACYDBNj_response_1');
    expect(d.providerFormId).toBe('1FAIpQLSdExampleFormId');
    expect(d.submittedAt?.toISOString()).toBe('2026-11-12T10:00:00.000Z');
    expect(d.answers.map((a) => [a.key, a.scalarText])).toEqual([
      ['q_full_name', 'Manish Baghel'],
      ['q_email', 'manish@example.test'],
      ['q_phone', '+91 90248 48980'],
    ]);
  });

  it('lists every question as a field, so the catalog is complete', () => {
    expect(adapter.parse(payload()).fields.map((f) => f.key)).toEqual(['q_full_name', 'q_email', 'q_phone']);
  });
});

describe('answers that are not a single line of text', () => {
  it('keeps every choice of a checkbox question', () => {
    const d = adapter.parse(
      payload({
        questions: [{ key: 'q_areas', title: 'Areas', type: 'CHECKBOXES', values: ['Bandra', 'Andheri', 'Juhu'] }],
      }),
    );
    expect(d.answers[0].textValues).toEqual(['Bandra', 'Andheri', 'Juhu']);
    expect(d.answers[0].scalarText).toBe('Bandra, Andheri, Juhu');
  });

  it('carries an unanswered question with no value, so nothing is written for it', () => {
    const d = adapter.parse(payload({ questions: [{ key: 'q_budget', title: 'Budget', type: 'TEXT', values: [] }] }));
    expect(d.answers[0].textValues).toEqual([]);
    expect(d.answers[0].scalarText).toBe('');
    // Still a field: an owner can map a question nobody has answered yet.
    expect(d.fields).toHaveLength(1);
  });

  it('never follows a file upload — it counts the files and keeps the ids out of the lead', () => {
    const d = adapter.parse(
      payload({
        questions: [{ key: 'q_docs', title: 'Documents', type: 'FILE_UPLOAD', values: ['1AbCdEfGh', '2IjKlMnOp'] }],
      }),
    );
    expect(d.answers[0].scalarText).toBe('2 files uploaded');
    expect(d.answers[0].textValues).toEqual(['2 files uploaded']);
    // The ids are still on the delivery for anyone who needs them.
    expect(d.answers[0].raw).toEqual(['1AbCdEfGh', '2IjKlMnOp']);
    expect(d.warnings.map((w) => w.code)).toContain('file_upload_answer');
  });

  it('says "1 file" rather than "1 files"', () => {
    const d = adapter.parse(payload({ questions: [{ key: 'q_docs', title: 'Docs', type: 'FILE_UPLOAD', values: ['x'] }] }));
    expect(d.answers[0].scalarText).toBe('1 file uploaded');
  });
});

describe('a form with two questions that have the same title', () => {
  it('keeps them apart, because one mapping must not cover both', () => {
    const d = adapter.parse(
      payload({
        questions: [
          { key: 'q_name', title: 'Name', type: 'TEXT', values: ['Buyer One'] },
          { key: 'q_name__2', title: 'Name', type: 'TEXT', values: ['Buyer Two'] },
        ],
      }),
    );
    expect(d.answers.map((a) => a.key)).toEqual(['q_name', 'q_name__2']);
    expect(d.answers.map((a) => a.scalarText)).toEqual(['Buyer One', 'Buyer Two']);
  });

  it('derives the same distinct keys when only titles were sent', () => {
    const d = adapter.parse({
      source: 'google_forms',
      responseId: 'r1',
      fields: { Name: 'Buyer One' },
    });
    expect(d.answers[0].key).toBe('q_name');
  });
});

describe('a payload we cannot trust', () => {
  it('is refused when it carries no response id — there would be no idempotency key', () => {
    expect(() => adapter.parse(payload({ responseId: null }))).toThrow(InvalidPayloadError);
  });

  it('is refused when it carries no questions at all', () => {
    expect(() => adapter.parse(payload({ questions: [], fields: null }))).toThrow(InvalidPayloadError);
  });

  it('is refused when it is not an object of the right shape', () => {
    expect(() => adapter.parse('not json')).toThrow(InvalidPayloadError);
    expect(() => adapter.parse({ questions: 'nope', responseId: 'r' })).toThrow(InvalidPayloadError);
  });

  it('accepts the flat {fields} contract as documented', () => {
    const d = adapter.parse({
      source: 'google_forms',
      formId: 'f1',
      responseId: 'r1',
      submittedAt: '2026-11-12T10:00:00.000Z',
      fields: { 'Full Name': 'John Smith', Email: 'john@example.test', Budget: '500000' },
    });
    expect(d.answers.map((a) => [a.label, a.scalarText])).toEqual([
      ['Full Name', 'John Smith'],
      ['Email', 'john@example.test'],
      ['Budget', '500000'],
    ]);
  });
});
