import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { CANONICAL_FIELDS } from '../processing/canonical-fields';
import { suggestMappings } from '../processing/heuristics';
import { applyTransform, isValidEmail, type Transform } from '../processing/transforms';
import { validateCanonicalValues, type CanonicalValue } from '../processing/validators';

/**
 * Pure spreadsheet logic: headers, mapping rules, and turning one row into lead
 * fields, an identity key and a content hash. No database, no Google — so every
 * rule here is testable on its own.
 *
 * Normalisation is the SAME code the form pipeline uses (applyTransform,
 * validateCanonicalValues, isValidEmail), so a phone or email reads identically
 * whichever way a lead arrived.
 */

/** The 10,000-row cap per tab. Larger sheets are refused, never half-imported. */
export const MAX_DATA_ROWS = 10_000;
/** Columns read from a header row. Far beyond any lead sheet; bounds the read. */
export const MAX_COLUMNS = 200;

/** Keep the cell's text in custom_fields under its header. */
export const CUSTOM_TARGET = '__custom__';
/** One "Name" column feeding first AND last name. Stored as two mappings. */
export const FULL_NAME_TARGET = 'full_name';

/**
 * Lead fields a sheet column may feed.
 *
 * Not here, deliberately: timeline / buying_intent / financing_status hold a
 * fixed vocabulary that free text cannot be trusted to match, and consent is a
 * compliance decision (deferred until launch). Map those columns to custom.
 * Status, temperature, score, DNC, assignment and the rest are never mappable.
 */
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
/** Every reason an import starts with; approval and rejection spend whichever one the lead carries. */
export const IMPORT_REVIEW_REASONS = [IMPORT_REVIEW_REASON, FILE_IMPORT_REVIEW_REASON] as const;

/** A file upload is a lead_source too: one per uploaded file, never synced again. */
export const FILE_UPLOAD_PROVIDER = 'FILE_UPLOAD';
export const UPLOAD_CONNECTION = 'UPLOAD';

/**
 * A `leads` filter: a lead imported from a sheet belongs to Import Review until
 * the owner approves it, so the lead lists leave out pending and rejected
 * imports. Leads from every other source have no import row and always pass.
 */
export const OUTSIDE_IMPORT_REVIEW = {
  sheet_import_rows: { none: { review_state: { in: ['pending', 'rejected'] } } },
} satisfies Prisma.leadsWhereInput;

export const PHONE_UNPARSED_REASON = 'Phone number could not be parsed — this lead must not be auto-dialled';

export interface SheetHeader {
  /** 0-based column index. */
  index: number;
  label: string;
  /** What a mapping keys on. Empty for a blank header cell, which cannot be mapped. */
  fieldKey: string;
  /** The same header appears more than once: ambiguous, so not mappable. */
  duplicate: boolean;
}

export interface ColumnMapping {
  fieldKey: string;
  target: MappingTarget;
}

/** A lead_source_field_mappings row as stored for a sheet source. */
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
  /** 1-based sheet row number; the header is row 1. Display only. */
  rowNumber: number;
  blank: boolean;
  issue?: RowIssue;
  key?: string;
  hash?: string;
  lead?: LeadFields;
  /** The unique-ID cell, kept as leads.external_lead_id. */
  externalId?: string;
  reviewReasons: string[];
  /**
   * Set on rows from a connected CRM (crm/crm-records.ts): the custom-field
   * prefix the CRM owns. A flagged change carries it, so applying the change
   * writes only the CRM's own fields and never nulls EstatePulse's — see
   * SheetReviewService.resolve. Absent for sheets and files.
   */
  crmPrefix?: string;
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Case- and spacing-insensitive, so "Email " and "email" are one column. */
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

/** Order-insensitive: moving a column is harmless, renaming one is not. */
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

/** API columns -> stored mapping rows. A full-name column becomes two. */
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

/**
 * Every rule a mapping must pass before it is saved. Field errors, not a single
 * message, so the UI can point at the column that is wrong.
 */
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

/** Stable JSON: keys sorted, so equal content always hashes equal. */
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

/**
 * One sheet row -> what to import, or why not.
 *
 * Identity is never the row number. With a unique-ID column it is that cell;
 * otherwise the acknowledged fallback: normalized phone, email and name, so an
 * edit to any of those reads as a new person (a new pending lead), never as a
 * silent overwrite of someone else.
 */
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

  // Same last gate as the form pipeline: a value a column cannot hold is kept,
  // readable, in custom_fields rather than dropped.
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
  // With an ID column the key is known even for a row we refuse, so a row that
  // is still in the sheet is never mistaken for one that was deleted.
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

/**
 * Mapping suggestions from the header row and a few sample values, using the
 * form pipeline's heuristics. Only targets a sheet may fill are offered, and a
 * name column split into first + last is offered as one "full name" choice.
 */
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

/**
 * Columns that look like a stable unique ID: an id-ish header first, then any
 * column whose sample values are all present and all different.
 */
export function identityCandidates(headers: SheetHeader[], sampleRows: string[][]): string[] {
  const named: string[] = [];
  const unique: string[] = [];
  for (const h of headers) {
    if (!h.fieldKey || h.duplicate) continue;
    const values = sampleRows.map((r) => (r[h.index] ?? '').trim());
    // A phone or email changes when the person does; it is not an identity.
    if (values.some((x) => x.includes('@') || /^\+?[\d()\-.\s]{7,}$/.test(x))) continue;
    const allUnique = values.length > 0 && values.every(Boolean) && new Set(values).size === values.length;
    // Code-shaped: one token with a digit, like "EP-1001". Free text ("Test lead 1")
    // or an amount ("$205,000 - $305,000") can be unique in a sample and still
    // be nothing anyone would key a record on.
    const codeLike = values.every((x) => /^\S+$/.test(x) && /\d/.test(x));
    if (/\b(id|lead id|uid|uuid|ref|reference|record)\b/.test(h.fieldKey) && values.every(Boolean)) named.push(h.fieldKey);
    else if (allUnique && codeLike) unique.push(h.fieldKey);
  }
  return [...named, ...unique];
}
