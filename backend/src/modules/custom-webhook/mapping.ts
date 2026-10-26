import { CUSTOM_TARGET, FULL_NAME_TARGET, transformFor } from '../google-sheets/sheet-rows';
import type { NormalizedAnswer } from '../ingest/adapters/types';
import { CANONICAL_FIELDS } from '../processing/canonical-fields';
import { suggestMappings, type Suggestion } from '../processing/heuristics';
import type { Transform } from '../processing/transforms';
import { MAX_PATH_CHARS } from './constants';
import { isValidPath, parsePath, type Leaf } from './flatten';

/**
 * The mapping an owner saves for a webhook: source field -> lead field.
 *
 * The source field is a JSON path for a plain payload, or a question key for a
 * form provider's payload (see detect.ts). Stored in lead_source_field_mappings
 * exactly as the form and sheet pipelines store theirs (source_field_key,
 * target_field, transform JSON), so the worker applies it with the same code.
 * A full name and a budget range expand into two rows each; a custom field
 * keeps the owner's name for it in transform.label, as a sheet mapping does.
 */

/** Fixed-vocabulary fields. Only a choice question with known options can fill one, through an option map. */
export const ENUM_TARGETS = ['timeline', 'buying_intent', 'financing_status'] as const;

export const CUSTOM_TARGETS = [
  'full_name',
  'first_name',
  'last_name',
  'phone',
  'email',
  'location',
  'budget_range',
  'min_budget',
  'max_budget',
  'bedrooms',
  'motivation',
  'consent_status',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  ...ENUM_TARGETS,
  CUSTOM_TARGET,
] as const;
export type CustomTarget = (typeof CUSTOM_TARGETS)[number];

export const BUDGET_RANGE_TARGET = 'budget_range';

/** The one transform an owner may send: the option-text map a choice question carries. */
export interface EnumMapTransform {
  kind: 'enum_map';
  byOptionText: Record<string, string>;
  fallback?: string | null;
}

export interface MappingField {
  path: string;
  target: CustomTarget;
  /** The custom field's name; required when target is __custom__. */
  customName?: string;
  /** Required for an ENUM_TARGETS target; refused on any other. */
  transform?: EnumMapTransform;
}

/** A lead_source_field_mappings row, as stored for a custom source. */
export interface StoredMapping {
  source_field_key: string;
  target_field: string;
  transform: Transform & { label?: string };
}

export const MAX_CUSTOM_NAME = 60;

const isEnumTarget = (t: string): t is (typeof ENUM_TARGETS)[number] => (ENUM_TARGETS as readonly string[]).includes(t);

/** Which lead columns a target claims; a custom field claims none. */
export function claimsOf(target: CustomTarget): string[] {
  if (target === FULL_NAME_TARGET) return ['first_name', 'last_name'];
  if (target === BUDGET_RANGE_TARGET) return ['min_budget', 'max_budget'];
  if (target === CUSTOM_TARGET) return [];
  return [target];
}

/**
 * Every rule a mapping must pass before it is saved. Field errors, not one
 * message, so the UI can point at the row that is wrong.
 */
