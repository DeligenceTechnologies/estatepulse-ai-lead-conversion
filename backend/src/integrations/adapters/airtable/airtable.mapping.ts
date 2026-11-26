import type { ImportedRecord } from '../adapter.interface';

/**
 * Pure Airtable logic: which lead field an Airtable field can fill, how a cell
 * reads as text, and how one record becomes an ImportedRecord. No HTTP here.
 */

export interface AirtableField {
  id: string;
  name: string;
  type: string;
}

export interface AirtableTable {
  id: string;
  name: string;
  primaryFieldId?: string;
  fields: AirtableField[];
}

export interface AirtableRecord {
  id: string;
  createdTime?: string;
  /** Keyed by field id (returnFieldsByFieldId=true), so a renamed column keeps mapping. */
  fields: Record<string, unknown>;
}

/** Lead fields an Airtable column may fill. `fullName` is split into first and last. */
export const MAPPABLE = [
  'fullName',
  'firstName',
  'lastName',
  'email',
  'phone',
  'location',
  'timeline',
  'motivation',
  'minBudget',
  'maxBudget',
  'bedrooms',
] as const;
export type MappableField = (typeof MAPPABLE)[number];
export type FieldMap = Partial<Record<MappableField, string>>;

const NUMERIC: ReadonlySet<MappableField> = new Set(['minBudget', 'maxBudget', 'bedrooms']);

/** Column-name hints, matched on the lowercased name with spaces/underscores/dashes removed. */
const HINTS: Record<MappableField, RegExp> = {
  fullName: /^(full)?name$|^(contact|lead|client|customer)name$/,
  firstName: /^(first|given)name$|^fname$|^first$/,
  lastName: /^(last|family|sur)name$|^lname$|^surname$|^last$/,
  email: /^e?mail(address)?$|^emailaddress$/,
  phone: /^(phone|mobile|cell|tel|telephone|whatsapp)(number|no)?$|^contactnumber$/,
  location: /^(location|city|area|address|neighbou?rhood|region)$/,
  timeline: /^(timeline|timeframe|movein(date)?|whentobuy|buyingtimeline)$/,
  motivation: /^(notes?|message|comments?|motivation|requirements?)$/,
  minBudget: /^(min|minimum)(budget|price)$|^budgetmin$/,
  maxBudget: /^(max|maximum)(budget|price)$|^budget(max)?$/,
  bedrooms: /^(bed(room)?s?|beds|bhk)$/,
};

/** Field types that can hold a phone or email (a number field has already lost a leading "+"). */
const TEXTUAL = new Set(['singleLineText', 'multilineText', 'richText', 'email', 'phoneNumber', 'url', 'singleSelect', 'formula', 'rollup', 'multipleLookupValues']);
const NUMBERISH = new Set(['number', 'currency', 'percent', 'rating', 'count', ...TEXTUAL]);

/** Whether a column of this type may fill this lead field. */
export function compatible(type: string, target: MappableField): boolean {
  if (target === 'email' || target === 'phone') return TEXTUAL.has(type);
  if (NUMERIC.has(target)) return NUMBERISH.has(type);
  return TEXTUAL.has(type) || type === 'date' || type === 'dateTime' || type === 'multipleSelects';
}

const squash = (name: string) => name.toLowerCase().replace(/[\s_\-.]/g, '');

/** A first guess at the field map from column names and types; the owner can change it. */
export function suggestFieldMap(table: AirtableTable): FieldMap {
  const map: FieldMap = {};
  const used = new Set<string>();
  // Specific fields before fullName, so "First Name" is never taken as the full name.
  const order: MappableField[] = ['email', 'phone', 'firstName', 'lastName', 'fullName', 'minBudget', 'maxBudget', 'bedrooms', 'location', 'timeline', 'motivation'];
  for (const target of order) {
    const hit = table.fields.find((f) => !used.has(f.id) && compatible(f.type, target) && HINTS[target].test(squash(f.name)));
    if (hit) {
      map[target] = hit.id;
      used.add(hit.id);
    }
  }
  // A table with a separate first name does not also need a full name.
  if (map.firstName && map.fullName) delete map.fullName;
  // Airtable's primary field is usually the person's name.
  if (!map.firstName && !map.fullName && table.primaryFieldId) {
    const primary = table.fields.find((f) => f.id === table.primaryFieldId);
    if (primary && !used.has(primary.id) && compatible(primary.type, 'fullName')) map.fullName = primary.id;
  }
  return map;
}

/** A cell as plain text, or null when it has nothing a person could read. */
export function cellText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) {
    const parts = value.map(cellText).filter((v): v is string => Boolean(v));
    return parts.length ? parts.join(', ') : null;
  }
  if (typeof value === 'object') {
    // Collaborators ({ name, email }), attachments ({ filename, url }), AI text ({ value }).
    const o = value as Record<string, unknown>;
    for (const key of ['name', 'email', 'value', 'filename', 'text']) {
      if (typeof o[key] === 'string' && (o[key] as string).trim()) return (o[key] as string).trim();
    }
  }
  return null;
}

/** "£450,000", "450000", "3.5" -> a number; anything else -> null. */
export function cellNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = cellText(value);
  if (!text) return null;
  const cleaned = text.replace(/[^\d.\-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Splits "Jane van der Berg" into "Jane" / "van der Berg". */
export function splitName(full: string): { firstName: string; lastName: string | null } {
  const parts = full.trim().split(/\s+/);
  return { firstName: parts[0], lastName: parts.length > 1 ? parts.slice(1).join(' ') : null };
}

const MAX_CUSTOM_FIELDS = 30;
const MAX_CUSTOM_VALUE = 1_000;

/** One Airtable record as lead fields. Unmapped readable columns are kept as custom fields. */
export function toImportedRecord(record: AirtableRecord, table: AirtableTable, map: FieldMap): ImportedRecord {
  const read = (target: MappableField) => (map[target] ? record.fields[map[target]!] : undefined);
  const text = (target: MappableField) => cellText(read(target));
  const number = (target: MappableField) => cellNumber(read(target));

  let firstName = text('firstName');
  let lastName = text('lastName');
  const full = text('fullName');
  if (!firstName && full) {
    const split = splitName(full);
    firstName = split.firstName;
    lastName = lastName ?? split.lastName;
  }

  const mapped = new Set(Object.values(map));
  const customFields: Record<string, string> = {};
  for (const field of table.fields) {
    if (mapped.has(field.id) || Object.keys(customFields).length >= MAX_CUSTOM_FIELDS) continue;
    const value = cellText(record.fields[field.id]);
    if (value) customFields[field.name.slice(0, 100)] = value.slice(0, MAX_CUSTOM_VALUE);
  }

  const bedrooms = number('bedrooms');
  return {
    objectType: `airtable:${table.id}`,
    externalId: record.id,
    firstName,
    lastName,
    email: text('email'),
    phone: text('phone'),
    location: text('location'),
    timeline: text('timeline'),
    motivation: text('motivation'),
    minBudget: number('minBudget'),
    maxBudget: number('maxBudget'),
    bedrooms: bedrooms === null ? null : Math.round(bedrooms),
    customFields,
  };
}
