import { sha256Hex } from '@/common/utils/crypto';
import type { NormalizedAnswer } from '@/ingest/adapters/types';
import { suggestMappings } from '@/ingest/processing/heuristics';
import type { DescribedField } from '@/integration/providers/tally/tally-form-schema';

const NEVER_PREBUILT = new Set(['consent_status']);

export interface PrebuiltMapping {
  sourceFieldKey: string;
  sourceFieldLabel: string;
  sourceFieldType: string;
  targetField: string;
  transform: unknown;
  confidence: number;
}

export interface PrebuildResult {
  fields: number;
  mappings: PrebuiltMapping[];
  unmapped: number;
  withheld: string[];
}

export function toSyntheticAnswers(fields: DescribedField[]): NormalizedAnswer[] {
  return fields.map((f) => ({
    key: f.key,
    label: f.label,
    type: f.type,
    raw: null,
    textValues: [],
    scalarText: '',
    ...(f.options?.length ? { allOptions: f.options } : {}),
  }));
}

export function prebuildMappings(fields: DescribedField[], defaultRegion: string): PrebuildResult {
  const answers = toSyntheticAnswers(fields);
  const suggested = suggestMappings(answers, defaultRegion);

  const withheld: string[] = [];
  const mappings: PrebuiltMapping[] = [];

  for (const s of suggested) {
    if (NEVER_PREBUILT.has(s.targetField)) {
      withheld.push(s.targetField);
      continue;
    }
    mappings.push({
      sourceFieldKey: s.sourceFieldKey,
      sourceFieldLabel: s.sourceFieldLabel,
      sourceFieldType: s.sourceFieldType,
      targetField: s.targetField,
      transform: s.transform,
      confidence: s.confidence,
    });
  }

  for (const f of fields) {
    if (f.booleanOptIn && !withheld.includes('consent_status')) withheld.push('consent_status');
  }

  const mappedKeys = new Set(mappings.map((m) => m.sourceFieldKey));

  return {
    fields: fields.length,
    mappings,
    unmapped: fields.filter((f) => !mappedKeys.has(f.key)).length,
    withheld,
  };
}

export function schemaFingerprint(fields: DescribedField[]): string {
  const parts = fields
    .map((f) => `${f.label.toLowerCase().replace(/\s+/g, ' ').trim()}:${f.type}`)
    .sort();

  return sha256Hex(parts.join('|'));
}
