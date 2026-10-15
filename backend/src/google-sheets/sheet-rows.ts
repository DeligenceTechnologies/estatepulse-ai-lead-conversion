import { createHash } from 'node:crypto';
import { CANONICAL_FIELDS } from '@/ingest/processing/canonical-fields';
import { suggestMappings } from '@/ingest/processing/heuristics';
import { applyTransform, isValidEmail, type Transform } from '@/ingest/processing/transforms';
import { validateCanonicalValues, type CanonicalValue } from '@/ingest/processing/validators';

export const MAX_DATA_ROWS = 10_000;

export const MAX_COLUMNS = 200;

export const CUSTOM_TARGET = '__custom__';

export const FULL_NAME_TARGET = 'full_name';

export const SHEET_TARGETS = [
  'first_name',
  'last_name',
  'phone',
  'email',
  'location',
  'min_budget',
  'max_budget',
  'bedrooms',
  'motivation',
] as const;
export type SheetTarget = (typeof SHEET_TARGETS)[number];
export const MAPPING_TARGETS = [...SHEET_TARGETS, FULL_NAME_TARGET, CUSTOM_TARGET] as const;
export type MappingTarget = (typeof MAPPING_TARGETS)[number];

export type RowIssue = 'NO_ROW_ID' | 'NO_NAME' | 'NO_CONTACT' | 'DUPLICATE_IN_SHEET' | 'DUPLICATE_IN_FILE';

export const IMPORT_REVIEW_REASON = 'Imported from Google Sheets — awaiting owner approval';
export const FILE_IMPORT_REVIEW_REASON = 'Imported from a file — awaiting owner approval';

export const PHONE_UNPARSED_REASON = 'Phone number could not be parsed — this lead must not be auto-dialled';

export interface SheetHeader {
  index: number;
  label: string;
  fieldKey: string;
  duplicate: boolean;
}

export interface ColumnMapping {
  fieldKey: string;
  target: MappingTarget;
}

export interface StoredMapping {
  source_field_key: string;
  target_field: string;
  transform: Transform;
}

export type Identity = { mode: 'column'; fieldKey: string } | { mode: 'fallback' };

export interface LeadFields {
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  normalized_email: string | null;
  email_valid: boolean;
  phone: string | null;
  normalized_phone: string | null;
  phone_valid: boolean;
  location: string | null;
  min_budget: number | null;
  max_budget: number | null;
  bedrooms: number | null;
  motivation: string | null;
  custom_fields: Record<string, string>;
}

export interface BuiltRow {
  rowNumber: number;
  blank: boolean;
  issue?: RowIssue;
  key?: string;
  hash?: string;
  lead?: LeadFields;
  externalId?: string;
  reviewReasons: string[];
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export function headerKey(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 200);
}

export function analyzeHeaders(cells: string[]): SheetHeader[] {
  const headers = cells.slice(0, MAX_COLUMNS).map((raw, index) => {
    const label = (raw ?? '').trim();
    return { index, label, fieldKey: label ? headerKey(label) : '', duplicate: false };
  });
  const counts = new Map<string, number>();
  for (const h of headers) if (h.fieldKey) counts.set(h.fieldKey, (counts.get(h.fieldKey) ?? 0) + 1);
  for (const h of headers) h.duplicate = Boolean(h.fieldKey) && (counts.get(h.fieldKey) ?? 0) > 1;
  return headers;
}

export function headerFingerprint(headers: SheetHeader[]): string {
  return sha256(
    headers
      .map((h) => h.fieldKey)
      .filter(Boolean)
      .sort()
      .join('\n'),
  );
}

export function transformFor(target: SheetTarget | typeof CUSTOM_TARGET, region: string, fromFullName: boolean): Transform {
  switch (target) {
    case 'first_name':
      return fromFullName ? { kind: 'name_split', part: 'first' } : { kind: 'text', maxLen: 100 };
    case 'last_name':
      return fromFullName ? { kind: 'name_split', part: 'last' } : { kind: 'text', maxLen: 100 };
    case 'phone':
      return { kind: 'phone_e164', defaultRegion: region };
    case 'email':
      return { kind: 'email' };
    case 'min_budget':
      return { kind: 'currency_range', part: 'min' };
    case 'max_budget':
      return { kind: 'currency_range', part: 'max' };
    case 'bedrooms':
      return { kind: 'number' };
    case 'location':
      return { kind: 'text', maxLen: 255 };
    case CUSTOM_TARGET:
      return { kind: 'text', maxLen: 500 };
    default:
      return { kind: 'text' };
  }
}

