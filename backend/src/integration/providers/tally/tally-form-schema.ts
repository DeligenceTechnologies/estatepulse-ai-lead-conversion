import type { NormalizedField, NormalizedOption } from '@/ingest/adapters/types';

export interface TallyQuestion {
  id: string;
  type: string;
  title: string | null;
  isDeleted?: boolean;
  fields?: { uuid: string; blockGroupUuid?: string | null }[];
}

export interface TallyBlock {
  type: string;
  groupType?: string | null;
  uuid: string;
  groupUuid: string;
  payload?: { text?: string | null; index?: number; isOtherOption?: boolean } | null;
}

export function webhookFieldKey(questionId: string): string {
  return `question_${questionId}`;
}

function isOptionBlock(b: TallyBlock): boolean {
  const t = b.type ?? '';
  return t.endsWith('_OPTION') || t === 'CHECKBOX' || t === 'MATRIX_ROW' || t === 'MATRIX_COLUMN';
}

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

  for (const [group, list] of out) {
    const order = new Map(
      blocks.filter((b) => b.groupUuid === group).map((b) => [b.uuid, b.payload?.index ?? 0]),
    );
    list.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }

  return out;
}

export function isBooleanCheckbox(question: TallyQuestion, options: NormalizedOption[]): boolean {
  return question.type === 'CHECKBOXES' && options.length <= 1;
}

export interface DescribedField extends NormalizedField {
  externalQuestionId: string;
  booleanOptIn: boolean;
}

export function describeTallyForm(
  questions: TallyQuestion[],
  blocks: TallyBlock[],
): DescribedField[] {
  const optionMap = optionsByGroup(blocks ?? []);

  return (questions ?? [])
    .filter((q) => !q.isDeleted && q.id && q.type)
    .map((q) => {
      const groupUuid = q.fields?.find((f) => f.blockGroupUuid)?.blockGroupUuid ?? q.fields?.[0]?.uuid;
      const options = (groupUuid ? optionMap.get(groupUuid) : undefined) ?? [];

      return {
        key: webhookFieldKey(q.id),
        label: q.title?.trim() || `Untitled ${q.type.toLowerCase().replace(/_/g, ' ')}`,
        type: q.type,
        ...(options.length > 0 ? { options } : {}),
        externalQuestionId: q.id,
        booleanOptIn: isBooleanCheckbox(q, options),
      };
    });
}
