/**
 * Tally's form definition -> the provider-agnostic field shape.
 *
 * This is what makes it possible to map a customer's form BEFORE anyone submits
 * it. Everything here was verified against a real Tally account rather than
 * inferred from the docs, because two of the three things the docs implied
 * turned out to be wrong.
 *
 * Findings this module encodes:
 *
 *  1. The webhook payload's `fields[].key` is `question_` + the question `id`
 *     from GET /forms/{id}/questions — a 6-char base62 string ("YzPeeJ"), the
 *     same shape as Tally's documented `question_mVGEg3`. A choice option
 *     appends the option's uuid: `question_<id>_<optionUuid>`.
 *
 *  2. The questions endpoint reports `type` in the SAME vocabulary the webhook
 *     payload uses (MULTIPLE_CHOICE, CHECKBOXES, INPUT_PHONE_NUMBER) — NOT the
 *     `*_OPTION` BlockTypes the API reference lists. Those describe blocks, not
 *     questions. So no type translation is needed; `suggestMappings` and
 *     `CANONICAL_FIELDS.providerTypes` score this output directly.
 *
 *  3. Options are NOT in the questions response, and GET /forms/{id}/blocks
 *     returns 401 for an ordinary API key. They come from GET /forms/{id},
 *     which embeds `blocks[]`, and are joined to their question by
 *     `block.groupUuid === question.fields[].blockGroupUuid`.
 *
 *  4. A question's `title` can be null — a standalone consent checkbox has no
 *     title at all, its wording living in a separate TEXT block. Any code that
 *     reads a title must tolerate that.
 */

import type { NormalizedField, NormalizedOption } from '../../ingest/adapters/types';

/** GET /forms/{formId}/questions */
export interface TallyQuestion {
  id: string;
  type: string;
  title: string | null;
  isDeleted?: boolean;
  fields?: { uuid: string; blockGroupUuid?: string | null }[];
}

/** One entry of `blocks[]` on GET /forms/{formId} */
export interface TallyBlock {
  type: string;
  groupType?: string | null;
  uuid: string;
  groupUuid: string;
  payload?: { text?: string | null; index?: number; isOtherOption?: boolean } | null;
}

/**
 * The key this question's answers will arrive under.
 *
 * Deriving it rather than waiting to observe it is the entire reason a form can
 * be mapped before its first submission.
 */
export function webhookFieldKey(questionId: string): string {
  return `question_${questionId}`;
}

/** The key a single selected option arrives under, for providers that split them out. */
export function webhookOptionKey(questionId: string, optionUuid: string): string {
  return `question_${questionId}_${optionUuid}`;
}

/**
 * Blocks that represent a selectable answer.
 *
 * Matched on the type suffix rather than an exhaustive list so a block type
 * Tally adds later (…_OPTION) is picked up instead of silently dropped. The
 * groupUuid join below is what keeps a stray match from attaching to a question
 * it does not belong to.
 */
function isOptionBlock(b: TallyBlock): boolean {
  const t = b.type ?? '';
  return t.endsWith('_OPTION') || t === 'CHECKBOX' || t === 'MATRIX_ROW' || t === 'MATRIX_COLUMN';
}

/**
 * Group option blocks by the question they belong to.
 *
 * Options with no text are dropped: a standalone consent checkbox is one
 * CHECKBOX block whose payload carries no label (the wording lives in a
 * neighbouring TEXT block), and an untitled entry would only pollute the
 * option-text -> enum map it is meant to build.
 */
function optionsByGroup(blocks: TallyBlock[]): Map<string, NormalizedOption[]> {
  const out = new Map<string, NormalizedOption[]>();

  for (const b of blocks) {
    if (!isOptionBlock(b) || !b.groupUuid) continue;
    const text = b.payload?.text?.trim();
    if (!text) continue;

    const list = out.get(b.groupUuid) ?? [];
    list.push({ id: b.uuid, text });
    out.set(b.groupUuid, list);
  }

  // Preserve the author's ordering — an "Other" option last, a scale ascending.
  // The map is built from a single pass, so `index` is the only reliable order.
  for (const [group, list] of out) {
    const order = new Map(
      blocks.filter((b) => b.groupUuid === group).map((b) => [b.uuid, b.payload?.index ?? 0]),
    );
    list.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }

  return out;
}

/**
 * A `CHECKBOXES` question with at most one option is a yes/no opt-in, not a
 * multi-select.
 *
 * This matters because the consent checkbox is exactly that shape AND has a
 * null title, so it cannot be recognised by label at all. Structure is the only
 * signal available.
 */
export function isBooleanCheckbox(question: TallyQuestion, options: NormalizedOption[]): boolean {
  return question.type === 'CHECKBOXES' && options.length <= 1;
}

export interface DescribedField extends NormalizedField {
  /** Tally's question id, retained so the webhook key can be re-derived. */
  externalQuestionId: string;
  /** True for a single-checkbox opt-in; see isBooleanCheckbox. */
  booleanOptIn: boolean;
}

/**
 * Turn the two Tally responses into the shape the mapping engine already
 * understands. The result feeds `suggestMappings` unchanged.
 */
export function describeTallyForm(
  questions: TallyQuestion[],
  blocks: TallyBlock[],
): DescribedField[] {
  const optionMap = optionsByGroup(blocks ?? []);

  return (questions ?? [])
    .filter((q) => !q.isDeleted && q.id && q.type)
    .map((q) => {
      // A question's own block-group uuid is what its option blocks point at.
      const groupUuid = q.fields?.find((f) => f.blockGroupUuid)?.blockGroupUuid ?? q.fields?.[0]?.uuid;
      const options = (groupUuid ? optionMap.get(groupUuid) : undefined) ?? [];

      return {
        key: webhookFieldKey(q.id),
        // Falls back to the type so a null-titled question still has a handle in
        // the mapping UI. It will not match a synonym, which is correct: we must
        // not guess what an unlabelled question means.
        label: q.title?.trim() || `Untitled ${q.type.toLowerCase().replace(/_/g, ' ')}`,
        type: q.type,
        ...(options.length > 0 ? { options } : {}),
        externalQuestionId: q.id,
        booleanOptIn: isBooleanCheckbox(q, options),
      };
    });
}
