import { createHash } from 'node:crypto';
import { CANONICAL_FIELDS } from '@/ingest/processing/canonical-fields';
import {
  CUSTOM_TARGET,
  FULL_NAME_TARGET,
  buildRow,
  type BuiltRow,
  type Identity,
  type MappingTarget,
  type StoredMapping,
} from '@/google-sheets/sheet-rows';
import type { AirtableField, AirtableRecord } from './types';

/**
 * Pure Airtable logic: what its field types mean, how a cell reads as text, and
 * how one record becomes the row the import engine writes. No database, no
 * HTTP.
 *
 * Normalisation is the SAME code the form, sheet and CRM pipelines use
 * (buildRow -> applyTransform -> validateCanonicalValues), so a phone or email
 * reads identically whichever way a lead arrived — which is what makes the
 * duplicate checks across sources meaningful.
 *
 * Field types verified against Airtable's field model on 2026-11-13.
 */

export const AIRTABLE_IMPORT_REVIEW_REASON = 'Imported from Airtable — awaiting owner approval';

/**
 * A record's identity is its record id, which is not one of its fields. It is
 * fed to buildRow as a synthetic column so the row keying, duplicate detection
 * and change tracking are the sheet engine's, unchanged. The key cannot collide
 * with a real Airtable field id (those start with `fld`).
 */
export const RECORD_ID_KEY = '__airtable_record_id__';
export const RECORD_IDENTITY: Identity = { mode: 'column', fieldKey: RECORD_ID_KEY };

// ---------------------------------------------------------------------------
// Field types
// ---------------------------------------------------------------------------

/**
 * How a field's value behaves, which is all the mapping needs to know. Airtable
 * has 40-odd types; they fall into a handful of shapes.
 */
export type ValueKind = 'text' | 'number' | 'boolean' | 'date' | 'list' | 'complex';

const KINDS: Record<string, ValueKind> = {
  singleLineText: 'text',
  multilineText: 'text',
  richText: 'text',
  email: 'text',
  url: 'text',
  phoneNumber: 'text',
  singleSelect: 'text',
  externalSyncSource: 'text',
  number: 'number',
  currency: 'number',
  percent: 'number',
  duration: 'number',
  rating: 'number',
  autoNumber: 'number',
  count: 'number',
  checkbox: 'boolean',
  date: 'date',
  dateTime: 'date',
  createdTime: 'date',
  lastModifiedTime: 'date',
  multipleSelects: 'list',
  multipleRecordLinks: 'list',
  multipleLookupValues: 'list',
  multipleCollaborators: 'list',
  multipleAttachments: 'complex',
  singleCollaborator: 'complex',
  createdBy: 'complex',
  lastModifiedBy: 'complex',
  barcode: 'complex',
  button: 'complex',
  aiText: 'complex',
  formula: 'complex',
  rollup: 'complex',
};

/**
 * Computed by Airtable: readable, never writable. Writing one is rejected by
 * Airtable, so the mapping refuses to send it rather than failing a whole batch.
 */
export const READ_ONLY_TYPES = new Set([
  'formula',
  'rollup',
  'count',
  'multipleLookupValues',
  'createdTime',
  'lastModifiedTime',
  'createdBy',
  'lastModifiedBy',
  'autoNumber',
  'button',
  'aiText',
  'externalSyncSource',
]);

/**
 * Writable in Airtable, but not from here.
 *
 * A linked record is addressed by the record id of a row in ANOTHER table, and
 * a collaborator by an Airtable account. A lead holds neither. With typecast on,
 * sending a plain name into one of these has Airtable go and CREATE the missing
 * row or reject the batch — so EstatePulse reads them and never writes them.
 */
export const NOT_WRITABLE_TYPES = new Set(['multipleRecordLinks', 'multipleCollaborators', 'singleCollaborator', 'multipleAttachments', 'barcode']);

export const kindOf = (type: string): ValueKind => KINDS[type] ?? 'complex';
export const isReadOnly = (type: string): boolean => READ_ONLY_TYPES.has(type);
/** Whether EstatePulse may put a lead value in this field at all. */
export const isWritable = (type: string): boolean => !READ_ONLY_TYPES.has(type) && !NOT_WRITABLE_TYPES.has(type);

/**
 * Which EstatePulse field an Airtable field may fill.
 *
 * Deliberately conservative: a phone must come from something textual, because
 * a number field has already dropped the leading `+` and any country code by
 * the time we see it, and EstatePulse never guesses a country. Anything may be
 * carried as a custom field, where it is kept verbatim and nothing is inferred.
 */
