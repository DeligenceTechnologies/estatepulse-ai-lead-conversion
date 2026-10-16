import { CUSTOM_TARGET, FULL_NAME_TARGET, transformFor } from '../google-sheets/sheet-rows';
import type { NormalizedAnswer } from '../ingest/adapters/types';
import { CANONICAL_FIELDS } from '../processing/canonical-fields';
import { suggestMappings } from '../processing/heuristics';
import type { Transform } from '../processing/transforms';
import { MAX_PATH_CHARS } from './constants';
import { isValidPath, parsePath, type Leaf } from './flatten';

/**
 * The mapping an owner saves for a custom webhook: JSON path -> lead field.
 *
 * Stored in lead_source_field_mappings exactly as the form and sheet pipelines
 * store theirs (source_field_key = the path, target_field, transform JSON), so
 * the worker applies it with the same code. A full name and a budget range
 * expand into two rows each; a custom field keeps the owner's name for it in
 * transform.label, as a sheet mapping does.
 */

/** What a path may feed. Fixed-vocabulary fields (timeline, financing, intent) are not here: free text cannot be trusted to match them. */
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
  CUSTOM_TARGET,
] as const;
export type CustomTarget = (typeof CUSTOM_TARGETS)[number];

export const BUDGET_RANGE_TARGET = 'budget_range';

export interface MappingField {
  path: string;
  target: CustomTarget;
  /** The custom field's name; required when target is __custom__. */
  customName?: string;
}

/** A lead_source_field_mappings row, as stored for a custom source. */
export interface StoredMapping {
  source_field_key: string;
  target_field: string;
  transform: Transform & { label?: string };
}

export const MAX_CUSTOM_NAME = 60;

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
    } else {
      out.push({ source_field_key: f.path, target_field: f.target, transform: transformForTarget(f.target, region, false) });
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
 * A first guess at the mapping from a sample payload, through the same
 * heuristics that map a form's questions. Only a prefill: nothing here is
 * applied until the owner saves it, and the fixed-vocabulary targets the
 * heuristics know (timeline, intent, financing) are left out, as they are not
 * fields a webhook value may fill.
 */
export function suggestFields(leaves: Leaf[], region: string): MappingField[] {
  const answers: NormalizedAnswer[] = leaves
    .filter((l) => l.type !== 'object' && l.type !== 'empty')
    .map((l) => ({ key: l.path, label: labelOf(l.path), type: 'TEXT', raw: l.value, textValues: l.value ? [l.value] : [], scalarText: l.value }));
  const byPath = new Map<string, { target: string; split: boolean }[]>();
  for (const s of suggestMappings(answers, region)) {
    byPath.set(s.sourceFieldKey, [...(byPath.get(s.sourceFieldKey) ?? []), { target: s.targetField, split: s.transform.kind === 'name_split' }]);
  }
  const out: MappingField[] = [];
  for (const [path, list] of byPath) {
    const targets = new Set(list.map((t) => t.target));
    if (targets.has('first_name') && targets.has('last_name') && list.some((t) => t.target === 'first_name' && t.split)) {
      out.push({ path, target: 'full_name' });
      targets.delete('first_name');
      targets.delete('last_name');
    }
    if (targets.has('min_budget') && targets.has('max_budget')) {
      out.push({ path, target: BUDGET_RANGE_TARGET });
      targets.delete('min_budget');
      targets.delete('max_budget');
    }
    for (const t of targets) {
      if ((CUSTOM_TARGETS as readonly string[]).includes(t) && t !== CUSTOM_TARGET) out.push({ path, target: t as CustomTarget });
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
      else if ((CUSTOM_TARGETS as readonly string[]).includes(r.target_field)) out.push({ path, target: r.target_field as CustomTarget });
    }
  }
  return out;
}
