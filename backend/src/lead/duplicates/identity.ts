import parsePhoneNumberFromString from 'libphonenumber-js';

/**
 * The one way a phone or email becomes the key a person is matched on. Every place that writes
 * leads.normalized_phone / normalized_email goes through these, so the same person typed two ways
 * ("+1 (555) 010-2000" and "+15550102000") is one key, and an inbound text (E.164 from Telnyx) finds them.
 */

/** E.164 when libphonenumber reads the number end to end; null when nobody could dial it. No country is assumed. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const parsed = parsePhoneNumberFromString(raw.trim());
  return parsed?.isValid() ? parsed.number : null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trimmed and lowercased when it looks like an email; null otherwise. */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const email = raw.trim().toLowerCase();
  return EMAIL.test(email) ? email : null;
}

const DOTLESS_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * Looser than normalizeEmail, for suggestions only: drops a "+tag" everywhere and dots in Gmail
 * addresses, which reach the same inbox. Never used to attach or merge on its own.
 */
export function canonicalEmail(normalized: string | null | undefined): string | null {
  if (!normalized) return null;
  const at = normalized.lastIndexOf('@');
  if (at < 1) return null;
  let local = normalized.slice(0, at).split('+')[0];
  let domain = normalized.slice(at + 1);
  if (DOTLESS_DOMAINS.has(domain)) {
    local = local.replace(/\./g, '');
    domain = 'gmail.com';
  }
  return local ? `${local}@${domain}` : null;
}

/** The national significant number, so "+1 555…" and "+44 555…" typed with the wrong code can be suggested. */
export function nationalNumber(normalized: string | null | undefined): string | null {
  if (!normalized) return null;
  const parsed = parsePhoneNumberFromString(normalized);
  return parsed ? String(parsed.nationalNumber) : null;
}