export function compatible(fieldType: string, target: MappingTarget): boolean {
  if (target === CUSTOM_TARGET) return true;
  const kind = kindOf(fieldType);
  // A formula or rollup can hold anything; its value is validated when it is read.
  if (kind === 'complex') return fieldType === 'formula' || fieldType === 'rollup';
  if (kind === 'boolean') return false;

  const dataType = target === FULL_NAME_TARGET ? 'string' : CANONICAL_FIELDS[target]?.dataType;
  switch (dataType) {
    case 'phone':
    case 'email':
      return kind === 'text';
    case 'int':
    case 'decimal':
      // Text is allowed: the numeric transform parses "£450,000" the same way it
      // does from a sheet. A date never fills a budget.
      return kind === 'number' || kind === 'text';
    default:
      // Names, location, motivation, time zone: anything that reads as words.
      return kind === 'text' || kind === 'number' || kind === 'date' || kind === 'list';
  }
}

/** Why a mapping was refused, in the owner's words. */
export function incompatibleReason(field: AirtableField, target: MappingTarget): string {
  const label = target === FULL_NAME_TARGET ? 'Full name' : (CANONICAL_FIELDS[target]?.label ?? target);
  if (kindOf(field.type) === 'boolean') return `"${field.name}" is a checkbox, which cannot fill ${label}.`;
  if (kindOf(field.type) === 'complex') return `"${field.name}" is ${field.type}, whose value has no single text form; map it as a custom field instead.`;
  return `"${field.name}" is ${field.type}, which cannot fill ${label}.`;
}

// ---------------------------------------------------------------------------
// Cell values
// ---------------------------------------------------------------------------

/**
 * One Airtable cell as text, for the same transforms a sheet cell goes through.
 *
 * Airtable omits empty cells entirely rather than sending "", so `undefined` is
 * ordinary and means empty. Nothing is invented: a value with no sensible text
 * form (an attachment, a button) reads as empty rather than as "[object Object]".
 */
export function cellToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : '';
  if (Array.isArray(value)) {
    return value
      .map((v) => cellToText(v))
      .filter(Boolean)
      .join(', ');
  }
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    // Select options, collaborators and barcodes each carry one human-readable key.
    for (const k of ['name', 'email', 'text', 'label', 'value', 'filename', 'url']) {
      if (typeof o[k] === 'string' && o[k]) return o[k] as string;
    }
    return '';
  }
  return '';
}

// ---------------------------------------------------------------------------
// One record -> one row the import engine writes
// ---------------------------------------------------------------------------

/**
 * The lookup the row builder needs, computed once per import rather than per
 * record. `fieldIds` fixes the column order; the record id always sits last,
 * under RECORD_ID_KEY.
 */
export interface RowContext {
  headerIndex: Map<string, number>;
  labels: Map<string, string>;
  mappings: StoredMapping[];
  identity: Identity;
  fieldIds: string[];
}

export function rowContext(fields: AirtableField[], mappings: StoredMapping[]): RowContext {
  const fieldIds = fields.map((f) => f.id);
  const headerIndex = new Map(fieldIds.map((id, i) => [id, i]));
  headerIndex.set(RECORD_ID_KEY, fieldIds.length);
  return {
    headerIndex,
    labels: new Map(fields.map((f) => [f.id, f.name])),
    mappings,
    identity: RECORD_IDENTITY,
    fieldIds,
  };
}

/**
 * One Airtable record as the row the import engine writes.
 *
 * `rowNumber` has no meaning in Airtable — records have no position — so the
 * caller passes the index within the page purely so the preview can list them
 * in a stable order.
 */
export function buildAirtableRow(record: AirtableRecord, rowNumber: number, ctx: RowContext): BuiltRow {
  const cells = ctx.fieldIds.map((id) => cellToText(record.fields?.[id]));
  cells.push(record.id);
  return buildRow(cells, rowNumber, ctx);
}

/**
 * The tracking key for an Airtable record, from its record id alone — never
 * from an email or a phone number, which change. Must stay identical to what
 * buildRow derives for RECORD_IDENTITY, which airtable-records.spec.ts pins.
 */
export const airtableRowKey = (recordId: string): string => createHash('sha256').update(`id\u0000${recordId}`).digest('hex');

// ---------------------------------------------------------------------------
// EstatePulse -> Airtable
// ---------------------------------------------------------------------------

/** The lead columns a mapping may send back to Airtable. */
export type OutboundLead = Partial<Record<string, string | number | boolean | null>>;

/**
 * The cells to write for one lead, keyed by Airtable FIELD ID.
 *
 * Only mapped fields appear, and only writable ones: a field Airtable computes
 * is skipped rather than sent, because a single unwritable field id fails the
 * whole batch. Everything Airtable holds that is not named here is untouched —
 * the write is a PATCH.
 *
 * An empty value is sent as null, which clears that one cell. A value we do not
 * have (the lead never had it) is left out entirely rather than clearing what
 * someone typed in Airtable.
 *
 * A column SPLIT on the way in is joined back together on the way out. One
 * Airtable "Name" becomes first_name and last_name, and both halves are stored
 * against that same field id — so writing them one after the other left only
 * whichever came last.
 */