export function validateFields(fields: MappingField[]): { path: string; message: string }[] {
  const errors: { path: string; message: string }[] = [];
  const claimed = new Map<string, number>();
  const customNames = new Map<string, number>();
  const pairs = new Set<string>();

  fields.forEach((f, i) => {
    const at = `fields.${i}`;
    if (f.path.length > MAX_PATH_CHARS) errors.push({ path: `${at}.path`, message: `Path is longer than ${MAX_PATH_CHARS} characters` });
    else if (!isValidPath(f.path)) errors.push({ path: `${at}.path`, message: `"${f.path}" is not a path we can read (use a.b, a[0].b or ["a key"])` });

    if (!(CUSTOM_TARGETS as readonly string[]).includes(f.target)) {
      errors.push({ path: `${at}.target`, message: `"${f.target}" is not a field a webhook value can fill` });
      return;
    }

    const pair = `${f.path}\u0000${f.target}\u0000${f.target === CUSTOM_TARGET ? (f.customName ?? '').toLowerCase() : ''}`;
    if (pairs.has(pair)) errors.push({ path: at, message: 'The same path is mapped to the same field twice' });
    pairs.add(pair);

    if (f.target === CUSTOM_TARGET) {
      const name = (f.customName ?? '').trim();
      if (!name) errors.push({ path: `${at}.customName`, message: 'Give the extra field a name' });
      else if (name.length > MAX_CUSTOM_NAME) errors.push({ path: `${at}.customName`, message: `Keep the name under ${MAX_CUSTOM_NAME} characters` });
      else if (customNames.has(name.toLowerCase())) errors.push({ path: `${at}.customName`, message: `Two paths are both named "${name}"` });
      else customNames.set(name.toLowerCase(), i);
      return;
    }
    if (f.customName) errors.push({ path: `${at}.customName`, message: 'Only an extra field takes a name' });

    if (isEnumTarget(f.target)) {
      const allowed = CANONICAL_FIELDS[f.target]?.enumValues ?? [];
      if (!f.transform) {
        errors.push({ path: `${at}.transform`, message: `${CANONICAL_FIELDS[f.target]?.label ?? f.target} needs an option map; only a form's choice question can fill it` });
      } else {
        const bad = Object.values(f.transform.byOptionText).find((v) => !allowed.includes(v));
        if (bad !== undefined) errors.push({ path: `${at}.transform`, message: `"${bad}" is not one of: ${allowed.join(', ')}` });
        if (f.transform.fallback && !allowed.includes(f.transform.fallback)) {
          errors.push({ path: `${at}.transform`, message: `Fallback "${f.transform.fallback}" is not one of: ${allowed.join(', ')}` });
        }
      }
    } else if (f.transform) {
      errors.push({ path: `${at}.transform`, message: 'Only a timeline, intent or financing field takes an option map' });
    }

    for (const column of claimsOf(f.target)) {
      if (claimed.has(column)) {
        errors.push({ path: `${at}.target`, message: `${CANONICAL_FIELDS[column]?.label ?? column} is already filled from another path` });
      }
      claimed.set(column, i);
    }
  });

  if (!claimed.has('phone') && !claimed.has('email')) {
    errors.push({ path: 'fields', message: 'Map at least one contact field: phone or email' });
  }
  return errors;
}

function transformForTarget(target: CustomTarget, region: string, fromFullName: boolean): Transform {
  switch (target) {
    case 'consent_status':
      return { kind: 'boolean' };
    case 'utm_source':
    case 'utm_medium':
    case 'utm_campaign':
      return { kind: 'text', maxLen: 255 };
    case 'motivation':
      return { kind: 'text' };
    case 'full_name':
    case 'budget_range':
      // Expanded by the caller; never stored as such.
      return { kind: 'text' };
    case CUSTOM_TARGET:
      return transformFor(CUSTOM_TARGET, region, false);
    case 'timeline':
    case 'buying_intent':
    case 'financing_status':
      // Only reachable with the owner's map, which expandFields uses instead.
      return { kind: 'enum_map', byOptionText: {}, fallback: null };
    default:
      return transformFor(target, region, fromFullName);
  }
}

/** Saved fields -> stored rows. */
export function expandFields(fields: MappingField[], region: string): StoredMapping[] {
  const out: StoredMapping[] = [];
  for (const f of fields) {
    if (f.target === FULL_NAME_TARGET) {
      out.push({ source_field_key: f.path, target_field: 'first_name', transform: transformFor('first_name', region, true) });
      out.push({ source_field_key: f.path, target_field: 'last_name', transform: transformFor('last_name', region, true) });
    } else if (f.target === BUDGET_RANGE_TARGET) {
      out.push({ source_field_key: f.path, target_field: 'min_budget', transform: { kind: 'currency_range', part: 'min' } });
      out.push({ source_field_key: f.path, target_field: 'max_budget', transform: { kind: 'currency_range', part: 'max' } });
    } else if (f.target === CUSTOM_TARGET) {
      out.push({
        source_field_key: f.path,
        target_field: CUSTOM_TARGET,
        transform: { ...transformForTarget(CUSTOM_TARGET, region, false), label: (f.customName ?? '').trim() },
      });
    } else if (isEnumTarget(f.target) && f.transform) {
      out.push({
        source_field_key: f.path,
        target_field: f.target,
        transform: { kind: 'enum_map', byOptionText: f.transform.byOptionText, fallback: f.transform.fallback ?? null },
      });
    } else {
      out.push({ source_field_key: f.path, target_field: f.target, transform: transformForTarget(f.target, region, false) });
    }
  }
  return out;
}

