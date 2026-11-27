import type { ImportedRecord } from '../adapter.interface';
import { cellNumber, splitName } from '../airtable/airtable.mapping';

/**
 * Pure Typeform logic: which lead field a form field can fill, how an answer
 * reads as text, and how one response becomes an ImportedRecord. No HTTP here.
 *
 * Typeform nests fields: a `group`, `inline_group`, `contact_info`, `address`
 * or `matrix` block holds its own fields in `properties.fields`, and a response
 * answers the inner fields, never the block. So the form is flattened into its
 * leaf fields first. Hidden fields (`?utm_source=…` on the form URL) are not
 * fields at all: they come as `response.hidden[name]` and are offered here as
 * `hidden:<name>`.
 */

export interface TypeformField {
  id: string;
  ref?: string;
  title?: string | null;
  type: string;
  properties?: { fields?: TypeformField[] } & Record<string, unknown>;
}

export interface TypeformFormDefinition {
  id: string;
  title?: string | null;
  fields?: TypeformField[];
  /** Hidden field names declared on the form. */
  hidden?: string[];
}

export interface TypeformAnswer {
  field?: { id?: string; type?: string; ref?: string };
  /** Which key holds the value: text, email, phone_number, number, boolean, date, url, file_url, choice, choices, payment… */
  type?: string;
  [key: string]: unknown;
}

export interface TypeformResponse {
  response_id?: string;
  token?: string;
  landed_at?: string | null;
  submitted_at?: string | null;
  hidden?: Record<string, unknown> | null;
  answers?: TypeformAnswer[] | null;
  calculated?: { score?: number } | null;
}

/** One answerable thing on the form, as the setup screen and the mapping see it. */
export interface TypeformQuestion {
  /** A Typeform field id, or `hidden:<name>` for a hidden field. */
  id: string;
  type: string;
  title: string;
}

/** Lead fields a Typeform field may fill. `fullName` is split into first and last. */
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
/** Lead field -> Typeform field id (or `hidden:<name>`). Ids survive a field being renamed. */
export type FieldMap = Partial<Record<MappableField, string>>;

export const HIDDEN_PREFIX = 'hidden:';
const HIDDEN = 'hidden';

const NUMERIC: ReadonlySet<MappableField> = new Set(['minBudget', 'maxBudget', 'bedrooms']);

/** Blocks whose answers live on their inner fields. */
const CONTAINERS = new Set(['group', 'inline_group', 'contact_info', 'address', 'matrix']);
/** Fields that never carry an answer a person typed or chose. */
const NO_ANSWER = new Set(['statement', 'thankyou_screen', 'welcome_screen']);
/** Answers that are not useful on a lead (a file link, a payment receipt). */
const NOT_KEPT = new Set(['file_upload', 'payment', 'signature']);

const FREE_TEXT = new Set(['short_text', 'long_text', 'email', 'phone_number', 'website']);
const CHOICE = new Set(['multiple_choice', 'dropdown', 'picture_choice', 'ranking', 'opinion_scale', 'rating', 'nps', 'yes_no', 'legal']);
const NUMBERISH = new Set(['number', 'opinion_scale', 'rating', 'nps', 'short_text', 'dropdown', 'multiple_choice']);

/** Whether a field of this Typeform type may fill this lead field. */
export function compatible(type: string, target: MappableField): boolean {
  if (NO_ANSWER.has(type) || NOT_KEPT.has(type) || CONTAINERS.has(type)) return false;
  if (target === 'email') return type === 'email' || type === 'short_text' || type === HIDDEN;
  // A number field has already lost the leading "+" and any leading zero.
  if (target === 'phone') return type === 'phone_number' || type === 'short_text' || type === HIDDEN;
  if (target === 'fullName' || target === 'firstName' || target === 'lastName') return type === 'short_text' || type === HIDDEN;
  if (NUMERIC.has(target)) return NUMBERISH.has(type) || type === HIDDEN;
  if (target === 'timeline') return FREE_TEXT.has(type) || CHOICE.has(type) || type === 'date' || type === HIDDEN;
  return FREE_TEXT.has(type) || CHOICE.has(type) || type === HIDDEN;
}

