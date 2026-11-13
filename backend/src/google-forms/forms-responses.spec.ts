import { describe, expect, it } from 'vitest';
import { GoogleFormsAdapter } from '@/ingest/adapters/google-forms.adapter';
import { describeGoogleForm, type GoogleForm } from './forms-schema';
import { responsePayload, wasEdited, type GoogleFormResponse } from './forms-responses';

const form: GoogleForm = {
  formId: 'form-1',
  info: { title: 'Buyer enquiry' },
  items: [
    { title: 'Full name', questionItem: { question: { questionId: 'q_name', textQuestion: {} } } },
    { title: 'Email', questionItem: { question: { questionId: 'q_mail', textQuestion: {} } } },
    {
      title: 'Areas',
      questionItem: {
        question: { questionId: 'q_areas', choiceQuestion: { type: 'CHECKBOX', options: [{ value: 'Bandra' }, { value: 'Juhu' }] } },
      },
    },
    { title: 'Documents', questionItem: { question: { questionId: 'q_docs', fileUploadQuestion: {} } } },
  ],
};

const fields = describeGoogleForm(form);
const base = { sourceId: 'src-1', formId: 'form-1', formTitle: 'Buyer enquiry', fields };

const response: GoogleFormResponse = {
  responseId: 'ACYDBNj_1',
  createTime: '2026-11-12T10:00:00.000Z',
  lastSubmittedTime: '2026-11-12T10:00:00.000Z',
  answers: {
    q_name: { questionId: 'q_name', textAnswers: { answers: [{ value: 'Manish Baghel' }] } },
    q_mail: { questionId: 'q_mail', textAnswers: { answers: [{ value: 'manish@example.test' }] } },
    q_areas: { questionId: 'q_areas', textAnswers: { answers: [{ value: 'Bandra' }, { value: 'Juhu' }] } },
  },
};

describe('a response the recovery poller read from the Forms API', () => {
  it('becomes the very payload the Apps Script would have posted', () => {
    const payload = responsePayload(base, response);

    expect(payload.source).toBe('google_forms');
    expect(payload.responseId).toBe('ACYDBNj_1');
    expect(payload.submittedAt).toBe('2026-11-12T10:00:00.000Z');
    expect(payload.questions.map((q) => q.key)).toEqual(['q_full_name', 'q_email', 'q_areas', 'q_documents']);
  });

  it('is understood by the same adapter the webhook route uses — one pipeline, not two', () => {
    const delivery = new GoogleFormsAdapter().parse(responsePayload(base, response));

    expect(delivery.providerEventId).toBe('ACYDBNj_1');
    expect(delivery.answers.find((a) => a.key === 'q_full_name')?.scalarText).toBe('Manish Baghel');
    expect(delivery.answers.find((a) => a.key === 'q_email')?.scalarText).toBe('manish@example.test');
    expect(delivery.answers.find((a) => a.key === 'q_areas')?.textValues).toEqual(['Bandra', 'Juhu']);
  });

  it('includes a question nobody answered, with no value', () => {
    const payload = responsePayload(base, response);
    expect(payload.questions.find((q) => q.key === 'q_documents')?.values).toEqual([]);
  });

  it('passes file ids through without opening anything', () => {
    const withFiles = responsePayload(base, {
      ...response,
      answers: {
        ...response.answers,
        q_docs: { questionId: 'q_docs', fileUploadAnswers: { answers: [{ fileId: '1AbC', fileName: 'proof.pdf' }] } },
      },
    });
    expect(withFiles.questions.find((q) => q.key === 'q_documents')?.values).toEqual(['1AbC']);
    // And the adapter turns that into a count, not a link.
    const delivery = new GoogleFormsAdapter().parse(withFiles);
    expect(delivery.answers.find((a) => a.key === 'q_documents')?.scalarText).toBe('1 file uploaded');
  });

  it('produces the same bytes for the same response, which is what makes a hash comparison mean anything', () => {
    expect(JSON.stringify(responsePayload(base, response))).toBe(JSON.stringify(responsePayload(base, response)));
  });

  it('builds the dedupe key the webhook would have built, so neither path can duplicate the other', () => {
    const fromPoll = responsePayload(base, response).responseId;
    const fromWebhook = new GoogleFormsAdapter().parse(responsePayload(base, response)).providerEventId;
    expect(`GOOGLE_FORMS:${fromPoll}`).toBe(`GOOGLE_FORMS:${fromWebhook}`);
  });
});

describe('spotting a response the respondent edited afterwards', () => {
  const submitted = new Date('2026-11-12T10:00:00.000Z');

  it('is not an edit when Google reports the same submission time', () => {
    expect(wasEdited(response, submitted)).toBe(false);
  });

  it('is not an edit when the clocks differ by a moment', () => {
    expect(wasEdited({ ...response, lastSubmittedTime: '2026-11-12T10:00:03.000Z' }, submitted)).toBe(false);
  });

  it('is an edit when Google has a later submission for the same response', () => {
    expect(wasEdited({ ...response, lastSubmittedTime: '2026-11-12T11:30:00.000Z' }, submitted)).toBe(true);
  });

  it('says nothing when there is no stored time or no reported one', () => {
    expect(wasEdited(response, null)).toBe(false);
    expect(wasEdited({ ...response, lastSubmittedTime: null }, submitted)).toBe(false);
    expect(wasEdited({ ...response, lastSubmittedTime: 'not a date' }, submitted)).toBe(false);
  });
});