export function expandMapping(columns: ColumnMapping[], region: string): StoredMapping[] {
  const out: StoredMapping[] = [];
  for (const c of columns) {
    if (c.target === FULL_NAME_TARGET) {
      out.push({ source_field_key: c.fieldKey, target_field: 'first_name', transform: transformFor('first_name', region, true) });
      out.push({ source_field_key: c.fieldKey, target_field: 'last_name', transform: transformFor('last_name', region, true) });
    } else {
      out.push({ source_field_key: c.fieldKey, target_field: c.target, transform: transformFor(c.target, region, false) });
    }
  }
  return out;
}

export function validateMapping(
  columns: ColumnMapping[],
  identity: Identity,
  headers: SheetHeader[],
): { path: string; message: string }[] {
  const errors: { path: string; message: string }[] = [];
  const byKey = new Map(headers.filter((h) => h.fieldKey).map((h) => [h.fieldKey, h]));

  const checkColumn = (fieldKey: string, path: string) => {
    const h = byKey.get(fieldKey);
    if (!h) errors.push({ path, message: `Column "${fieldKey}" is not in the sheet's header row` });
    else if (h.duplicate) {
      errors.push({ path, message: `Column "${h.label}" appears more than once in the header row; rename one so it is unambiguous` });
    }
  };

  const claimed = new Map<string, number>();
  const pairs = new Set<string>();
  columns.forEach((c, i) => {
    checkColumn(c.fieldKey, `columns.${i}.fieldKey`);
    const pair = `${c.fieldKey}\u0000${c.target}`;
    if (pairs.has(pair)) errors.push({ path: `columns.${i}`, message: 'The same column is mapped to the same field twice' });
    pairs.add(pair);
    if (!(MAPPING_TARGETS as readonly string[]).includes(c.target)) {
      errors.push({ path: `columns.${i}.target`, message: `"${c.target}" is not a field a sheet column can fill` });
      return;
    }
    if (c.target === CUSTOM_TARGET) return;
    const targets = c.target === FULL_NAME_TARGET ? ['first_name', 'last_name'] : [c.target];
    for (const t of targets) {
      if (claimed.has(t)) {
        errors.push({ path: `columns.${i}.target`, message: `${CANONICAL_FIELDS[t]?.label ?? t} is already filled from another column` });
      }
      claimed.set(t, i);
    }
  });

  if (!claimed.has('first_name')) errors.push({ path: 'columns', message: 'Map a column to the lead’s name (first name or full name)' });
  if (!claimed.has('phone') && !claimed.has('email')) {
    errors.push({ path: 'columns', message: 'Map at least one contact column: phone or email' });
  }
  if (identity.mode === 'column') checkColumn(identity.fieldKey, 'identity.fieldKey');
  return errors;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`)
    .join(',')}}`;
}

