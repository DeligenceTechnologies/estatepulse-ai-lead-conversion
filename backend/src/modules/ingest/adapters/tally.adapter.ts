import { z } from 'zod';
import {
  AdapterWarning,
  IngestAdapter,
  InvalidPayloadError,
  NormalizedAnswer,
  NormalizedDelivery,
  NormalizedField,
  NormalizedOption,
} from './types';

/**
 * Tally.so webhook adapter.
 *
 * Payload shape:
 *   {
 *     eventId, eventType: "FORM_RESPONSE", createdAt,
 *     data: {
 *       responseId, submissionId, respondentId, formId, formName, createdAt,
 *       fields: [{ key, label, type, value, options? }]
 *     }
 *   }
 *
 * Field types are validated loosely on purpose — Tally adds new ones, and we
 * should never reject a real customer's submission because we have not heard of
 * `INPUT_TIME` yet. Unknown types normalize to text and flow through to
 * `custom_fields`.
 */

const tallyOptionSchema = z.object({
  id: z.string(),
  text: z.string().nullish(),
});

const tallyFieldSchema = z.object({
  key: z.string(),
  label: z.string().nullish(),
  type: z.string().nullish(),
  value: z.unknown(),
  options: z.array(tallyOptionSchema).nullish(),
});

const tallyPayloadSchema = z.object({
  eventId: z.string().nullish(),
  eventType: z.string().nullish(),
  createdAt: z.string().nullish(),
  data: z.object({
    responseId: z.string().nullish(),
    submissionId: z.string().nullish(),
    respondentId: z.string().nullish(),
    formId: z.string().nullish(),
    formName: z.string().nullish(),
    createdAt: z.string().nullish(),
    fields: z.array(tallyFieldSchema).nullish(),
  }),
});

/** Tally field types whose `value` is an array of option IDs, not text. */
const CHOICE_TYPES = new Set([
  'DROPDOWN',
  'MULTIPLE_CHOICE',
  'CHECKBOXES',
  'MULTI_SELECT',
  'RANKING',
  'MATRIX',
]);

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export class TallyAdapter implements IngestAdapter {
  readonly provider = 'TALLY';

  parse(body: unknown): NormalizedDelivery {
    const parsed = tallyPayloadSchema.safeParse(body);
    if (!parsed.success) {
      throw new InvalidPayloadError(
        `Not a recognisable Tally webhook payload: ${parsed.error.issues
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; ')}`,
      );
    }

    const { eventId, eventType, createdAt, data } = parsed.data;
    const warnings: AdapterWarning[] = [];
    const answers: NormalizedAnswer[] = [];
    const fields: NormalizedField[] = [];

    for (const raw of data.fields ?? []) {
      const type = raw.type ?? 'UNKNOWN';
      const label = raw.label ?? raw.key;
      const options: NormalizedOption[] | undefined = raw.options?.map((o) => ({
        id: o.id,
        text: o.text ?? '',
      }));

      const { textValues, optionIds } = this.resolveValue(raw.key, type, raw.value, options, warnings);

      answers.push({
        key: raw.key,
        label,
        type,
        raw: raw.value,
        textValues,
        scalarText: textValues.join(', ').trim(),
        ...(optionIds ? { optionIds } : {}),
        ...(options ? { allOptions: options } : {}),
      });

      fields.push({ key: raw.key, label, type, ...(options ? { options } : {}) });
    }

    return {
      providerEventId: eventId ?? null,
      // Tally exposes both; responseId is the stable per-response identifier.
      providerSubmissionId: data.responseId ?? data.submissionId ?? null,
      providerRespondentId: data.respondentId ?? null,
      providerFormId: data.formId ?? null,
      providerFormName: data.formName ?? null,
      eventType: eventType ?? null,
      submittedAt: parseDate(data.createdAt) ?? parseDate(createdAt),
      answers,
      fields,
      warnings,
    };
  }

  /**
   * Turn a raw Tally `value` into display text.
   *
   * The important case is choice fields: `value` is an array of option UUIDs and
   * the human text lives only in the sibling `options` array. Resolving here
   * means no transform downstream ever sees a UUID — miss this and every
   * dropdown answer silently stores as `"option_1"`, which looks like working
   * software right up until someone reads a lead record.
   */
  private resolveValue(
    fieldKey: string,
    type: string,
    value: unknown,
    options: NormalizedOption[] | undefined,
    warnings: AdapterWarning[],
  ): { textValues: string[]; optionIds?: string[] } {
    if (value === null || value === undefined || value === '') {
      return { textValues: [] };
    }

    const isChoice = CHOICE_TYPES.has(type) || (Array.isArray(value) && options && options.length > 0);

    if (isChoice && options && options.length > 0) {
      const ids = (Array.isArray(value) ? value : [value]).map((v) => String(v));
      const byId = new Map(options.map((o) => [o.id, o.text]));
      const textValues: string[] = [];

      for (const id of ids) {
        const text = byId.get(id);
        if (text === undefined) {
          // Do not throw: one stale option reference must not cost us the whole
          // lead. Surface it and keep the raw id so the value is recoverable.
          warnings.push({
            code: 'UNRESOLVED_OPTION',
            fieldKey,
            detail: `Option id "${id}" is not present in the field's options list`,
          });
          textValues.push(id);
        } else {
          textValues.push(text);
        }
      }
      return { textValues, optionIds: ids };
    }

    if (Array.isArray(value)) {
      return { textValues: value.filter((v) => v !== null && v !== undefined).map((v) => String(v)) };
    }

    if (typeof value === 'object') {
      // FILE_UPLOAD, SIGNATURE, PAYMENT and friends deliver structured objects.
      // Keep a readable scalar; the full object survives in `raw` and lands in
      // custom_fields.
      return { textValues: [JSON.stringify(value)] };
    }

    if (typeof value === 'boolean') {
      return { textValues: [value ? 'true' : 'false'] };
    }

    return { textValues: [String(value)] };
  }
}