export function toAirtableFields(
  lead: OutboundLead,
  mappings: StoredMapping[],
  fieldsById: Map<string, AirtableField>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const m of mappings) {
    const field = fieldsById.get(m.source_field_key);
    // One unwritable field id fails the WHOLE batch of ten, so a field we
    // cannot fill is skipped rather than sent and discovered the hard way.
    if (!field || !isWritable(field.type)) continue;
    // A custom field has no single lead column behind it, so there is nothing to write back.
    if (m.target_field === CUSTOM_TARGET) continue;

    // The two halves of a split name are one Airtable column, written once.
    //
    // Left as two writes, the second overwrote the first and the column became
    // the surname alone. Read back, that surname was the whole name, so
    // last_name emptied — and the next write sent null and cleared the column.
    // Two rounds of a working sync were enough to destroy a name on both sides.
    if (m.transform?.kind === 'name_split') {
      // Written from the 'first' half so the pair produces exactly one write;
      // the 'last' half is the same column and would only repeat it.
      if (m.transform.part !== 'first') continue;
      const full = [lead.first_name, lead.last_name].filter((p) => p !== null && p !== undefined && p !== '').join(' ');
      // A name is never cleared. A lead cannot exist without one, so an empty
      // join means this lead is missing something — not that anyone deleted it.
      if (full) out[field.id] = coerce(full, field.type);
      continue;
    }

    const value = lead[m.target_field];
    if (value === undefined) continue;
    out[field.id] = coerce(value, field.type);
  }
  return out;
}

/** One lead value in the shape the field's Airtable type accepts. */
function coerce(value: string | number | boolean | null, fieldType: string): unknown {
  if (value === null || value === '') return null;
  switch (kindOf(fieldType)) {
    case 'number': {
      const n = typeof value === 'number' ? value : Number(String(value).replace(/[^0-9.-]/g, ''));
      return Number.isFinite(n) ? n : null;
    }
    case 'boolean':
      return Boolean(value);
    case 'list':
      // A multiple-select or linked-record cell is a list, even of one.
      return [String(value)];
    default:
      return String(value);
  }
}

/**
 * The fingerprint of what we are about to write. Compared with the fingerprint
 * of what later comes back from Airtable, it is what tells our own echo apart
 * from somebody's edit — which is what stops a write/notify/write loop.
 */
export function outboundHash(fields: Record<string, unknown>): string {
  const stable = Object.keys(fields)
    .sort()
    .map((k) => `${k}\u0000${JSON.stringify(fields[k] ?? null)}`)
    .join('\u0001');
  return createHash('sha256').update(stable).digest('hex');
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

/** The lead fields both sides can own, and therefore the ones that can conflict. */
export const SHARED_FIELDS = ['first_name', 'last_name', 'email', 'phone', 'location', 'min_budget', 'max_budget', 'bedrooms', 'motivation'] as const;
export type SharedField = (typeof SHARED_FIELDS)[number];

export type SideValues = Partial<Record<SharedField, string | null>>;

export interface MergeResult {
  /** Airtable's value may be taken: EstatePulse has not touched this field since the last sync. */
  apply: SharedField[];
  /** Both sides changed it. Nothing is written; the owner decides. */
  conflicts: SharedField[];
}

const same = (a: string | null | undefined, b: string | null | undefined): boolean => (a ?? '').trim() === (b ?? '').trim();

/**
 * A three-way merge, the same shape the CRM sync uses: `base` is what we last
 * accepted from Airtable, `ours` is the lead now, `theirs` is Airtable now.
 *
 * Airtable publishes no reliable last-modified time for a record, so ordering
 * two edits by timestamp is not possible. Rather than guess, a field that moved
 * on both sides is reported as a conflict and left alone.
 */
export function airtableMerge(base: SideValues | null, ours: SideValues, theirs: SideValues): MergeResult {
  const apply: SharedField[] = [];
  const conflicts: SharedField[] = [];
  for (const f of SHARED_FIELDS) {
    const t = theirs[f];
    // Airtable did not change it since we last looked.
    if (base && same(t, base[f])) continue;
    // Airtable cleared it or never had it: never blank a lead from an empty cell.
    if (t === null || t === undefined || !t.trim()) continue;
    if (same(ours[f], t)) continue;
    // We hold nothing, or nothing we changed: Airtable's value is safe to take.
    if (ours[f] === null || ours[f] === undefined || !ours[f]!.trim()) apply.push(f);
    else if (base && same(ours[f], base[f])) apply.push(f);
    else conflicts.push(f);
  }
  return { apply, conflicts };
}
