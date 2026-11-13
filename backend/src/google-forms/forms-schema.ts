import type { DescribedField } from '@/integration/providers/tally/tally-form-schema';
import type { NormalizedOption } from '@/ingest/adapters/types';

/**
 * One vocabulary for a Google Form's questions, shared by the two things that
 * must agree on it:
 *
 *   - `forms.get`, read at setup so the owner can map the questions before
 *     anybody has submitted anything, and read again to notice the form
 *     changed;
 *   - the Apps Script on the owner's form, which posts each response.
 *
 * They have to name the same question the same way, because the owner's
 * mapping rows are keyed by that name. They cannot share Google's own ids:
 * `forms.get` returns the Forms API `questionId` (hex, e.g. "4a1f0c2b") while
 * Apps Script's `Item.getId()` returns a different, numeric item id, and
 * nothing in Apps Script exposes the API's id. Keying on one of them would
 * mean the webhook and the poller disagreed about every question.
 *
 * So the key is derived from the question's title, in document order, which
 * both sides see identically — `fieldKey()` below is mirrored byte for byte in
 * the generated Apps Script (apps-script.ts). Google's own ids ride along as
 * metadata so nothing is lost: the Forms `questionId` on the catalog row, the
 * Apps Script item id on the delivery.
 *
 * A renamed question therefore produces a NEW key. That is deliberate: the old
 * mapping stops matching, the answer lands in custom fields rather than in the
 * wrong lead column, and the schema fingerprint changes, which flags the
 * source for mapping review. Wrong data is the one outcome worth avoiding.
 */

/** Forms API: the subset of `forms.get` we read. */
export interface GoogleFormOption {
  value?: string | null;
  isOther?: boolean | null;
}

export interface GoogleFormQuestion {
  questionId?: string | null;
  required?: boolean | null;
  textQuestion?: { paragraph?: boolean | null } | null;
  choiceQuestion?: { type?: string | null; options?: GoogleFormOption[] | null } | null;
  scaleQuestion?: Record<string, unknown> | null;
  dateQuestion?: Record<string, unknown> | null;
  timeQuestion?: Record<string, unknown> | null;
  fileUploadQuestion?: Record<string, unknown> | null;
  rowQuestion?: { title?: string | null } | null;
}

export interface GoogleFormItem {
  itemId?: string | null;
  title?: string | null;
  description?: string | null;
  questionItem?: { question?: GoogleFormQuestion | null } | null;
  questionGroupItem?: { questions?: GoogleFormQuestion[] | null } | null;
  /** Layout items — page breaks, images, videos, text blocks. Never questions. */
  pageBreakItem?: Record<string, unknown> | null;
  textItem?: Record<string, unknown> | null;
  imageItem?: Record<string, unknown> | null;
  videoItem?: Record<string, unknown> | null;
}

export interface GoogleForm {
  formId?: string | null;
  info?: { title?: string | null; documentTitle?: string | null } | null;
  items?: GoogleFormItem[] | null;
  revisionId?: string | null;
}

/** A described Google Forms question: a DescribedField plus Google's own id. */
export interface GoogleFormsField extends DescribedField {
  /** The Forms API `questionId`, kept so the original question is identifiable. */
  externalQuestionId: string;
}

const MAX_KEY_CHARS = 120;

/**
 * The stable key for a question. MIRRORED IN THE GENERATED APPS SCRIPT — change
 * one and you must change the other, or in-flight mappings stop matching.
 *
 * `ordinal` is 1 for the first question carrying this title, 2 for the next,
 * and so on, counted over question items only in document order. Two questions
 * really can share a title, and they must not share a mapping.
 */
export function fieldKey(title: string, ordinal: number): string {
  const slug = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_KEY_CHARS);
  const base = slug ? `q_${slug}` : 'q_untitled';
  return ordinal > 1 ? `${base}__${ordinal}` : base;
}

/** Assigns each title its ordinal, in the order the questions appear. */
export function keyAssigner(): (title: string) => string {
  const seen = new Map<string, number>();
  return (title: string) => {
    const t = String(title ?? '');
    const n = (seen.get(t) ?? 0) + 1;
    seen.set(t, n);
    return fieldKey(t, n);
  };
}

function questionType(q: GoogleFormQuestion): string {
  if (q.choiceQuestion) {
    const t = (q.choiceQuestion.type ?? '').toUpperCase();
    // Tally's upper-case vocabulary, which the mapping heuristics already read
    // (ingest/processing/heuristics.ts) — so a "Budget" dropdown is recognised
    // here exactly as it is on a Tally form.
    if (t === 'CHECKBOX') return 'CHECKBOXES';
    if (t === 'DROP_DOWN') return 'DROPDOWN';
    return 'MULTIPLE_CHOICE';
  }
  if (q.fileUploadQuestion) return 'FILE_UPLOAD';
  if (q.scaleQuestion) return 'SCALE';
  if (q.dateQuestion) return 'DATE';
  if (q.timeQuestion) return 'TIME';
  if (q.textQuestion?.paragraph) return 'PARAGRAPH_TEXT';
  return 'TEXT';
}

function optionsOf(q: GoogleFormQuestion): NormalizedOption[] {
  const raw = q.choiceQuestion?.options ?? [];
  const out: NormalizedOption[] = [];
  for (const o of raw) {
    const text = (o?.value ?? '').trim();
    // The "Other…" option carries no value of its own; what the respondent
    // typed arrives as the answer text, so there is no option to list.
    if (!text || o?.isOther) continue;
    out.push({ id: text, text });
  }
  return out;
}

/** Question items only, in document order: what both sides count ordinals over. */
export function questionItems(form: GoogleForm): GoogleFormItem[] {
  return (form.items ?? []).filter((i) => Boolean(i?.questionItem?.question || i?.questionGroupItem));
}

/**
 * The form's questions as the mapping screen and the heuristics want them.
 *
 * ponytail: a grid question (one item, several rows) is described as one
 * field, not one per row — its answers join into a single text value. Grids do
 * not carry a name, a phone or an email, which is all a lead mapping takes.
 * Split it per row if a customer ever maps grid rows individually.
 */
export function describeGoogleForm(form: GoogleForm): GoogleFormsField[] {
  const nextKey = keyAssigner();
  const out: GoogleFormsField[] = [];

  for (const item of questionItems(form)) {
    const title = (item.title ?? '').trim();
    const question = item.questionItem?.question ?? item.questionGroupItem?.questions?.[0] ?? {};
    const grouped = Boolean(item.questionGroupItem);
    const type = grouped ? 'GRID' : questionType(question);
    const options = grouped ? [] : optionsOf(question);

    out.push({
      key: nextKey(title),
      label: title || 'Untitled question',
      type,
      ...(options.length > 0 ? { options } : {}),
      externalQuestionId: question.questionId ?? item.itemId ?? '',
      // A single-option checkbox is a consent tick, here as on Tally. Never
      // pre-mapped (prebuild-mapping.ts withholds consent), only offered.
      booleanOptIn: type === 'CHECKBOXES' && options.length <= 1,
    });
  }

  return out;
}

export const formTitle = (form: GoogleForm): string =>
  (form.info?.title ?? form.info?.documentTitle ?? '').trim() || 'Untitled form';
