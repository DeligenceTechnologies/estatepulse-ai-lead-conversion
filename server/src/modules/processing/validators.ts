/**
 * The last gate between an arbitrary form answer and a `leads` column.
 *
 * Transforms validate SHAPE ("is this parseable as a phone?"). This validates
 * the VALUE against the column that will receive it: range, enum membership,
 * and the physical width of the column. We do not own the forms we ingest, so
 * a customer can ask "How many bedrooms?" as a free-text box and a prospect can
 * answer "as many as possible" — `parseMoney` happily returns a number from
 * that, and nothing downstream would have questioned it.
 *
 * ONE invariant governs everything here:
 *
 *   A failed validation demotes ONE FIELD to custom_fields. It never rejects
 *   the lead.
 *
 * Someone who typed one strange answer is still a prospect worth calling, and
 * silently dropping their phone number because their bedroom count was odd
 * would be a far worse outcome than an unmapped field. The demoted answer is
 * preserved verbatim, so nothing a prospect told us is ever lost.
 */

import { CANONICAL_FIELDS, type CanonicalKey } from './canonical-fields';
import { isValidEmail } from './transforms';

export type CanonicalValue = string | number | boolean | null;

export interface RejectedValue {
  field: string;
  /** Rendered for custom_fields, so a human can still read what was said. */
  raw: string;
  reason: string;
}

export interface ValidationResult {
  /** Values that passed, safe to write to their columns. */
  values: Record<string, CanonicalValue>;
  /** Fields demoted to custom_fields, keyed by the canonical field's label. */
  rejected: RejectedValue[];
  warnings: string[];
}

/**
 * Column widths from schema.prisma's `leads` model.
 *
 * A 5,000-character answer to "Which areas?" is not hypothetical — people paste
 * lists. Without a clamp, Postgres rejects the INSERT, the delivery retries six
 * times and dead-letters, and ONE long answer costs the whole lead. Truncating
 * loses the tail of one field; not truncating loses everything.
 */
const MAX_LEN: Partial<Record<CanonicalKey, number>> = {
  first_name: 100,
  last_name: 100,
  email: 255,
  phone: 50,
  location: 255,
  timeline: 100,
  buying_intent: 100,
  financing_status: 100,
  // `motivation` is TEXT — no clamp.
};

/** `leads.min_budget`/`max_budget` are Decimal(12,2). */
const MAX_BUDGET = 9_999_999_999.99;

/**
 * A house has bedrooms; nobody's real answer is 5000. An absurd value here is a
 * mis-mapped field (a budget or a zip code landing on `bedrooms`), which is
 * worth flagging rather than storing.
 */
const MAX_BEDROOMS = 20;

const render = (v: CanonicalValue): string => (v === null ? '' : String(v));

export function validateCanonicalValues(values: Record<string, CanonicalValue>): ValidationResult {
  const out: ValidationResult = { values: {}, rejected: [], warnings: [] };

  const reject = (field: string, value: CanonicalValue, reason: string) => {
    out.rejected.push({ field, raw: render(value), reason });
    out.warnings.push(`${CANONICAL_FIELDS[field]?.label ?? field}: ${reason}`);
  };

  for (const [field, value] of Object.entries(values)) {
    if (value === null || value === '') continue;

    const spec = CANONICAL_FIELDS[field];
    if (!spec) {
      // A target with no canonical definition cannot be written to a column.
      reject(field, value, 'not a known lead field');
      continue;
    }

    switch (spec.dataType) {
      case 'int': {
        const n = Number(value);
        if (!Number.isFinite(n)) {
          reject(field, value, `"${render(value)}" is not a number`);
          continue;
        }
        const rounded = Math.round(n);
        if (rounded < 0 || rounded > MAX_BEDROOMS) {
          reject(field, value, `${rounded} is outside the expected range 0–${MAX_BEDROOMS}`);
          continue;
        }
        out.values[field] = rounded;
        break;
      }

      case 'decimal': {
        const n = Number(value);
        if (!Number.isFinite(n)) {
          reject(field, value, `"${render(value)}" is not a number`);
          continue;
        }
        if (n < 0) {
          reject(field, value, 'a negative amount is not a budget');
          continue;
        }
        if (n > MAX_BUDGET) {
          // Writing this would overflow Decimal(12,2) and fail the INSERT.
          reject(field, value, `${n} exceeds the maximum storable amount`);
          continue;
        }
        out.values[field] = n;
        break;
      }

      case 'enum': {
        const allowed = spec.enumValues ?? [];
        if (allowed.length > 0 && !allowed.includes(String(value))) {
          // Never coerce or guess. A timeline we invent drives scoring, routing
          // and follow-up cadence off a value the lead never gave us.
          reject(field, value, `"${render(value)}" is not one of: ${allowed.join(', ')}`);
          continue;
        }
        out.values[field] = value;
        break;
      }

      case 'email': {
        const e = String(value).trim().toLowerCase();
        // Kept either way — validity decides identity, not storage.
        out.values[field] = clamp(field as CanonicalKey, e, out);
        if (!isValidEmail(e)) out.warnings.push(`${spec.label}: "${e}" does not look like an email`);
        break;
      }

      case 'bool': {
        if (typeof value !== 'boolean') {
          reject(field, value, `"${render(value)}" is not a yes/no answer`);
          continue;
        }
        out.values[field] = value;
        break;
      }

      case 'phone':
      case 'string':
      default:
        out.values[field] = clamp(field as CanonicalKey, String(value), out);
        break;
    }
  }

  // Budgets are validated individually above; the relationship between them is
  // a separate question. "$650k - $500k" is a real thing people type, and a
  // min above a max would silently break every range filter downstream.
  const min = out.values.min_budget;
  const max = out.values.max_budget;
  if (typeof min === 'number' && typeof max === 'number' && min > max) {
    out.values.min_budget = max;
    out.values.max_budget = min;
    out.warnings.push(`Budget: range was reversed (${min} – ${max}); swapped`);
  }

  return out;
}

function clamp(field: CanonicalKey, value: string, out: ValidationResult): string {
  const max = MAX_LEN[field];
  if (max === undefined || value.length <= max) return value;
  out.warnings.push(
    `${CANONICAL_FIELDS[field]?.label ?? field}: answer was ${value.length} characters, truncated to ${max}`,
  );
  return value.slice(0, max);
}