const titleOf = (field: TypeformField): string => (typeof field.title === 'string' ? field.title.replace(/\s+/g, ' ').trim() : '');

/**
 * The form's answerable fields in form order, inner fields of blocks included,
 * then its hidden fields. An inner field of a contact-info or address block is
 * titled "Block · Field" so two blocks' "First name" can be told apart.
 */
export function flattenForm(form: TypeformFormDefinition): TypeformQuestion[] {
  const out: TypeformQuestion[] = [];
  const seen = new Set<string>();
  const walk = (fields: readonly TypeformField[] | undefined, parentTitle: string | null, depth: number) => {
    if (!Array.isArray(fields) || depth > 4) return;
    for (const f of fields) {
      if (!f || typeof f.id !== 'string' || typeof f.type !== 'string') continue;
      const own = titleOf(f);
      if (CONTAINERS.has(f.type)) {
        // A plain group is just a page section; its title is a heading, not part of the question.
        const label = f.type === 'group' ? parentTitle : [parentTitle, own].filter(Boolean).join(' · ') || null;
        walk(f.properties?.fields, label, depth + 1);
        continue;
      }
      if (NO_ANSWER.has(f.type) || seen.has(f.id)) continue;
      seen.add(f.id);
      const title = [parentTitle, own || f.type.replace(/_/g, ' ')].filter(Boolean).join(' · ');
      out.push({ id: f.id, type: f.type, title });
    }
  };
  walk(form.fields, null, 0);
  for (const name of form.hidden ?? []) {
    if (typeof name !== 'string' || !name.trim()) continue;
    out.push({ id: HIDDEN_PREFIX + name, type: HIDDEN, title: `${name} (hidden field)` });
  }
  return out;
}

/** Field-title hints, matched on the lowercased title with spaces and punctuation removed. */
const HINTS: Record<MappableField, RegExp> = {
  fullName: /^(your)?(full)?name$|^(contact|lead|client|customer)name$|^whatsyourname$|^whatisyourname$/,
  firstName: /(first|given)name$|^fname$|^first$/,
  lastName: /(last|family|sur)name$|^lname$|^last$/,
  email: /e?mail/,
  phone: /phone|mobile|cell|whatsapp|contactnumber|telephone/,
  location: /^(preferred)?(location|city|area|address|neighbou?rhood|region|locality)$|wheredoyouwant|whichareas?/,
  timeline: /timeline|timeframe|movein|whendoyou(want|plan)|howsoon|whentobuy|purchasetime/,
  motivation: /^(notes?|message|comments?|motivation|requirements?|anythingelse|additionalinfo(rmation)?)$/,
  minBudget: /^(min|minimum)(budget|price)|budgetmin/,
  maxBudget: /^(max|maximum)(budget|price)|budgetmax|^(your)?budget$|^budget(range)?$|whatsyourbudget|whatisyourbudget/,
  bedrooms: /bed(room)?s?|bhk/,
};

/** The part of a title the hints read: "Contact info · First name" is matched as "First name". */
const squash = (title: string) =>
  (title.split(' · ').pop() ?? title)
    .replace(/\(hidden field\)$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/** A first guess at the field map from field titles and types; the owner can change it. */
export function suggestFieldMap(questions: readonly TypeformQuestion[]): FieldMap {
  const map: FieldMap = {};
  const used = new Set<string>();
  const take = (target: MappableField, q: TypeformQuestion | undefined) => {
    if (!q) return;
    map[target] = q.id;
    used.add(q.id);
  };

  // A dedicated email / phone field is a certain match; take it before guessing from titles.
  take('email', questions.find((q) => q.type === 'email'));
  take('phone', questions.find((q) => q.type === 'phone_number'));

  // Specific fields before fullName, so "First name" is never taken as the full name.
  const order: MappableField[] = ['email', 'phone', 'firstName', 'lastName', 'fullName', 'minBudget', 'maxBudget', 'bedrooms', 'location', 'timeline', 'motivation'];
  for (const target of order) {
    if (map[target]) continue;
    take(target, questions.find((q) => !used.has(q.id) && compatible(q.type, target) && HINTS[target].test(squash(q.title))));
  }
  if (map.firstName && map.fullName) delete map.fullName;
  return map;
}

/** Any value as plain text, or null when there is nothing a person could read. */
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
    for (const key of ['label', 'text', 'value', 'name', 'url']) {
      const t = valueText(o[key], depth + 1);
      if (t) return t;
    }
  }
  return null;
}

