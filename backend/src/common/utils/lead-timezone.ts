import parsePhoneNumberFromString from 'libphonenumber-js';
import areaRegions from '../data/nanp-regions.json';
import prefixZones from '../data/phone-timezones.json';
import aliases from '../data/tz-aliases.json';
import { isTimeZone } from './zoned-time';

/**
 * A lead's time zone, worked out on every read rather than stored.
 *
 * Evidence, strongest first: a zone the lead source provided or an agent set
 * (`leads.timezone`), then the phone number's prefix in Google's libphonenumber
 * data. Nothing is guessed: a prefix that sits in more than one zone, or a
 * toll-free number, needs a person to decide, and a lead without a usable
 * number has no zone at all.
 *
 * The jurisdiction (country, state or province) is an ESTIMATE from the phone
 * number, never proof of where the lead lives. It only picks which legal
 * calling-hours rules apply; when a provided zone contradicts it, the legal
 * layer falls back to the strictest rules instead of trusting either.
 */
export type LeadZoneStatus = 'verified' | 'inferred' | 'needs_review' | 'unknown';

export interface Jurisdiction {
  /** ISO 3166-1 alpha-2 from the phone number; null when the number is unusable. */
  country: string | null;
  /** US state or Canadian province code from the area code; null elsewhere or when unknown. */
  region: string | null;
  /** `conflict`: the provided zone is not one the phone number sits in. */
  status: 'estimated' | 'conflict' | 'unknown';
}

export interface LeadZone {
  zone: string | null;
  status: LeadZoneStatus;
  /** `provided`: the lead source or an agent; `phone`: inferred from the number. */
  source: 'provided' | 'phone' | null;
  /** False when the lead has no usable phone number: no zone can make them callable or textable. */
  hasPhone: boolean;
  /** Every zone the phone prefix is known to sit in. */
  candidates: string[];
  jurisdiction: Jurisdiction;
  /** Why the status is what it is, for the UI and the logs. */
  reason: string;
}

const ZONES: Record<string, string[]> = prefixZones;
const REGIONS: Record<string, string> = areaRegions;
const ALIASES: Record<string, string> = aliases;
/** The longest prefix in the data. */
const MAX_PREFIX = 9;
/** More candidates than this is a whole country's list (a toll-free or non-geographic number), not a place. */
const MAX_CANDIDATES = 3;

/** The current tzdata name for a zone (`Asia/Calcutta` -> `Asia/Kolkata`); unknown names pass through trimmed. */
export function canonicalZone(zone: string): string {
  const trimmed = zone.trim();
  return ALIASES[trimmed] ?? trimmed;
}

/** The zones the number's longest known prefix sits in; [] when none is known. */
function phoneCandidates(digits: string): string[] {
  for (let len = Math.min(MAX_PREFIX, digits.length); len > 0; len--) {
    const hit = ZONES[digits.slice(0, len)];
    if (hit) return hit;
  }
  return [];
}

export function leadZone(lead: { timezone: string | null; normalizedPhone: string | null }): LeadZone {
  const parsed = lead.normalizedPhone ? parsePhoneNumberFromString(lead.normalizedPhone) : undefined;
  const phone = parsed?.isPossible() ? parsed : undefined;
  const hasPhone = phone !== undefined;
  const candidates = phone ? phoneCandidates(`${phone.countryCallingCode}${phone.nationalNumber}`) : [];
  const country = phone?.country ?? null;
  const areaCode = phone?.countryCallingCode === '1' ? phone.nationalNumber.slice(0, 3) : null;
  const region = areaCode && (country === 'US' || country === 'CA') ? (REGIONS[areaCode] ?? null) : null;
  const jurisdiction: Jurisdiction = { country, region, status: country ? 'estimated' : 'unknown' };

  const provided = lead.timezone && isTimeZone(lead.timezone) ? canonicalZone(lead.timezone) : null;
  if (provided) {
    const agrees = candidates.length === 0 || candidates.includes(provided);
    return {
      zone: provided,
      status: 'verified',
      source: 'provided',
      hasPhone,
      candidates,
      jurisdiction: agrees ? jurisdiction : { ...jurisdiction, status: 'conflict' },
      reason: 'Provided by the lead source or set by an agent',
    };
  }

  // A stored zone Intl cannot format must never reach a contact gate; the phone decides instead.
  const prefix = lead.timezone ? 'Stored time zone is invalid; ' : '';
  const place = areaCode ? `area code ${areaCode}` : phone ? `country code +${phone.countryCallingCode}` : '';
  if (candidates.length === 0) {
    return { zone: null, status: 'unknown', source: null, hasPhone, candidates, jurisdiction, reason: `${prefix}${phone ? 'no time zone is known for this number' : 'no usable phone number'}` };
  }
  if (candidates.length === 1) {
    return { zone: candidates[0], status: 'inferred', source: 'phone', hasPhone, candidates, jurisdiction, reason: `${prefix}from ${place}` };
  }
  if (candidates.length > MAX_CANDIDATES) {
    return { zone: null, status: 'needs_review', source: 'phone', hasPhone, candidates, jurisdiction, reason: `${prefix}toll-free or non-geographic number` };
  }
  return { zone: null, status: 'needs_review', source: 'phone', hasPhone, candidates, jurisdiction, reason: `${prefix}${place} spans more than one time zone` };
}

/** The zone a lead may be contacted in, or null while it is unknown or disputed. */
export const contactZone = (z: LeadZone): string | null => (z.status === 'verified' || z.status === 'inferred' ? z.zone : null);

/** `CA-BC`, `US`, or `unknown`, with `(disputed)` when a provided zone contradicts the phone; for logs and the UI. */
export function jurisdictionCode(z: LeadZone): string {
  const j = z.jurisdiction;
  const code = j.country ? (j.region ? `${j.country}-${j.region}` : j.country) : 'unknown';
  return j.status === 'conflict' ? `${code}(disputed)` : code;
}
