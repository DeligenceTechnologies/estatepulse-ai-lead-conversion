import type { ImportedRecord } from '../adapter.interface';
import { cellNumber, splitName } from '../airtable/airtable.mapping';

/**
 * Pure Tally logic: which lead field a form question can fill, how an answer
 * reads as text, and how one submission becomes an ImportedRecord. No HTTP here.
 *
 * Tally documents `answer` only as "string | number | boolean | array | object",
 * not per question type. So the readers below never assume a shape: they take a
 * plain string or number as is, fall back to Tally's own `formattedAnswer`
 * (always a string), and only then dig into arrays and objects.
 */

export interface TallyQuestionField {
  uuid: string;
  type: string;
  title?: string | null;
}

export interface TallyQuestion {
  id: string;
  type: string;
  title?: string | null;
  isDeleted?: boolean;
  fields?: TallyQuestionField[];
}

export interface TallyResponse {
  questionId: string;
  answer?: unknown;
  formattedAnswer?: string | null;
}

export interface TallySubmission {
  id: string;
  formId?: string;
  respondentId?: string;
  isCompleted?: boolean;
  submittedAt?: string | null;
  responses?: TallyResponse[];
}

/** Lead fields a Tally question may fill. `fullName` is split into first and last. */
export const MAPPABLE = [
  'fullName',
  'firstName',
  'lastName',
  'email',
  'phone',
  'location',
  'timeline',
  'motivation',
  'minBudget',
  'maxBudget',
  'bedrooms',
] as const;
export type MappableField = (typeof MAPPABLE)[number];
/** Lead field -> Tally question id. Ids survive a question being renamed. */
export type FieldMap = Partial<Record<MappableField, string>>;

const NUMERIC: ReadonlySet<MappableField> = new Set(['minBudget', 'maxBudget', 'bedrooms']);

/** Free-text inputs: can hold any text, including an email or a phone typed into a text box. */
const FREE_TEXT = new Set(['INPUT_TEXT', 'TEXTAREA', 'INPUT_EMAIL', 'INPUT_PHONE_NUMBER', 'INPUT_LINK']);
/** Choice questions: a budget range, a timeline, an area picked from a list. */
const CHOICE = new Set(['MULTIPLE_CHOICE', 'DROPDOWN', 'CHECKBOXES', 'MULTI_SELECT', 'RANKING', 'LINEAR_SCALE', 'RATING']);
const NUMBERISH = new Set(['INPUT_NUMBER', 'LINEAR_SCALE', 'RATING', 'CALCULATED_FIELDS', 'INPUT_TEXT', 'DROPDOWN', 'MULTIPLE_CHOICE']);

/**
 * Question types that never carry an answer a person typed or chose (layout,
 * media, logic). They are not offered for mapping and not kept as custom fields.
 */
const NO_ANSWER = new Set([
  'FORM_TITLE',
  'TEXT',
  'LABEL',
  'TITLE',
  'HEADING_1',
  'HEADING_2',
  'HEADING_3',
  'DIVIDER',
  'PAGE_BREAK',
  'IMAGE',
  'EMBED',
  'EMBED_VIDEO',
  'EMBED_AUDIO',
  'CONDITIONAL_LOGIC',
  'CAPTCHA',
  'THANK_YOU_PAGE',
]);
/** Answers that are not useful on a lead (a file link, a signature image, a payment receipt). */
const NOT_KEPT = new Set(['FILE_UPLOAD', 'SIGNATURE', 'PAYMENT']);

