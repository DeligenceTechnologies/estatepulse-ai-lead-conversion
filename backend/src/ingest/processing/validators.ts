import { CANONICAL_FIELDS, type CanonicalKey } from './canonical-fields';
import { isValidEmail } from './transforms';

export type CanonicalValue = string | number | boolean | null;

export interface RejectedValue {
  field: string;
  raw: string;
  reason: string;
}

export interface ValidationResult {
  values: Record<string, CanonicalValue>;
  rejected: RejectedValue[];
  warnings: string[];
}

const MAX_LEN: Partial<Record<CanonicalKey, number>> = {
  first_name: 100,
  last_name: 100,
  email: 255,
  phone: 50,
  location: 255,
  timeline: 100,
  buying_intent: 100,
  financing_status: 100,
  utm_source: 255,
  utm_medium: 255,
  utm_campaign: 255,
};

const MAX_BUDGET = 9_999_999_999.99;

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
          reject(field, value, `${n} exceeds the maximum storable amount`);
          continue;
        }
        out.values[field] = n;
        break;
      }

      case 'enum': {
        const allowed = spec.enumValues ?? [];
        if (allowed.length > 0 && !allowed.includes(String(value))) {
          reject(field, value, `"${render(value)}" is not one of: ${allowed.join(', ')}`);
          continue;
        }
        out.values[field] = value;
        break;
      }

      case 'email': {
        const e = String(value).trim().toLowerCase();
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
