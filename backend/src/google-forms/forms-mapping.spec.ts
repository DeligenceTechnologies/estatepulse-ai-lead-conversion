import { describe, expect, it } from 'vitest';
import { GoogleFormsAdapter } from '@/ingest/adapters/google-forms.adapter';
import { applyTransform, type Transform } from '@/ingest/processing/transforms';
import { defaultTransform } from '@/ingest/processing/heuristics';
import { validateCanonicalValues } from '@/ingest/processing/validators';
import type { CanonicalKey } from '@/ingest/processing/canonical-fields';
import { prebuildMappings } from '@/lead-source/prebuild-mapping';
import { describeGoogleForm, type GoogleForm } from './forms-schema';
import { responsePayload } from './forms-responses';

/**
 * A Google Form's questions, through the mapping, to the values a lead is
 * built from. The worker does the same three steps on a real delivery
 * (worker.service.ts: syncFieldCatalog -> mappings -> applyMappings), so this
 * is that path with the database left out.
 */

const text = (title: string, id = `qid_${title}`) => ({ title, questionItem: { question: { questionId: id, textQuestion: {} } } });

const form: GoogleForm = {
  formId: 'form-1',
  info: { title: 'Buyer enquiry' },
  items: [
    text('Full name'),
    text('Email address'),
    text('Phone number'),
    {
      title: 'When are you looking to move?',
      questionItem: {
        question: {
          questionId: 'qid_timeline',
          choiceQuestion: {
            type: 'RADIO',
            options: [{ value: 'ASAP' }, { value: '1-3 months' }, { value: '3-6 months' }, { value: 'Just browsing' }],
          },
        },
      },
    },
    {
      title: 'Areas you like',
      questionItem: {
        question: {
          questionId: 'qid_areas',
          choiceQuestion: { type: 'CHECKBOX', options: [{ value: 'Bandra' }, { value: 'Juhu' }] },
        },
      },
    },
    text('Anything else we should know?', 'qid_notes'),
  ],
};

const fields = describeGoogleForm(form);

/** The worker's applyMappings, over one delivery. */
function leadValues(answersByKey: Record<string, string[]>, mapping: Record<string, CanonicalKey | 'full_name'>) {
  const delivery = new GoogleFormsAdapter().parse(
    responsePayload(
      { sourceId: 's', formId: 'form-1', formTitle: 'Buyer enquiry', fields },
      {
        responseId: 'r1',
        createTime: '2026-11-12T10:00:00.000Z',
        answers: Object.fromEntries(
          fields
            .filter((f) => answersByKey[f.key])
            .map((f) => [f.externalQuestionId, { textAnswers: { answers: answersByKey[f.key].map((value) => ({ value })) } }]),
        ),
      },
    ),
  );

  const values: Record<string, unknown> = {};
  const custom: Record<string, string> = {};

  for (const answer of delivery.answers) {
    const target = mapping[answer.key];
    if (!target) {
      // Exactly the worker's rule: an unmapped answer is kept as an extra
      // field and never guessed into a lead column.
      if (answer.scalarText) custom[answer.label] = answer.scalarText;
      continue;
    }
    const synthetic = { ...answer, allOptions: fields.find((f) => f.key === answer.key)?.options };
    const transforms: [string, Transform][] =
      target === 'full_name'
        ? [
            ['first_name', { kind: 'name_split', part: 'first' }],
            ['last_name', { kind: 'name_split', part: 'last' }],
          ]
        : [[target, defaultTransform(target, synthetic)]];
    for (const [column, transform] of transforms) {
      const { value } = applyTransform(transform, answer.textValues, answer.scalarText);
      if (value !== null && value !== '') values[column] = value;
    }
  }
  return { values: validateCanonicalValues(values as Record<string, string | number | boolean | null>).values, custom };
}

describe('what EstatePulse suggests before an owner has touched the mapping', () => {
  it('reads a form’s questions and pre-maps the obvious ones', () => {
    const result = prebuildMappings(fields);
    const byTarget = Object.fromEntries(result.mappings.map((m) => [m.targetField, m.sourceFieldKey]));

    expect(byTarget.email).toBe('q_email_address');
    expect(byTarget.phone).toBe('q_phone_number');
    expect(byTarget.first_name).toBe('q_full_name');
    expect(byTarget.timeline).toBe('q_when_are_you_looking_to_move');
    expect(result.fields).toBe(fields.length);
  });

  it('is available with no submissions at all — the questions come from the form', () => {
    expect(fields).toHaveLength(6);
    expect(prebuildMappings(fields).mappings.length).toBeGreaterThan(0);
  });
});

describe('an owner’s mapping, applied to a response', () => {
  const mapping = {
    q_full_name: 'full_name',
    q_email_address: 'email',
    q_phone_number: 'phone',
    q_when_are_you_looking_to_move: 'timeline',
  } as const;

  it('splits a full name, normalizes the email and dials the phone', () => {
    const { values } = leadValues(
      {
        q_full_name: ['Manish Baghel'],
        q_email_address: ['Manish@Example.Test'],
        q_phone_number: ['+91 90248 48980'],
      },
      mapping,
    );
    expect(values.first_name).toBe('Manish');
    expect(values.last_name).toBe('Baghel');
    expect(values.email).toBe('manish@example.test');
    expect(values.phone).toBe('+919024848980');
  });

  it('turns the form’s own wording for a dropdown into our enum', () => {
    expect(leadValues({ q_when_are_you_looking_to_move: ['1-3 months'] }, mapping).values.timeline).toBe('1_to_3_months');
    expect(leadValues({ q_when_are_you_looking_to_move: ['Just browsing'] }, mapping).values.timeline).toBe('over_6_months');
  });

  it('keeps every question the owner did not map as an extra field on the lead', () => {
    const { values, custom } = leadValues(
      { q_full_name: ['Manish Baghel'], q_areas_you_like: ['Bandra', 'Juhu'], q_anything_else_we_should_know: ['Needs parking'] },
      mapping,
    );
    expect(custom['Areas you like']).toBe('Bandra, Juhu');
    expect(custom['Anything else we should know?']).toBe('Needs parking');
    // And nothing of theirs leaked into a lead column.
    expect(values.location).toBeUndefined();
    expect(values.motivation).toBeUndefined();
  });

  it('writes nothing at all for a question nobody answered', () => {
    const { values, custom } = leadValues({ q_full_name: ['Manish Baghel'] }, mapping);
    expect(values.email).toBeUndefined();
    expect(values.phone).toBeUndefined();
    expect(Object.keys(custom)).toEqual([]);
  });

  it('maps a multi-select question when the owner points it at a lead field', () => {
    const { values } = leadValues({ q_areas_you_like: ['Bandra', 'Juhu'] }, { q_areas_you_like: 'location' } as never);
    expect(values.location).toBe('Bandra, Juhu');
  });

  it('refuses a phone with no country code rather than guessing one', () => {
    const { values } = leadValues({ q_phone_number: ['9024848980'] }, mapping);
    // Kept as given, but not dialable — the lead is flagged for review by the
    // worker rather than being called on a number for the wrong country.
    expect(values.phone).toBe('9024848980');
  });
});
