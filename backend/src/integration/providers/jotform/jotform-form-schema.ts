/**
 * Jotform's questions, described in the same keys a webhook delivery uses.
 *
 * A submission's `rawRequest` names each answer `q{qid}_{name}`, for example
 * `q3_fullName` or `q4_email`. The fields described here use exactly those
 * keys, so a mapping built from the form before any submission arrives
 * (prebuild-mapping.ts) matches the deliveries that follow.
 *
 * A full-name question answers with an object of parts. It is described as
 * two fields, `….first` and `….last`, because first and last name map to two
 * different lead columns. The webhook adapter splits the answer the same way.
 */

import type { NormalizedOption } from '@/ingest/adapters/types';
import type { DescribedField } from '../tally/tally-form-schema';

export interface JotformQuestion {
  qid?: string;
  name?: string;
  text?: string;
  type?: string;
  order?: string;
  options?: string;
  /** Present on some controls; "Yes" on a hidden field. */
  hidden?: string;
}

/** Controls that lay out the form and never carry an answer. */
const LAYOUT_CONTROLS = new Set([
  'control_head',
  'control_button',
  'control_text',
  'control_divider',
  'control_image',
  'control_pagebreak',
  'control_collapse',
  'control_captcha',
  'control_widget_spacer',
]);

export const CHOICE_CONTROLS = new Set(['control_dropdown', 'control_radio', 'control_checkbox']);

export function jotformAnswerKey(qid: string, name: string): string {
  return `q${qid}_${name}`;
}

/** The sub-keys a full-name answer is split into, with the label each gets. */
export const FULLNAME_PARTS = [
  { part: 'first', label: 'First name' },
  { part: 'last', label: 'Last name' },
] as const;

function fullNamePartLabel(questionText: string, partLabel: string): string {
  // "Name" or "Full name" adds nothing; "Co-buyer name" does.
  return /^(full\s*)?name$/i.test(questionText.trim()) || !questionText.trim()
    ? partLabel
    : `${questionText.trim()} (${partLabel.toLowerCase()})`;
}

function parseOptions(raw: string | undefined): NormalizedOption[] {
  return (raw ?? '')
    .split('|')
    .map((o) => o.trim())
    .filter(Boolean)
    // A Jotform answer carries the option's text, not an id, so the text is the id.
    .map((text) => ({ id: text, text }));
}

/** `GET /form/{id}/questions` returns an object keyed by qid. */
export function describeJotformForm(questions: Record<string, JotformQuestion> | JotformQuestion[] | null | undefined): DescribedField[] {
  const list = Array.isArray(questions) ? questions : Object.values(questions ?? {});
  const out: DescribedField[] = [];

  const ordered = list
    .filter((q) => q.qid && q.name && q.type && !LAYOUT_CONTROLS.has(q.type))
    .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));

  for (const q of ordered) {
    const qid = q.qid!;
    const type = q.type!;
    const key = jotformAnswerKey(qid, q.name!);
    const text = (q.text ?? '').replace(/<[^>]*>/g, '').trim();

    if (type === 'control_fullname') {
      for (const { part, label } of FULLNAME_PARTS) {
        out.push({
          key: `${key}.${part}`,
          label: fullNamePartLabel(text, label),
          type,
          externalQuestionId: qid,
          booleanOptIn: false,
        });
      }
      continue;
    }

    const options = CHOICE_CONTROLS.has(type) ? parseOptions(q.options) : [];
    out.push({
      key,
      label: text || `Untitled ${type.replace(/^control_/, '').replace(/_/g, ' ')}`,
      type,
      ...(options.length > 0 ? { options } : {}),
      externalQuestionId: qid,
      // A single checkbox ("I agree to be contacted") is a yes/no opt-in.
      booleanOptIn: type === 'control_checkbox' && options.length <= 1,
    });
  }

  return out;
}
