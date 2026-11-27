import type { ImportedRecord } from '../adapter.interface';
import { cellNumber, splitName } from '../airtable/airtable.mapping';

/**
 * Pure Google Sheets logic: the header row as columns, which lead field a
 * column can fill, and how one row becomes an ImportedRecord. No HTTP here.
 *
 * A sheet has no column types and no row ids, so:
 *  - Columns are identified by their header text (a moved column keeps its
 *    mapping; a renamed header loses it). A repeated header gets " (2)", " (3)".
 *  - A row's identity is its email, else its phone, never its row number:
 *    sorting the sheet or inserting a row would otherwise point one lead at
 *    another person's row. A row with neither is not imported.
 */

/** Lead fields a column may fill. `fullName` is split into first and last. */
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
/** Lead field -> column key (the header text, de-duplicated). */
export type FieldMap = Partial<Record<MappableField, string>>;

export interface SheetColumn {
  /** The header as shown, de-duplicated: the key the field map stores. */
  key: string;
  /** 0-based position in the row as read now. */
  index: number;
}

const MAX_HEADER = 100;

/** The header row as columns. Blank headers are skipped: nobody can tell what they hold. */
export function readHeader(header: readonly unknown[] | undefined): SheetColumn[] {
  const out: SheetColumn[] = [];
  const seen = new Set<string>();
  (header ?? []).forEach((cell, index) => {
    const base = String(cell ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_HEADER);
    if (!base) return;
    let key = base;
    for (let n = 2; seen.has(key); n++) key = `${base} (${n})`;
    seen.add(key);
    out.push({ key, index });
  });
  return out;
}

/** Column-name hints, matched on the lowercased header with spaces and punctuation removed. */
const HINTS: Record<MappableField, RegExp> = {
  fullName: /^(your)?(full)?name$|^(contact|lead|client|customer|buyer)name$/,
  firstName: /^(first|given)name$|^fname$|^first$/,
  lastName: /^(last|family|sur)name$|^lname$|^surname$|^last$/,
  email: /e?mail/,
  phone: /phone|mobile|cell|whatsapp|contactnumber|contactno|telephone|^tel$/,
  location: /^(preferred)?(location|city|area|address|neighbou?rhood|region|locality)$/,
  timeline: /timeline|timeframe|movein|whentobuy|purchasetime|howsoon/,
  motivation: /^(notes?|message|comments?|motivation|requirements?|remarks?)$/,
  minBudget: /^(min|minimum)(budget|price)|budgetmin/,
  maxBudget: /^(max|maximum)(budget|price)|budgetmax|^budget(range)?$/,
  bedrooms: /bed(room)?s?|bhk/,
};

const squash = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, '');

/** A first guess at the field map from header names; the owner can change it. */
export function suggestFieldMap(columns: readonly SheetColumn[]): FieldMap {
  const map: FieldMap = {};
  const used = new Set<string>();
  // Specific fields before fullName, so "First name" is never taken as the full name.
  const order: MappableField[] = ['email', 'phone', 'firstName', 'lastName', 'fullName', 'minBudget', 'maxBudget', 'bedrooms', 'location', 'timeline', 'motivation'];
  for (const target of order) {
    const hit = columns.find((c) => !used.has(c.key) && HINTS[target].test(squash(c.key)));
    if (hit) {
      map[target] = hit.key;
      used.add(hit.key);
    }
  }
  if (map.firstName && map.fullName) delete map.fullName;
  return map;
}

const cellText = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};

/** "₹45,00,000", "450000", "3 BHK" -> a number; anything else -> null. Ranges ("50L - 75L") are not guessed. */
function textNumber(text: string | null): number | null {
  if (!text || /\d\s*(-|–|to)\s*\d/i.test(text)) return null;
  return cellNumber(text);
}

/** The row's stable identity: its email, else its phone (digits only). Null = not importable. */
export function rowKey(email: string | null, phone: string | null): string | null {
  const e = email?.trim().toLowerCase();
  if (e && e.includes('@')) return `email:${e}`;
  const digits = phone?.replace(/\D/g, '') ?? '';
  return digits.length >= 6 ? `phone:${digits}` : null;
}

const MAX_CUSTOM_FIELDS = 30;
const MAX_CUSTOM_VALUE = 1_000;

/**
 * One row as lead fields, or null when the row has no email or phone (blank
 * rows included). Other non-empty cells are kept on the lead as custom fields.
 */
export function toImportedRecord(
  row: readonly unknown[],
  rowNumber: number,
  objectType: string,
  columns: readonly SheetColumn[],
  map: FieldMap,
): ImportedRecord | null {
  const byKey = new Map(columns.map((c) => [c.key, c.index]));
  const text = (target: MappableField) => {
    const index = map[target] ? byKey.get(map[target]!) : undefined;
    return index === undefined ? null : cellText(row[index]);
  };

  const email = text('email');
  const phone = text('phone');
  const key = rowKey(email, phone);
  if (!key) return null;

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
  for (const c of columns) {
    if (mapped.has(c.key) || Object.keys(customFields).length >= MAX_CUSTOM_FIELDS) continue;
    const value = cellText(row[c.index]);
    if (value) customFields[c.key] = value.slice(0, MAX_CUSTOM_VALUE);
  }

  const bedrooms = textNumber(text('bedrooms'));
  return {
    objectType,
    externalId: key,
    firstName,
    lastName,
    email,
    phone,
    location: text('location'),
    timeline: text('timeline'),
    motivation: text('motivation'),
    minBudget: textNumber(text('minBudget')),
    maxBudget: textNumber(text('maxBudget')),
    bedrooms: bedrooms === null ? null : Math.round(bedrooms),
    customFields,
    // Where the row was on this read. Informational only: rows move.
    meta: { row: String(rowNumber) },
  };
}
