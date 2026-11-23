import { describe, expect, it } from 'vitest';
import { schemaFingerprint } from '@/lead-source/prebuild-mapping';
import { describeGoogleForm, fieldKey, formTitle, questionItems, type GoogleForm } from './forms-schema';

const text = (title: string) => ({ title, questionItem: { question: { questionId: `qid_${title}`, textQuestion: {} } } });
const choice = (title: string, type: string, options: string[]) => ({
  title,
  questionItem: {
    question: {
      questionId: `qid_${title}`,
      choiceQuestion: { type, options: options.map((value) => ({ value })) },
    },
  },
});

const form = (items: unknown[]): GoogleForm => ({
  formId: 'form-1',
  info: { title: 'Buyer enquiry' },
  items: items as GoogleForm['items'],
});

describe('reading a Google Form’s questions', () => {
  it('describes each question with a key, a label and its options', () => {
    const fields = describeGoogleForm(
      form([text('Full name'), text('Email'), choice('Timeline', 'RADIO', ['Under 30 days', '3-6 months'])]),
    );

    expect(fields.map((f) => f.key)).toEqual(['q_full_name', 'q_email', 'q_timeline']);
    expect(fields.map((f) => f.label)).toEqual(['Full name', 'Email', 'Timeline']);
    expect(fields[2].options?.map((o) => o.text)).toEqual(['Under 30 days', '3-6 months']);
    // Google's own id is kept, so a question stays identifiable after a rename.
    expect(fields[0].externalQuestionId).toBe('qid_Full name');
  });

  it('ignores page breaks, images and text blocks — they hold no answer', () => {
    const f = form([{ title: 'Welcome', textItem: {} }, text('Email'), { pageBreakItem: {} }, { imageItem: {} }]);
    expect(questionItems(f)).toHaveLength(1);
    expect(describeGoogleForm(f).map((x) => x.key)).toEqual(['q_email']);
  });

  it('uses the vocabulary the mapping heuristics already read', () => {
    const fields = describeGoogleForm(
      form([
        choice('Pick one', 'RADIO', ['a']),
        choice('Tick any', 'CHECKBOX', ['a', 'b']),
        choice('From a list', 'DROP_DOWN', ['a']),
        { title: 'Upload', questionItem: { question: { questionId: 'q1', fileUploadQuestion: {} } } },
        { title: 'Notes', questionItem: { question: { questionId: 'q2', textQuestion: { paragraph: true } } } },
      ]),
    );
    expect(fields.map((f) => f.type)).toEqual(['MULTIPLE_CHOICE', 'CHECKBOXES', 'DROPDOWN', 'FILE_UPLOAD', 'PARAGRAPH_TEXT']);
  });

  it('treats a lone checkbox as a consent tick, which is never pre-mapped', () => {
    const [optIn, many] = describeGoogleForm(
      form([choice('I agree to be contacted', 'CHECKBOX', ['Yes']), choice('Areas', 'CHECKBOX', ['Bandra', 'Juhu'])]),
    );
    expect(optIn.booleanOptIn).toBe(true);
    expect(many.booleanOptIn).toBe(false);
  });

  it('drops the "Other…" option, which carries no value of its own', () => {
    const [field] = describeGoogleForm(
      form([
        {
          title: 'Areas',
          questionItem: {
            question: {
              questionId: 'q1',
              choiceQuestion: { type: 'RADIO', options: [{ value: 'Bandra' }, { value: '', isOther: true }] },
            },
          },
        },
      ]),
    );
    expect(field.options?.map((o) => o.text)).toEqual(['Bandra']);
  });

  it('falls back to a readable title when a form has none', () => {
    expect(formTitle({ info: {} })).toBe('Untitled form');
    expect(formTitle(form([]))).toBe('Buyer enquiry');
  });
});

describe('two questions with the same title', () => {
  it('get different keys, so one mapping cannot cover both', () => {
    const fields = describeGoogleForm(form([text('Name'), text('Name'), text('Name')]));
    expect(fields.map((f) => f.key)).toEqual(['q_name', 'q_name__2', 'q_name__3']);
  });

  it('numbers by position, which is what the Apps Script sees too', () => {
    expect(fieldKey('Full name', 1)).toBe('q_full_name');
    expect(fieldKey('Full name', 2)).toBe('q_full_name__2');
  });

  it('survives a title made only of punctuation or emoji', () => {
    expect(fieldKey('🏠', 1)).toBe('q_untitled');
    expect(fieldKey('', 1)).toBe('q_untitled');
    expect(fieldKey('What’s your budget?', 1)).toBe('q_what_s_your_budget');
  });
});

describe('noticing that the form changed', () => {
  const base = form([text('Full name'), text('Email')]);

  it('fingerprints the same form the same way, whatever order Google returns it in', () => {
    const a = schemaFingerprint(describeGoogleForm(base));
    const b = schemaFingerprint(describeGoogleForm(form([text('Email'), text('Full name')])));
    expect(a).toBe(b);
  });

  it('changes when a question is added, removed or renamed', () => {
    const before = schemaFingerprint(describeGoogleForm(base));
    expect(schemaFingerprint(describeGoogleForm(form([text('Full name'), text('Email'), text('Phone')])))).not.toBe(before);
    expect(schemaFingerprint(describeGoogleForm(form([text('Full name')])))).not.toBe(before);
    expect(schemaFingerprint(describeGoogleForm(form([text('Your name'), text('Email')])))).not.toBe(before);
  });

  it('changes when a question keeps its title but changes type', () => {
    const before = schemaFingerprint(describeGoogleForm(form([choice('Timeline', 'RADIO', ['a'])])));
    expect(schemaFingerprint(describeGoogleForm(form([text('Timeline')])))).not.toBe(before);
  });
});
