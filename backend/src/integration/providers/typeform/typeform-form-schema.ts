/**
 * Typeform's form definition -> the provider-agnostic field shape.
 *
 * Typeform is kinder than Tally here: one call (`GET /forms/{id}`) carries the
 * fields AND their choices, and the webhook payload repeats the same
 * `definition.fields[]`, so this module serves both the connect-time describe
 * and the ingest adapter.
 *
 * Keys are the field `id`, which Typeform assigns and never changes. `ref` is
 * also stable by default but is editable through the API, and a mapping keyed
 * on something the customer can rename is a mapping that silently breaks.
 */

import type { NormalizedOption } from '@/ingest/adapters/types';
import type { DescribedField } from '../tally/tally-form-schema';

/** One entry of `fields[]` on GET /forms/{id}, and of `definition.fields[]` in a webhook. */
export interface TypeformField {
  id: string;
  ref?: string | null;
  title?: string | null;
  type: string;
  properties?: {
    choices?: { id?: string | null; ref?: string | null; label?: string | null }[] | null;
    /** A `group` nests its questions here. */
    fields?: TypeformField[] | null;
  } | null;
  /** The webhook's definition puts choices at the top level. */
  choices?: { id?: string | null; ref?: string | null; label?: string | null }[] | null;
}

/** Explicit consent shapes. `yes_no` is deliberately not one: "Are you pre-approved?" is also yes/no. */
const OPT_IN_TYPES = new Set(['opt_in', 'legal']);

/** Fields that never carry an answer. */
const NON_QUESTION_TYPES = new Set(['statement', 'group']);

/**
 * Groups contain the real questions; the group itself answers nothing. Flatten
 * so every question is addressable by its own id, which is also how the
 * webhook payload reports answers.
 */
export function flattenTypeformFields(fields: TypeformField[] | null | undefined): TypeformField[] {
  const out: TypeformField[] = [];
  for (const f of fields ?? []) {
    if (!f?.id || !f.type) continue;
    if (f.type === 'group') {
      out.push(...flattenTypeformFields(f.properties?.fields));
      continue;
    }
    out.push(f);
  }
  return out;
}

export function typeformOptions(f: TypeformField): NormalizedOption[] {
  const choices = f.properties?.choices ?? f.choices ?? [];
  return choices
    .filter((c) => c && (c.label ?? '').trim())
    .map((c) => ({ id: c.id ?? c.ref ?? c.label!, text: c.label!.trim() }));
}

export function describeTypeformForm(fields: TypeformField[] | null | undefined): DescribedField[] {
  return flattenTypeformFields(fields)
    .filter((f) => !NON_QUESTION_TYPES.has(f.type))
    .map((f) => {
      const options = typeformOptions(f);
      return {
        key: f.id,
        // Falls back to the type so an untitled question still has a handle in
        // the mapping UI. It will not match a synonym, which is correct.
        label: f.title?.trim() || `Untitled ${f.type.replace(/_/g, ' ')}`,
        type: f.type,
        ...(options.length > 0 ? { options } : {}),
        externalQuestionId: f.id,
        booleanOptIn: OPT_IN_TYPES.has(f.type),
      };
    });
}
