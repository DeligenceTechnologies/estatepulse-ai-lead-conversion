import { parsePhoneNumberFromString } from 'libphonenumber-js';

/**
 * Who is texting and how to stop, added to an outreach text when the rules
 * ask for them and its template does not already say them. Carriers (CTIA,
 * 10DLC) want the brand and "Reply STOP" in the first text to a number;
 * Canada (CASL) wants the sender and a way to unsubscribe in every commercial
 * text. Only GSM-7 characters are used, so the footer never switches a text
 * to the 70-character UCS-2 encoding.
 */

/** What the organization tells leads about itself: its legal name, where to write and how to reach it. '' when unset. */
export interface BusinessDetails {
  legalName: string;
  mailingAddress: string;
  email: string;
  website: string;
}

export const BUSINESS_DETAILS_MAX = { legalName: 120, mailingAddress: 200, email: 120, website: 120 } as const;

/** The stored setting, every field a trimmed string. */
export function businessDetails(raw: unknown): BusinessDetails {
  const v = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const field = (key: keyof BusinessDetails) => (typeof v[key] === 'string' ? (v[key] as string).trim().slice(0, BUSINESS_DETAILS_MAX[key]) : '');
  return { legalName: field('legalName'), mailingAddress: field('mailingAddress'), email: field('email'), website: field('website') };
}

/** CASL asks for a mailing address beside the name and a phone, email or website; the phone is the number we text from. */
export const businessDetailsComplete = (d: BusinessDetails): boolean => Boolean(d.mailingAddress);

export const OPT_OUT_LINE = 'Reply STOP to opt out.';

/** Whether a text already tells the lead how to stop: "Reply STOP", "text STOP to unsubscribe", "STOP to opt out". */
export function hasOptOutLine(text: string): boolean {
  return /\b(reply|text|send|txt)\s+["']?stop\b/i.test(text) || /\bstop\b.{0,25}\b(opt[\s-]?out|unsubscribe|cancel)\b/i.test(text);
}

/** A Canadian number: CASL applies to every commercial text it gets. */
export function isCanadian(phone: string): boolean {
  return parsePhoneNumberFromString(phone)?.country === 'CA';
}

/** Our number as people write it: "(742) 724-5092" in North America, the international form elsewhere. */
export function displayNumber(phone: string): string {
  const parsed = parsePhoneNumberFromString(phone);
  if (!parsed) return phone;
  return parsed.countryCallingCode === '1' ? parsed.formatNational() : parsed.formatInternational();
}

/**
 * The outreach text as sent. A Canadian number gets "{brokerage}, {our
 * number}. Reply STOP to opt out." on every text; any other number gets the
 * brand (when the text lacks it) and the STOP line on the first text to it.
 */
export function withOutreachFooter(input: { text: string; brokerage: string; ourNumber: string; canadian: boolean; firstText: boolean }): string {
  const { text, brokerage, ourNumber, canadian, firstText } = input;
  if (!canadian && !firstText) return text;
  const stop = hasOptOutLine(text) ? '' : OPT_OUT_LINE;
  if (canadian) return `${text}\n${brokerage}, ${displayNumber(ourNumber)}.${stop ? ` ${stop}` : ''}`;
  const named = text.toLowerCase().includes(brokerage.toLowerCase());
  if (named && !stop) return text;
  if (named) return `${text}\n${stop}`;
  return `${text}\n${brokerage}${stop ? `: ${stop}` : '.'}`;
}
