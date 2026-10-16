import { z } from 'zod';
import {
  flattenTypeformFields,
  typeformOptions,
  type TypeformField,
} from '../../providers/typeform/typeform-form-schema';
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
 * Typeform webhook adapter.
 *
 * Payload shape:
 *   {
 *     event_id, event_type: "form_response",
 *     form_response: {
 *       form_id, token, submitted_at, landed_at,
 *       definition: { id, title, fields: [{ id, ref, type, title, choices? }] },
 *       answers: [{ type, field: { id, ref, type }, text? | email? | choice? | choices? | … }],
 *       hidden?: { utm_source: "…" }
 *     }
 *   }
 *
 * Unlike Tally, a choice answer already carries its label, so there is no
 * option-id resolution to do; `allOptions` still comes from the definition so
 * an enum map can be built from every option, not just the one picked.
 *
 * Answer types are validated loosely on purpose — Typeform adds new ones, and
 * we should never reject a real customer's submission because we have not heard
 * of one yet. Unknown types normalize to text and flow through to `custom_fields`.
 */

const choiceSchema = z.object({
  id: z.string().nullish(),
  ref: z.string().nullish(),
  label: z.string().nullish(),
  other: z.string().nullish(),
});

const answerSchema = z
  .object({
    type: z.string(),
    field: z.object({ id: z.string(), ref: z.string().nullish(), type: z.string().nullish() }),
    choice: choiceSchema.nullish(),
    choices: z
      .object({
        ids: z.array(z.string()).nullish(),
        refs: z.array(z.string()).nullish(),
        labels: z.array(z.string()).nullish(),
        other: z.string().nullish(),
      })
      .nullish(),
  })
  .passthrough();

const payloadSchema = z.object({
  event_id: z.string().nullish(),
  event_type: z.string().nullish(),
  form_response: z.object({
    form_id: z.string().nullish(),
    token: z.string().nullish(),
    submitted_at: z.string().nullish(),
    landed_at: z.string().nullish(),
    definition: z
      .object({
        title: z.string().nullish(),
        fields: z.array(z.any()).nullish(),
      })
      .nullish(),
    answers: z.array(answerSchema).nullish(),
    hidden: z.record(z.string(), z.unknown()).nullish(),
  }),
});

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export class TypeformAdapter implements IngestAdapter {
  readonly provider = 'TYPEFORM';

  parse(body: unknown): NormalizedDelivery {
    const parsed = payloadSchema.safeParse(body);
    if (!parsed.success) {
      throw new InvalidPayloadError(
        `Not a recognisable Typeform webhook payload: ${parsed.error.issues
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; ')}`,
      );
    }

    const { event_id, event_type, form_response: fr } = parsed.data;
    const warnings: AdapterWarning[] = [];
    const answers: NormalizedAnswer[] = [];
    const fields: NormalizedField[] = [];

    // The definition is the schema; answers only reference it by field id.
    const definition = new Map<string, TypeformField>();
    for (const f of flattenTypeformFields(fr.definition?.fields as TypeformField[] | undefined)) {
      definition.set(f.id, f);
    }

    for (const raw of fr.answers ?? []) {
      const def = definition.get(raw.field.id);
      const type = def?.type ?? raw.field.type ?? raw.type;
      const label = def?.title?.trim() || raw.field.ref || raw.field.id;
      const allOptions = def ? typeformOptions(def) : [];
      const { textValues, optionIds, value } = this.resolveValue(raw);

      answers.push({
        key: raw.field.id,
        label,
        type,
        raw: value,
        textValues,
        scalarText: textValues.join(', ').trim(),
        ...(optionIds ? { optionIds } : {}),
        ...(allOptions.length ? { allOptions } : {}),
      });
    }

    // Every question the form defines, answered or not: the catalog must not
    // forget a question just because this respondent skipped it.
    for (const f of definition.values()) {
      if (f.type === 'statement') continue;
      const options: NormalizedOption[] = typeformOptions(f);
      fields.push({
        key: f.id,
        label: f.title?.trim() || f.ref || f.id,
        type: f.type,
        ...(options.length ? { options } : {}),
      });
    }

    // Hidden fields (utm_source and friends) ride along as plain text.
    for (const [name, v] of Object.entries(fr.hidden ?? {})) {
      if (v === null || v === undefined || v === '') continue;
      const text = typeof v === 'object' ? JSON.stringify(v) : String(v);
      answers.push({ key: `hidden_${name}`, label: name, type: 'hidden', raw: v, textValues: [text], scalarText: text });
      fields.push({ key: `hidden_${name}`, label: name, type: 'hidden' });
    }

    return {
      providerEventId: event_id ?? null,
      // `token` is Typeform's per-response identifier.
      providerSubmissionId: fr.token ?? null,
      providerRespondentId: null,
      providerFormId: fr.form_id ?? null,
      providerFormName: fr.definition?.title ?? null,
      eventType: event_type ?? null,
      submittedAt: parseDate(fr.submitted_at) ?? parseDate(fr.landed_at),
      answers,
      fields,
      warnings,
    };
  }

  /**
   * The answer's value lives under a key named after its type (`text`,
   * `email`, `choice`, …). Choice answers carry labels, which are the text we
   * want; everything else is a scalar or an object we keep readable.
   */
  private resolveValue(raw: z.infer<typeof answerSchema>): {
    textValues: string[];
    optionIds?: string[];
    value: unknown;
  } {
    if (raw.type === 'choice') {
      const c = raw.choice;
      const text = c?.label ?? c?.other ?? null;
      const id = c?.id ?? c?.ref ?? null;
      return { textValues: text ? [text] : [], ...(id ? { optionIds: [id] } : {}), value: c ?? null };
    }

    if (raw.type === 'choices') {
      const c = raw.choices;
      const textValues = [...(c?.labels ?? []), ...(c?.other ? [c.other] : [])];
      const ids = c?.ids ?? c?.refs ?? [];
      return { textValues, ...(ids.length ? { optionIds: ids } : {}), value: c ?? null };
    }

    const value = (raw as Record<string, unknown>)[raw.type];
    if (value === null || value === undefined || value === '') return { textValues: [], value: null };
    if (typeof value === 'boolean') return { textValues: [value ? 'true' : 'false'], value };
    if (Array.isArray(value)) {
      return { textValues: value.filter((v) => v !== null && v !== undefined).map((v) => String(v)), value };
    }
    // payment, file_url objects and friends: a readable scalar, the full object in `raw`.
    if (typeof value === 'object') return { textValues: [JSON.stringify(value)], value };
    return { textValues: [String(value)], value };
  }
}
