import { z } from 'zod';
import { keyAssigner } from '@/google-forms/forms-schema';
import {
  AdapterWarning,
  IngestAdapter,
  InvalidPayloadError,
  NormalizedAnswer,
  NormalizedDelivery,
  NormalizedField,
} from './types';

/**
 * Google Forms webhook adapter: what the Apps Script on the owner's form posts.
 *
 * Payload (version 1 — apps-script.ts generates it):
 *
 *   {
 *     source: "google_forms", version: 1,
 *     formId, formTitle, responseId, submittedAt,
 *     questions: [
 *       { key: "q_full_name", itemId: "123456", title: "Full name",
 *         type: "TEXT", values: ["John Smith"] },
 *       { key: "q_areas", title: "Areas", type: "CHECKBOXES",
 *         values: ["Bandra", "Andheri"] },
 *       { key: "q_budget", title: "Budget", type: "TEXT", values: [] }   // unanswered
 *     ]
 *   }
 *
 * `key` is computed by the script with the same rule the backend uses when it
 * reads the form through `forms.get` (forms-schema.ts `fieldKey`), so the
 * mapping the owner saved before anyone submitted anything matches the first
 * delivery. The script sends EVERY question, answered or not, which keeps the
 * field catalog complete and lets an owner map a question nobody has filled in
 * yet.
 *
 * The simpler `{ fields: { "Full name": "John Smith" } }` shape is accepted
 * too, for anyone posting this contract by hand. Keys are derived from the
 * titles in the order given, which is the best that shape can do — a form with
 * two identically titled questions needs the `questions` array.
 */

const MAX_QUESTIONS = 300;
const MAX_VALUE_CHARS = 2000;

const questionSchema = z.object({
  key: z.string().min(1).max(255).nullish(),
  itemId: z.union([z.string(), z.number()]).nullish(),
  title: z.string().nullish(),
  type: z.string().nullish(),
  values: z.array(z.union([z.string(), z.number(), z.boolean()])).nullish(),
});

const payloadSchema = z.object({
  source: z.string().nullish(),
  version: z.number().nullish(),
  formId: z.string().nullish(),
  formTitle: z.string().nullish(),
  responseId: z.string().nullish(),
  submittedAt: z.string().nullish(),
  questions: z.array(questionSchema).nullish(),
  /** The flat alternative: question title -> answer. */
  fields: z.record(z.string(), z.unknown()).nullish(),
});

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const text = (v: unknown): string =>
  (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '')
    .trim()
    .slice(0, MAX_VALUE_CHARS);

export class GoogleFormsAdapter implements IngestAdapter {
  readonly provider = 'GOOGLE_FORMS';

  parse(body: unknown): NormalizedDelivery {
    const parsed = payloadSchema.safeParse(body);
    if (!parsed.success) {
      throw new InvalidPayloadError(
        `Not a recognisable Google Forms payload: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
      );
    }
    const p = parsed.data;

    // The response id is the whole idempotency story — without it a redelivery
    // would become a second lead, so a payload that lacks one is refused
    // rather than guessed at.
    if (!p.responseId) throw new InvalidPayloadError('The payload carries no responseId');

    const warnings: AdapterWarning[] = [];
    const answers: NormalizedAnswer[] = [];
    const fields: NormalizedField[] = [];
    const nextKey = keyAssigner();

    const items: { key: string; label: string; type: string; values: unknown[]; raw: unknown }[] = [];
    if (p.questions?.length) {
      for (const q of p.questions.slice(0, MAX_QUESTIONS)) {
        const label = (q.title ?? '').trim() || 'Untitled question';
        // The script's own key wins; the fallback covers a hand-rolled poster
        // that sent titles only.
        items.push({
          key: q.key ?? nextKey(label),
          label,
          type: (q.type ?? 'TEXT').toUpperCase(),
          values: q.values ?? [],
          raw: q.values ?? null,
        });
      }
    } else if (p.fields) {
      for (const [title, value] of Object.entries(p.fields).slice(0, MAX_QUESTIONS)) {
        const label = title.trim() || 'Untitled question';
        items.push({
          key: nextKey(label),
          label,
          type: 'TEXT',
          values: Array.isArray(value) ? value : [value],
          raw: value,
        });
      }
    } else {
      throw new InvalidPayloadError('The payload carries no questions');
    }

    if (p.questions && p.questions.length > MAX_QUESTIONS) {
      warnings.push({ code: 'too_many_questions', detail: `Only the first ${MAX_QUESTIONS} questions were read` });
    }

    for (const item of items) {
      const textValues = item.values.map(text).filter(Boolean);
      // A file upload answers with Drive file ids. We never follow them: the
      // file is not ours to read, and an id is no use to whoever reads the
      // lead. The count is what is worth saying; the ids stay in `raw`.
      const isFile = item.type === 'FILE_UPLOAD';
      if (isFile && textValues.length > 0) {
        warnings.push({ code: 'file_upload_answer', fieldKey: item.key, detail: `${item.label}: file uploads are not imported` });
      }
      const scalarText = isFile
        ? textValues.length > 0
          ? `${textValues.length} file${textValues.length === 1 ? '' : 's'} uploaded`
          : ''
        : textValues.join(', ').trim();

      answers.push({
        key: item.key,
        label: item.label,
        type: item.type,
        raw: item.raw,
        textValues: isFile ? (scalarText ? [scalarText] : []) : textValues,
        scalarText,
      });
      fields.push({ key: item.key, label: item.label, type: item.type });
    }

    return {
      // Google's response id IS the delivery's identity: the dedupe key the
      // ingest service builds from it is what makes a redelivery, a retry from
      // the script and a poll recovery land on the same row.
      providerEventId: p.responseId,
      providerSubmissionId: p.responseId,
      providerRespondentId: null,
      providerFormId: p.formId ?? null,
      providerFormName: p.formTitle ?? null,
      eventType: 'google_forms.response',
      submittedAt: parseDate(p.submittedAt),
      answers,
      fields,
      warnings,
    };
  }
}