/** Whether a question of this Tally type may fill this lead field. */
export function compatible(type: string, target: MappableField): boolean {
  if (NO_ANSWER.has(type) || NOT_KEPT.has(type)) return false;
  if (target === 'email') return type === 'INPUT_EMAIL' || type === 'INPUT_TEXT' || type === 'HIDDEN_FIELDS';
  // A number input has already lost the leading "+" and any leading zero.
  if (target === 'phone') return type === 'INPUT_PHONE_NUMBER' || type === 'INPUT_TEXT' || type === 'HIDDEN_FIELDS';
  if (target === 'fullName' || target === 'firstName' || target === 'lastName') return type === 'INPUT_TEXT' || type === 'HIDDEN_FIELDS';
  if (NUMERIC.has(target)) return NUMBERISH.has(type);
  if (target === 'timeline') return FREE_TEXT.has(type) || CHOICE.has(type) || type === 'INPUT_DATE' || type === 'INPUT_TIME';
  return FREE_TEXT.has(type) || CHOICE.has(type) || type === 'HIDDEN_FIELDS' || type === 'RESPONDENT_COUNTRY';
}

/** Questions that can hold an answer worth reading, in form order. Deleted ones are gone from the form. */
export function answerable(questions: readonly TallyQuestion[]): TallyQuestion[] {
  return questions.filter((q) => !q.isDeleted && typeof q.id === 'string' && !NO_ANSWER.has(q.type));
}

/** The question as the owner sees it in the Tally editor. */
export function questionTitle(q: TallyQuestion): string {
  const own = typeof q.title === 'string' ? q.title.trim() : '';
  if (own) return own;
  const field = q.fields?.find((f) => typeof f.title === 'string' && f.title.trim());
  return field?.title?.trim() || q.type.toLowerCase().replace(/_/g, ' ');
}

/** Question-title hints, matched on the lowercased title with spaces and punctuation removed. */
const HINTS: Record<MappableField, RegExp> = {
  fullName: /^(your)?(full)?name$|^(contact|lead|client|customer)name$|^whatsyourname$|^whatisyourname$/,
  firstName: /^(your)?(first|given)name$|^fname$|^first$/,
  lastName: /^(your)?(last|family|sur)name$|^lname$|^surname$|^last$/,
  email: /e?mail/,
  phone: /phone|mobile|cell|whatsapp|contactnumber|telephone/,
  location: /^(preferred)?(location|city|area|address|neighbou?rhood|region|locality)$|wheredoyouwant|whichareas?/,
  timeline: /timeline|timeframe|movein|whendoyou(want|plan)|howsoon|whentobuy|purchasetime/,
  motivation: /^(notes?|message|comments?|motivation|requirements?|anythingelse|additionalinfo(rmation)?)$/,
  minBudget: /^(min|minimum)(budget|price)|budgetmin/,
  maxBudget: /^(max|maximum)(budget|price)|budgetmax|^(your)?budget$|^budget(range)?$|whatsyourbudget|whatisyourbudget/,
  bedrooms: /bed(room)?s?|bhk/,
};

const squash = (title: string) => title.toLowerCase().replace(/[^a-z0-9]/g, '');

/** A first guess at the field map from question titles and types; the owner can change it. */
export function suggestFieldMap(questions: readonly TallyQuestion[]): FieldMap {
  const candidates = answerable(questions);
  const map: FieldMap = {};
  const used = new Set<string>();
  const take = (target: MappableField, q: TallyQuestion | undefined) => {
    if (!q) return;
    map[target] = q.id;
    used.add(q.id);
  };

  // A dedicated email / phone block is a certain match; take it before guessing from titles.
  take('email', candidates.find((q) => q.type === 'INPUT_EMAIL'));
  take('phone', candidates.find((q) => q.type === 'INPUT_PHONE_NUMBER'));

  // Specific fields before fullName, so "First name" is never taken as the full name.
  const order: MappableField[] = ['email', 'phone', 'firstName', 'lastName', 'fullName', 'minBudget', 'maxBudget', 'bedrooms', 'location', 'timeline', 'motivation'];
  for (const target of order) {
    if (map[target]) continue;
    take(
      target,
      candidates.find((q) => !used.has(q.id) && compatible(q.type, target) && HINTS[target].test(squash(questionTitle(q)))),
    );
  }
  if (map.firstName && map.fullName) delete map.fullName;
  return map;
}