/** Stored rows -> the fields the UI edits (the inverse of expandFields). */
export function fieldsFromRows(rows: StoredMapping[]): MappingField[] {
  const byPath = new Map<string, StoredMapping[]>();
  for (const r of rows) byPath.set(r.source_field_key, [...(byPath.get(r.source_field_key) ?? []), r]);
  const out: MappingField[] = [];
  for (const [path, list] of byPath) {
    const targets = new Set(list.map((r) => r.target_field));
    const splitName = list.some((r) => r.target_field === 'first_name' && r.transform.kind === 'name_split');
    if (targets.has('first_name') && targets.has('last_name') && splitName) {
      out.push({ path, target: 'full_name' });
      targets.delete('first_name');
      targets.delete('last_name');
    }
    if (targets.has('min_budget') && targets.has('max_budget')) {
      out.push({ path, target: BUDGET_RANGE_TARGET });
      targets.delete('min_budget');
      targets.delete('max_budget');
    }
    for (const r of list) {
      if (!targets.has(r.target_field)) continue;
      if (r.target_field === CUSTOM_TARGET) out.push({ path, target: CUSTOM_TARGET, customName: r.transform.label ?? path });
      else if (isEnumTarget(r.target_field) && r.transform.kind === 'enum_map') {
        out.push({ path, target: r.target_field, transform: { kind: 'enum_map', byOptionText: r.transform.byOptionText, fallback: r.transform.fallback ?? null } });
      } else if ((CUSTOM_TARGETS as readonly string[]).includes(r.target_field)) out.push({ path, target: r.target_field as CustomTarget });
    }
  }
  return out;
}

/** The last named segment of a path, as words: "contact.phone_number" -> "phone number". */
function labelOf(path: string): string {
  let tokens: (string | number)[];
  try {
    tokens = parsePath(path);
  } catch {
    return path;
  }
  const named = tokens.filter((t): t is string => typeof t === 'string');
  return (named[named.length - 1] ?? path).replace(/[_\-.]+/g, ' ');
}

/**
 * Heuristic suggestions -> one field per source key. A name split into first
 * and last reads back as a full name, a budget feeding both ends as a range.
 * Fixed-vocabulary targets are kept only with their option map (a form's
 * choice question), never from free text.
 */
function fieldsFromSuggestions(suggestions: Suggestion[], allowEnums: boolean): MappingField[] {
  const byKey = new Map<string, Suggestion[]>();
  for (const s of suggestions) byKey.set(s.sourceFieldKey, [...(byKey.get(s.sourceFieldKey) ?? []), s]);
  const out: MappingField[] = [];
  for (const [path, list] of byKey) {
    const targets = new Map(list.map((s) => [s.targetField as string, s]));
    if (targets.has('first_name') && targets.has('last_name') && list.some((s) => s.targetField === 'first_name' && s.transform.kind === 'name_split')) {
      out.push({ path, target: 'full_name' });
      targets.delete('first_name');
      targets.delete('last_name');
    }
    if (targets.has('min_budget') && targets.has('max_budget')) {
      out.push({ path, target: BUDGET_RANGE_TARGET });
      targets.delete('min_budget');
      targets.delete('max_budget');
    }
    for (const [t, s] of targets) {
      if (isEnumTarget(t)) {
        if (allowEnums && s.transform.kind === 'enum_map' && Object.keys(s.transform.byOptionText).length > 0) {
          out.push({ path, target: t, transform: { kind: 'enum_map', byOptionText: s.transform.byOptionText, fallback: null } });
        }
        continue;
      }
      if ((CUSTOM_TARGETS as readonly string[]).includes(t) && t !== CUSTOM_TARGET) out.push({ path, target: t as CustomTarget });
    }
  }
  return out;
}

/** A first guess for a plain-JSON payload, from its paths and values. Only a prefill. */
export function suggestFields(leaves: Leaf[], region: string): MappingField[] {
  const answers: NormalizedAnswer[] = leaves
    .filter((l) => l.type !== 'object' && l.type !== 'empty')
    .map((l) => ({ key: l.path, label: labelOf(l.path), type: 'TEXT', raw: l.value, textValues: l.value ? [l.value] : [], scalarText: l.value }));
  return fieldsFromSuggestions(suggestMappings(answers, region), false);
}

/**
 * A first guess for a form provider's payload, from its questions — the same
 * heuristics the provider's own route applies, option maps included.
 */
export function suggestFromAnswers(answers: NormalizedAnswer[], region: string): MappingField[] {
  return fieldsFromSuggestions(suggestMappings(answers, region), true);
}