/**
 * One answer as text. Typeform names the key that holds the value in
 * `answer.type`; choice answers carry the picked label(s) and an optional
 * "Other" text.
 */
export function answerText(answer: TypeformAnswer | undefined): string | null {
  if (!answer || typeof answer.type !== 'string') return null;
  const value = answer[answer.type];
  if (answer.type === 'choice') {
    const c = (value ?? {}) as { label?: unknown; other?: unknown };
    return valueText(c.label) ?? valueText(c.other);
  }
  if (answer.type === 'choices') {
    const c = (value ?? {}) as { labels?: unknown; other?: unknown };
    const parts = [...(Array.isArray(c.labels) ? c.labels : []), c.other].map((v) => valueText(v)).filter((v): v is string => Boolean(v));
    return parts.length ? parts.join(', ') : null;
  }
  if (answer.type === 'payment') return null;
  return valueText(value);
}

/** "₹45,00,000", "450000", "3 BHK", "3.5" -> a number; anything else -> null. Ranges ("50L - 75L") are not guessed. */
export function textNumber(text: string | null): number | null {
  if (!text || /\d\s*(-|–|to)\s*\d/i.test(text)) return null;
  return cellNumber(text);
}

const MAX_CUSTOM_FIELDS = 30;
const MAX_CUSTOM_VALUE = 1_000;

/**
 * One Typeform response as lead fields. Answers to unmapped fields (and
 * unmapped hidden fields) are kept on the lead as custom fields, labelled with
 * the field's title.
 */
export function toImportedRecord(response: TypeformResponse, formId: string, questions: readonly TypeformQuestion[], map: FieldMap): ImportedRecord {
  const byField = new Map<string, TypeformAnswer>();
  for (const a of response.answers ?? []) if (a && typeof a.field?.id === 'string') byField.set(a.field.id, a);
  const hidden = response.hidden && typeof response.hidden === 'object' ? response.hidden : {};
  const typeOf = new Map(questions.map((q) => [q.id, q.type]));

  const textFor = (id: string): string | null => {
    if (id.startsWith(HIDDEN_PREFIX)) return valueText(hidden[id.slice(HIDDEN_PREFIX.length)]);
    return answerText(byField.get(id));
  };
  const numberFor = (id: string): number | null => {
    const answer = byField.get(id);
    if (answer?.type === 'number' && typeof answer.number === 'number') return Number.isFinite(answer.number) ? answer.number : null;
    return textNumber(textFor(id));
  };
  const text = (target: MappableField) => (map[target] ? textFor(map[target]!) : null);
  const number = (target: MappableField) => (map[target] ? numberFor(map[target]!) : null);

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
  for (const q of questions) {
    if (mapped.has(q.id) || NOT_KEPT.has(typeOf.get(q.id) ?? '') || Object.keys(customFields).length >= MAX_CUSTOM_FIELDS) continue;
    const value = textFor(q.id);
    if (!value) continue;
    let key = q.title.slice(0, 100);
    // Two fields with the same title must not overwrite each other.
    for (let n = 2; key in customFields; n++) key = `${q.title.slice(0, 95)} (${n})`;
    customFields[key] = value.slice(0, MAX_CUSTOM_VALUE);
  }
  if (typeof response.calculated?.score === 'number') customFields['Typeform score'] = String(response.calculated.score);
  if (response.submitted_at) customFields['Typeform submitted at'] = response.submitted_at;

  const bedrooms = number('bedrooms');
  return {
    objectType: `typeform:${formId}`,
    // `response_id` and `token` are the same value today; `token` is the documented fallback.
    externalId: String(response.response_id || response.token),
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
