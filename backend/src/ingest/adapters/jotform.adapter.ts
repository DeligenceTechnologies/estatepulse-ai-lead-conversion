import { z } from 'zod';
import { FULLNAME_PARTS } from '@/integration/providers/jotform/jotform-form-schema';
import { IngestAdapter, InvalidPayloadError, NormalizedAnswer, NormalizedDelivery, NormalizedField } from './types';

/**
 * Jotform webhook adapter.
 *
 * Jotform posts multipart form fields, not JSON. The ingest route turns them
 * into this JSON before anything is stored (IngestController.jotform):
 *
 *   {
 *     submissionID, formID, formTitle,
 *     rawRequest: { q3_fullName: { first, last }, q4_email: "…", q5_phone: { full: "…" }, slug: "…", … }
 *   }
 *
 * `rawRequest` keys are `q{qid}_{name}`, matching the fields described from
 * the form (jotform-form-schema.ts). It carries no question text and no types,
 * so labels are made from the key's name and types are read from the value's
 * shape. When a form was connected through the API, its fields were already
 * described with the real question text, and the mapping matches by key.
 */

const payloadSchema = z.object({
  submissionID: z.union([z.string(), z.number()]).nullish(),
  formID: z.union([z.string(), z.number()]).nullish(),
  formTitle: z.string().nullish(),
  // Kept as a string if a sender posted it that way; parsed below.
  rawRequest: z.union([z.record(z.string(), z.unknown()), z.string()]),
});

/** Answer keys look like `q12_phoneNumber`. Everything else in rawRequest is Jotform's own. */
const ANSWER_KEY = /^q(\d+)_(.+)$/;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

/** "phoneNumber5" → "Phone number", "fullName" → "Full name", "how_soon" → "How soon". */
function humanize(name: string): string {
  const words = name
    .replace(/\d+$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : name;
}

function answer(key: string, label: string, type: string, raw: unknown, textValues: string[]): NormalizedAnswer {
  const values = textValues.map((t) => t.trim()).filter(Boolean);
  return { key, label, type, raw, textValues: values, scalarText: values.join(', '), labelInferred: true };
}

export class JotformAdapter implements IngestAdapter {
  readonly provider = 'JOTFORM';

  parse(body: unknown): NormalizedDelivery {
    const parsed = payloadSchema.safeParse(body);
    if (!parsed.success) {
      throw new InvalidPayloadError(
        `Not a recognisable Jotform submission: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
      );
    }

    const { submissionID, formID, formTitle } = parsed.data;
    let rawRequest: unknown = parsed.data.rawRequest;
    if (typeof rawRequest === 'string') {
      try {
        rawRequest = JSON.parse(rawRequest);
      } catch {
        throw new InvalidPayloadError('Jotform rawRequest is not valid JSON');
      }
    }
    if (!isObj(rawRequest)) throw new InvalidPayloadError('Jotform rawRequest is not an object');

    const answers: NormalizedAnswer[] = [];
    const ordered = Object.entries(rawRequest)
      .map(([key, value]) => ({ key, value, m: ANSWER_KEY.exec(key) }))
      .filter((e): e is { key: string; value: unknown; m: RegExpExecArray } => e.m !== null)
      .sort((a, b) => Number(a.m[1]) - Number(b.m[1]));

    for (const { key, value, m } of ordered) {
      answers.push(...this.flatten(key, humanize(m[2]), value));
    }

    const fields: NormalizedField[] = answers.map(({ key, label, type }) => ({ key, label, type }));
    const submission = str(submissionID) || null;

    return {
      // One submission is one event. A retried delivery carries the same id and is deduplicated.
      providerEventId: submission,
      providerSubmissionId: submission,
      providerRespondentId: null,
      providerFormId: str(formID) || null,
      providerFormName: str(formTitle) || null,
      eventType: 'FORM_SUBMISSION',
      submittedAt: null,
      answers,
      fields,
      warnings: [],
    };
  }

  /** One answer per value, except a full name, which is two. */
  private flatten(key: string, label: string, value: unknown): NormalizedAnswer[] {
    if (Array.isArray(value)) {
      // Checkboxes, or uploaded files' URLs.
      return [answer(key, label, 'control_checkbox', value, value.map(str))];
    }
    if (!isObj(value)) return [answer(key, label, 'control_textbox', value, [str(value)])];

    if ('first' in value || 'last' in value) {
      return FULLNAME_PARTS.map(({ part, label: partLabel }) =>
        answer(`${key}.${part}`, partLabel, 'control_fullname', value[part] ?? null, [str(value[part])]),
      );
    }
    if ('full' in value || 'area' in value || 'phone' in value) {
      let phone = str(value.full) || [str(value.area), str(value.phone)].filter(Boolean).join(' ');
      // With "Country Code" switched on in Jotform, the code arrives as its own part.
      // Without it the number has no country, and is held back from dialling rather than guessed.
      const country = str(value.country).replace(/^\+/, '');
      if (phone && country && !phone.startsWith('+')) phone = `+${country} ${phone}`;
      return [answer(key, label, 'control_phone', value, [phone])];
    }
    if ('addr_line1' in value || 'city' in value || 'postal' in value) {
      const parts = ['addr_line1', 'addr_line2', 'city', 'state', 'postal', 'country'].map((p) => str(value[p])).filter(Boolean);
      return [answer(key, label, 'control_address', value, [parts.join(', ')])];
    }
    if ('month' in value && 'day' in value && 'year' in value) {
      const date = [str(value.month), str(value.day), str(value.year)].join('/');
      const time = str(value.hour) ? ` ${str(value.hour)}:${str(value.min).padStart(2, '0')} ${str(value.ampm)}`.trimEnd() : '';
      return [answer(key, label, 'control_datetime', value, [date + time])];
    }
    // Anything else (a matrix, a widget): keep every non-empty part, readable.
    const parts = Object.entries(value)
      .map(([k, v]) => (isObj(v) || Array.isArray(v) ? `${k}: ${JSON.stringify(v)}` : str(v) && `${k}: ${str(v)}`))
      .filter(Boolean) as string[];
    return [answer(key, label, 'control_widget', value, [parts.join('; ')])];
  }
}