/** Any answer value as plain text, or null when there is nothing a person could read. */
function valueText(value: unknown, depth = 0): string | null {
  if (value === null || value === undefined || depth > 3) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) {
    const parts = value.map((v) => valueText(v, depth + 1)).filter((v): v is string => Boolean(v));
    return parts.length ? parts.join(', ') : null;
  }
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    // Choice options ({ id, text }), files ({ name, url }), hidden fields ({ name, value }).
    for (const key of ['text', 'value', 'label', 'name', 'email', 'url']) {
      const t = valueText(o[key], depth + 1);
      if (t) return t;
    }
  }
  return null;
}

/** One answer as text. A raw string or number answer is the respondent's own input; otherwise Tally's formatted text wins. */
export function answerText(response: TallyResponse | undefined): string | null {
  if (!response) return null;
  const { answer, formattedAnswer } = response;
  if (typeof answer === 'string' || typeof answer === 'number') return valueText(answer);
  const formatted = typeof formattedAnswer === 'string' ? formattedAnswer.trim() : '';
  return formatted || valueText(answer);
}

/** "₹45,00,000", "450000", "3 BHK", "3.5" -> a number; anything else -> null. Ranges ("50L - 75L") are not guessed. */
export function answerNumber(response: TallyResponse | undefined): number | null {
  if (!response) return null;
  if (typeof response.answer === 'number') return Number.isFinite(response.answer) ? response.answer : null;
  const text = answerText(response);
  if (!text || /\d\s*(-|–|to)\s*\d/i.test(text)) return null;
  return cellNumber(text);
}

const MAX_CUSTOM_FIELDS = 30;
const MAX_CUSTOM_VALUE = 1_000;

/**
 * One Tally submission as lead fields. Answers to unmapped questions are kept
 * on the lead as custom fields, labelled with the question's title.
 */
export function toImportedRecord(submission: TallySubmission, formId: string, questions: readonly TallyQuestion[], map: FieldMap): ImportedRecord {
  const byQuestion = new Map<string, TallyResponse>();
  for (const r of submission.responses ?? []) if (r && typeof r.questionId === 'string') byQuestion.set(r.questionId, r);

  const read = (target: MappableField) => (map[target] ? byQuestion.get(map[target]!) : undefined);
  const text = (target: MappableField) => answerText(read(target));
  const number = (target: MappableField) => answerNumber(read(target));

  let firstName = text('firstName');
  let lastName = text('lastName');
  const full = text('fullName');
  if (!firstName && full) {
    const split = splitName(full);
    firstName = split.firstName;
    lastName = lastName ?? split.lastName;
  }

  const mapped = new Set(Object.values(map));
  const customFields: Record<string, string> = {};
  for (const q of answerable(questions)) {
    if (mapped.has(q.id) || NOT_KEPT.has(q.type) || Object.keys(customFields).length >= MAX_CUSTOM_FIELDS) continue;
    const value = answerText(byQuestion.get(q.id));
    if (!value) continue;
    let key = questionTitle(q).slice(0, 100);
    // Two questions with the same title must not overwrite each other.
    for (let n = 2; key in customFields; n++) key = `${questionTitle(q).slice(0, 95)} (${n})`;
    customFields[key] = value.slice(0, MAX_CUSTOM_VALUE);
  }
  if (submission.submittedAt) customFields['Tally submitted at'] = submission.submittedAt;

  const bedrooms = number('bedrooms');
  return {
    objectType: `tally:${formId}`,
    externalId: submission.id,
    firstName,
    lastName,
    email: text('email'),
    phone: text('phone'),
    location: text('location'),
    timeline: text('timeline'),
    motivation: text('motivation'),
    minBudget: number('minBudget'),
    maxBudget: number('maxBudget'),
    bedrooms: bedrooms === null ? null : Math.round(bedrooms),
    customFields,
  };
}
