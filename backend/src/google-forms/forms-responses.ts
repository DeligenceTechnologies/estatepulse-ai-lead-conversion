import { describeGoogleForm, type GoogleForm, type GoogleFormsField } from './forms-schema';

/**
 * Turning a `forms.responses.list` entry into the very payload the Apps Script
 * would have posted for it.
 *
 * This is what keeps the recovery poller out of the lead business entirely:
 * it does not create leads, it creates the delivery that was missed. The same
 * adapter parses it, the same dedupe key covers it, the same worker maps it.
 * A response recovered by the poller and one delivered by the script are the
 * same row in the same table, and only the first of them to arrive is kept.
 */

export interface GoogleFormAnswer {
  questionId?: string | null;
  textAnswers?: { answers?: { value?: string | null }[] | null } | null;
  fileUploadAnswers?: { answers?: { fileId?: string | null; fileName?: string | null }[] | null } | null;
}

export interface GoogleFormResponse {
  responseId?: string | null;
  createTime?: string | null;
  lastSubmittedTime?: string | null;
  answers?: Record<string, GoogleFormAnswer> | null;
}

export interface GoogleFormResponsePage {
  responses?: GoogleFormResponse[] | null;
  nextPageToken?: string | null;
}

/** The payload shape of apps-script.ts, built from the API instead. */
export interface GoogleFormsPayload {
  source: 'google_forms';
  version: 1;
  sourceId: string;
  formId: string;
  formTitle: string;
  responseId: string;
  submittedAt: string;
  questions: { key: string; title: string; type: string; values: string[] }[];
}

function valuesOf(answer: GoogleFormAnswer | undefined): string[] {
  if (!answer) return [];
  const text = (answer.textAnswers?.answers ?? [])
    .map((a) => (a?.value ?? '').trim())
    .filter(Boolean);
  if (text.length > 0) return text;
  // File uploads answer with Drive ids. Passed through exactly as the script
  // passes them; the adapter turns them into "N files uploaded" and never
  // opens anything.
  return (answer.fileUploadAnswers?.answers ?? []).map((a) => (a?.fileId ?? '').trim()).filter(Boolean);
}

/**
 * One response as a delivery payload.
 *
 * Every question is included, answered or not, which is what the script does
 * and what keeps an unanswered question visible on the mapping screen.
 */
export function responsePayload(
  input: { sourceId: string; formId: string; formTitle: string; fields: GoogleFormsField[] },
  response: GoogleFormResponse,
): GoogleFormsPayload {
  const answers = response.answers ?? {};
  return {
    source: 'google_forms',
    version: 1,
    sourceId: input.sourceId,
    formId: input.formId,
    formTitle: input.formTitle,
    responseId: response.responseId ?? '',
    // The ORIGINAL submission time, not the last edit: it is what the lead's
    // "submitted at" means, and the script sends the same thing.
    submittedAt: response.createTime ?? response.lastSubmittedTime ?? new Date().toISOString(),
    questions: input.fields.map((f) => ({
      key: f.key,
      title: f.label,
      type: f.type,
      values: valuesOf(answers[f.externalQuestionId]),
    })),
  };
}

/** The questions of a form, as the poller needs them to read its responses. */
export const fieldsOf = (form: GoogleForm): GoogleFormsField[] => describeGoogleForm(form);

/**
 * Whether Google has a later submission for a response than the one we stored.
 *
 * `lastSubmittedTime` moves when a respondent edits an answer through the
 * "Edit your response" link; `createTime` does not. A couple of seconds of
 * slack keeps millisecond rounding between Google's clock and ours from
 * reading as an edit.
 */
export function wasEdited(response: GoogleFormResponse, storedSubmittedAt: Date | null): boolean {
  if (!storedSubmittedAt || !response.lastSubmittedTime) return false;
  const last = new Date(response.lastSubmittedTime).getTime();
  if (Number.isNaN(last)) return false;
  return last - storedSubmittedAt.getTime() > 5000;
}
