/**
 * Mapping a form from its SCHEMA, before anyone has submitted it.
 *
 * The existing pipeline learns a mapping from the first real delivery. That
 * leaves a newly connected source useless until someone remembers to submit a
 * test response — and the most valuable fields (timeline, financing) are
 * dropdowns whose option-to-enum map cannot be built from a single answer
 * anyway, because one submission only reveals the option that was picked.
 *
 * Reading the form definition solves both at once.
 *
 * `suggestMappings` is reused UNCHANGED. It reads exactly five members of
 * NormalizedAnswer — key, label, type, scalarText (only in shapeBonus) and
 * allOptions (only in autoEnumMap). With scalarText '' the shape bonus
 * short-circuits on its first line and nothing else touches values, so a
 * question-only synthesis scores through it as-is. The only loss is that
 * bonus, which matters only where the field type is already generic.
 */

import { sha256Hex } from '../../common/crypto';
import type { NormalizedAnswer } from '../ingest/adapters/types';
import { suggestMappings } from '../processing/heuristics';
import type { DescribedField } from '../providers/tally/tally-form-schema';

/**
 * Canonical targets we refuse to auto-map from a schema, however confident.
 *
 * Consent is a compliance field: getting it wrong means texting somebody who
 * never agreed, and unlike every other field that error is not visible until a
 * complaint arrives. It is also the field a schema describes worst — on a real
 * Tally form the consent checkbox has a NULL title, so the only thing a
 * heuristic could match on is absent. A human confirms this one.
 */
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
  /** Every question we catalogued, mapped or not. */
  fields: number;
  mappings: PrebuiltMapping[];
  /** Questions with no canonical home — kept as extras when they arrive. */
  unmapped: number;
  /** Targets deliberately left for a human. */
  withheld: string[];
}

/**
 * The described form as the mapping engine wants to see it.
 *
 * `scalarText: ''` is load-bearing, not laziness — see the module comment.
 */
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

  // A boolean opt-in is the consent shape. Even unmapped, it is worth naming in
  // the result so the UI can say "one field needs you" instead of staying silent.
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

/**
 * Fingerprint of the form's shape, for detecting later edits.
 *
 * Keyed on normalized label + type rather than field key: a key change with
 * identical labels is a provider implementation detail, while a label change is
 * a real edit by the customer that may invalidate a mapping.
 */
export function schemaFingerprint(fields: DescribedField[]): string {
  const parts = fields
    .map((f) => `${f.label.toLowerCase().replace(/\s+/g, ' ').trim()}:${f.type}`)
    .sort();
  // Hashed, not joined: `schema_fingerprint` is VARCHAR(64), and a form with a
  // dozen questions overflows it in plain text.
  return sha256Hex(parts.join('|'));
}