const str = (v: CanonicalValue | undefined): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: CanonicalValue | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function buildRow(
  cells: string[],
  rowNumber: number,
  ctx: {
    headerIndex: Map<string, number>;
    labels: Map<string, string>;
    mappings: StoredMapping[];
    identity: Identity;
    region: string;
  },
): BuiltRow {
  const cell = (fieldKey: string): string => {
    const i = ctx.headerIndex.get(fieldKey);
    return i === undefined ? '' : (cells[i] ?? '').trim();
  };

  const relevant = new Set(ctx.mappings.map((m) => m.source_field_key));
  if (ctx.identity.mode === 'column') relevant.add(ctx.identity.fieldKey);
  if ([...relevant].every((k) => !cell(k))) return { rowNumber, blank: true, reviewReasons: [] };

  const values: Record<string, CanonicalValue> = {};
  const custom: Record<string, string> = {};
  const warnings: string[] = [];

  for (const m of ctx.mappings) {
    const raw = cell(m.source_field_key);
    if (!raw) continue;
    const label = ctx.labels.get(m.source_field_key) ?? m.source_field_key;
    if (m.target_field === CUSTOM_TARGET) {
      custom[label] = raw.slice(0, 500);
      continue;
    }
    const { value, warning } = applyTransform(m.transform, [raw], raw, ctx.region);
    if (value !== null && value !== '') values[m.target_field] = value;
    if (warning) warnings.push(`${label}: ${warning}`);
  }

  const validated = validateCanonicalValues(values);
  for (const r of validated.rejected) {
    if (r.raw) custom[`${CANONICAL_FIELDS[r.field]?.label ?? r.field} (unvalidated)`] = r.raw.slice(0, 500);
  }
  warnings.push(...validated.warnings);
  const v = validated.values;

  const phone = str(v.phone);
  const normalizedPhone = phone && phone.startsWith('+') ? phone : null;
  const email = str(v.email);
  const emailValid = email ? isValidEmail(email) : false;
  const normalizedEmail = emailValid ? email!.toLowerCase() : null;
  const firstName = str(v.first_name);
  const lastName = str(v.last_name);

  let externalId: string | undefined;
  let idKey: string | undefined;
  if (ctx.identity.mode === 'column') {
    externalId = cell(ctx.identity.fieldKey);
    if (!externalId) return { rowNumber, blank: false, issue: 'NO_ROW_ID', reviewReasons: [] };
    idKey = sha256(`id\u0000${externalId}`);
  }

  if (!firstName) return { rowNumber, blank: false, issue: 'NO_NAME', key: idKey, reviewReasons: [] };
  if (!normalizedPhone && !emailValid) return { rowNumber, blank: false, issue: 'NO_CONTACT', key: idKey, reviewReasons: [] };

  const nameKey = `${firstName} ${lastName ?? ''}`.trim().replace(/\s+/g, ' ').toLowerCase();
  const key = idKey ?? sha256(`fb\u0000${normalizedPhone ?? ''}\u0000${normalizedEmail ?? ''}\u0000${nameKey}`);

  const lead: LeadFields = {
    first_name: firstName,
    last_name: lastName,
    email,
    normalized_email: normalizedEmail,
    email_valid: emailValid,
    phone,
    normalized_phone: normalizedPhone,
    phone_valid: Boolean(normalizedPhone),
    location: str(v.location),
    min_budget: num(v.min_budget),
    max_budget: num(v.max_budget),
    bedrooms: num(v.bedrooms),
    motivation: str(v.motivation),
    custom_fields: custom,
  };

  const reviewReasons = [...warnings];
  if (phone && !normalizedPhone) reviewReasons.push(PHONE_UNPARSED_REASON);

  return {
    rowNumber,
    blank: false,
    key,
    hash: sha256(stable({ values: v, custom })),
    lead,
    externalId,
    reviewReasons,
  };
}

export function suggestColumns(headers: SheetHeader[], sampleRows: string[][], region: string): ColumnMapping[] {
  const usable = headers.filter((h) => h.fieldKey && !h.duplicate);
  const answers = usable.map((h) => {
    const sample = sampleRows.map((r) => (r[h.index] ?? '').trim()).find(Boolean) ?? '';
    return { key: h.fieldKey, label: h.label, type: 'INPUT_TEXT', raw: sample, textValues: sample ? [sample] : [], scalarText: sample };
  });
  const suggestions = suggestMappings(answers, region).filter((s) => (SHEET_TARGETS as readonly string[]).includes(s.targetField));

  const out: ColumnMapping[] = [];
  for (const s of suggestions) {
    const splitFirst = s.targetField === 'first_name' && s.transform.kind === 'name_split';
    const splitLast = s.targetField === 'last_name' && s.transform.kind === 'name_split';
    if (splitLast) continue;
    out.push({ fieldKey: s.sourceFieldKey, target: splitFirst ? FULL_NAME_TARGET : (s.targetField as SheetTarget) });
  }
  return out;
}

export function identityCandidates(headers: SheetHeader[], sampleRows: string[][]): string[] {
  const named: string[] = [];
  const unique: string[] = [];
  for (const h of headers) {
    if (!h.fieldKey || h.duplicate) continue;
    const values = sampleRows.map((r) => (r[h.index] ?? '').trim());

    if (values.some((x) => x.includes('@') || /^\+?[\d()\-.\s]{7,}$/.test(x))) continue;
    const allUnique = values.length > 0 && values.every(Boolean) && new Set(values).size === values.length;

    const codeLike = values.every((x) => /^\S+$/.test(x) && /\d/.test(x));
    if (/\b(id|lead id|uid|uuid|ref|reference|record)\b/.test(h.fieldKey) && values.every(Boolean)) named.push(h.fieldKey);
    else if (allUnique && codeLike) unique.push(h.fieldKey);
  }
  return [...named, ...unique];
}
