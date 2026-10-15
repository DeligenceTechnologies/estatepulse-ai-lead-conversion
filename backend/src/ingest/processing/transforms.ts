import parsePhoneNumberFromString, { type CountryCode } from 'libphonenumber-js';

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

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim().toLowerCase());
}

function splitName(input: string, part: 'first' | 'last'): string | null {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  if (part === 'first') return tokens[0];
  return tokens.length > 1 ? tokens.slice(1).join(' ') : null;
}

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
      return { value: e };
    }

    case 'phone_e164': {
      if (!scalarText) return { value: null };
      const region = (transform.defaultRegion ?? defaultRegion) as CountryCode;
      const parsed = parsePhoneNumberFromString(scalarText, region);
      if (!parsed?.isValid()) {
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
      const key = textValues[0].trim().toLowerCase();
      const hit = transform.byOptionText[key];
      if (hit) return { value: hit };
      return {
        value: transform.fallback ?? null,
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
