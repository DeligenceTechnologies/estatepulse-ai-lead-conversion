import parsePhoneNumberFromString, { type CountryCode } from 'libphonenumber-js';

/**
 * Value transforms applied between a provider answer and a canonical lead field.
 *
 * Stored as JSON on each mapping rather than as a Postgres enum: this set will
 * grow every time a customer asks a question we did not anticipate, and
 * `ALTER TYPE` migrations for that are pure friction.
 */
export type Transform =
  | { kind: 'passthrough' }
  | { kind: 'text'; maxLen?: number }
  | { kind: 'name_split'; part: 'first' | 'last' }
  | { kind: 'phone_e164'; defaultRegion?: string }
  | { kind: 'email' }
  | { kind: 'number' }
  | { kind: 'currency_range'; part: 'min' | 'max' }
  | { kind: 'enum_map'; byOptionText: Record<string, string>; fallback?: string | null }
  | { kind: 'boolean'; truthy?: string[] }
  | { kind: 'constant'; value: string };

export interface TransformResult {
  value: string | number | boolean | null;
  warning?: string;
}

const DEFAULT_TRUTHY = ['yes', 'true', '1', 'on', 'agree', 'i agree', 'ok', 'okay', 'sure', 'consent'];

/**
 * Deliberately permissive — this is not an RFC 5322 parser.
 *
 * Its only job is to separate "an address we can key identity on" from the
 * things people actually type into a required email box: "n/a", "none", "-",
 * "asdf". Anything shaped like an address is accepted; delivery is the mail
 * server's problem, not ours.
 *
 * Exported because `createLead` must ask the SAME question before storing an
 * address as `normalized_email`. Two callers with two regexes is how "n/a"
 * becomes a shared identity again six months from now — fifty strangers
 * reported as one prospect who submitted fifty times.
 */
export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim().toLowerCase());
}

/**
 * Split a full name.
 *
 * Takes the FIRST token as the first name and everything after as the last
 * name — not the last token. "Mary Jo van der Berg" must yield
 * "van der Berg", not "Berg". A single token is a first name with no surname.
 */
function splitName(input: string, part: 'first' | 'last'): string | null {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  if (part === 'first') return tokens[0];
  return tokens.length > 1 ? tokens.slice(1).join(' ') : null;
}

/** "450k" -> 450000, "1.2M" -> 1200000, "$650,000" -> 650000 */
function parseMoney(raw: string): number | null {
  const m = raw.match(/([\d]+(?:[.,]\d+)?)\s*([kKmM])?/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const suffix = m[2]?.toLowerCase();
  if (suffix === 'k') return Math.round(n * 1_000);
  if (suffix === 'm') return Math.round(n * 1_000_000);
  return Math.round(n);
}

/**
 * Pull one end out of a budget range.
 *
 * Handles "$500,000 - $650,000", "500k-650k", "Under $400k", "$1M+" and
 * "Not sure". "Not sure" returns null rather than 0 — a 0 would make the lead
 * look like a cash-poor buyer and silently corrupt the score.
 */
function parseRange(raw: string, part: 'min' | 'max'): TransformResult {
  const text = raw.trim();
  if (!text) return { value: null };

  if (/not sure|unsure|don'?t know|flexible|n\/?a/i.test(text)) return { value: null };

  const openLow = /^(under|below|less than|up to|<)/i.test(text);
  const openHigh = /(\+|and (up|above)|or more|plus)\s*$/i.test(text) || /^(over|above|more than|>)/i.test(text);

  const numbers = Array.from(text.matchAll(/\$?\s*([\d][\d.,]*)\s*([kKmM])?/g))
    .map((m) => parseMoney(`${m[1]}${m[2] ?? ''}`))
    .filter((n): n is number => n !== null);

  if (numbers.length === 0) return { value: null };

  if (numbers.length === 1) {
    const n = numbers[0];
    if (openLow) return { value: part === 'min' ? 0 : n };
    if (openHigh) {
      // An open-ended top ("$1M+") has no real maximum. 1.5x is a convention,
      // flagged so nobody mistakes it for something the lead actually said.
      return part === 'min'
        ? { value: n }
        : { value: Math.round(n * 1.5), warning: 'Open-ended budget; max estimated at 1.5x' };
    }
    return { value: n };
  }

  const sorted = [...numbers].sort((a, b) => a - b);
  return { value: part === 'min' ? sorted[0] : sorted[sorted.length - 1] };
}

export function applyTransform(
  transform: Transform,
  textValues: string[],
  scalarText: string,
  defaultRegion: string,
): TransformResult {
  switch (transform.kind) {
    case 'constant':
      return { value: transform.value };

    case 'passthrough':
    case 'text': {
      if (!scalarText) return { value: null };
      const max = transform.kind === 'text' ? (transform.maxLen ?? 2000) : 2000;
      return { value: scalarText.slice(0, max) };
    }

    case 'name_split':
      return { value: scalarText ? splitName(scalarText, transform.part) : null };

    case 'email': {
      const e = scalarText.trim().toLowerCase();
      if (!e) return { value: null };
      if (!isValidEmail(e)) {
        // Kept, like an unparseable phone: a lead who fat-fingered their address
        // is still a lead. It just never counts as a repeat contact — see
        // createLead and LeadsController.countLeadsPerContact.
        return { value: e, warning: `"${e}" does not look like a valid email` };
      }
      return { value: e };
    }

    case 'phone_e164': {
      if (!scalarText) return { value: null };
      const region = (transform.defaultRegion ?? defaultRegion) as CountryCode;
      const parsed = parsePhoneNumberFromString(scalarText, region);
      if (!parsed?.isValid()) {
        // Keep the raw value: a lead with an unparseable number is still a lead,
        // it just must never be auto-dialed.
        return { value: scalarText, warning: `Could not parse "${scalarText}" as a phone number` };
      }
      return { value: parsed.number };
    }

    case 'number': {
      const n = parseMoney(scalarText);
      return n === null ? { value: null, warning: `Could not read a number from "${scalarText}"` } : { value: n };
    }

    case 'currency_range':
      return parseRange(scalarText, transform.part);

    case 'enum_map': {
      if (textValues.length === 0) return { value: null };
      // Keyed on option TEXT, not option id: ids are regenerated whenever a
      // customer rebuilds a dropdown, and text is the only thing a human can
      // meaningfully configure in the mapping UI.
      const key = textValues[0].trim().toLowerCase();
      const hit = transform.byOptionText[key];
      if (hit) return { value: hit };
      return {
        value: transform.fallback ?? null,
        // Surfaced rather than silently dropped — an unmapped option is how a
        // field quietly becomes 40% null and nobody notices for two months.
        warning: `Unrecognised option "${textValues[0]}"`,
      };
    }

    case 'boolean': {
      if (!scalarText) return { value: false };
      const truthy = transform.truthy ?? DEFAULT_TRUTHY;
      return { value: truthy.includes(scalarText.trim().toLowerCase()) };
    }
  }
}
