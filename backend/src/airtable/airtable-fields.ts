/**
 * Creating a new column in an Airtable table.
 *
 * This is a SEPARATE capability from writing records: it needs
 * `schema.bases:write`, which `data.records:write` does not imply. A connection
 * that may create records and not columns is a normal, working connection — it
 * just cannot do this.
 *
 * Shapes verified against Airtable's create-field documentation on 2026-11-13.
 * Airtable requires an `options` object for several types and rejects the
 * request without it, so every default below is filled in rather than left to
 * the owner: they choose a name and a type, nothing more.
 */

/** The field types an owner may create from EstatePulse, in the order the picker lists them. */
export const CREATABLE_TYPES = [
  'singleLineText',
  'multilineText',
  'email',
  'phoneNumber',
  'url',
  'number',
  'currency',
  'percent',
  'date',
  'dateTime',
  'checkbox',
  'singleSelect',
  'multipleSelects',
] as const;

export type CreatableType = (typeof CREATABLE_TYPES)[number];

export const TYPE_LABELS: Record<CreatableType, string> = {
  singleLineText: 'Single line text',
  multilineText: 'Long text',
  email: 'Email',
  phoneNumber: 'Phone number',
  url: 'URL',
  number: 'Number',
  currency: 'Currency',
  percent: 'Percent',
  date: 'Date',
  dateTime: 'Date and time',
  checkbox: 'Checkbox',
  singleSelect: 'Single select',
  multipleSelects: 'Multiple select',
};

export const isCreatable = (type: string): type is CreatableType => (CREATABLE_TYPES as readonly string[]).includes(type);

export interface NewFieldRequest {
  name: string;
  type: CreatableType;
  /** Currency only; Airtable requires a symbol and documents no default. */
  currencySymbol?: string;
  /** Single/multiple select only. Airtable requires at least the choices array. */
  choices?: string[];
  /** Date and time only; Airtable requires a time zone. */
  timeZone?: string;
}

/**
 * The body Airtable's create-field endpoint expects. Options Airtable marks
 * required are always present; nothing else is sent, so a future Airtable
 * default is not overridden by a guess made here.
 */
export function newFieldBody(req: NewFieldRequest): { name: string; type: string; options?: Record<string, unknown> } {
  const name = req.name.trim();
  switch (req.type) {
    case 'number':
      // 0 keeps whole numbers whole; Airtable requires precision for a number field.
      return { name, type: req.type, options: { precision: 0 } };
    case 'percent':
      return { name, type: req.type, options: { precision: 0 } };
    case 'currency':
      return { name, type: req.type, options: { precision: 2, symbol: req.currencySymbol?.slice(0, 10) || '$' } };
    case 'date':
      return { name, type: req.type, options: { dateFormat: { name: 'iso' } } };
    case 'dateTime':
      return {
        name,
        type: req.type,
        options: { timeZone: req.timeZone || 'utc', dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' } },
      };
    case 'checkbox':
      // Both keys are required; these are Airtable's own first listed values.
      return { name, type: req.type, options: { color: 'greenBright', icon: 'check' } };
    case 'singleSelect':
    case 'multipleSelects':
      // Trimmed before the emptiness check: a choice of only spaces would
      // otherwise pass as a name and create a blank option in Airtable.
      return { name, type: req.type, options: { choices: (req.choices ?? []).map((c) => ({ name: c.trim().slice(0, 100) })).filter((c) => c.name) } };
    default:
      // Text, email, URL and phone take no options at all.
      return { name, type: req.type };
  }
}

/**
 * Airtable field names are compared the way a person would read them, so
 * "Budget" and " budget " are the same column and a second one is never made.
 */
export const sameFieldName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();
