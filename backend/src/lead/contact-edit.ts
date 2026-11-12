import parsePhoneNumberFromString from 'libphonenumber-js';
import { AppError } from '@/common/errors/app-error';
import { isValidEmail } from '@/ingest/processing/transforms';

/** Lead contact fields a person may correct from Import Review, by the lead field each one fills. */
export const CONTACT_EDIT_TARGETS = ['first_name', 'last_name', 'phone', 'email', 'timezone'] as const;
export type ContactEditTarget = (typeof CONTACT_EDIT_TARGETS)[number];

export interface ContactEditInput {
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  timezone?: string;
}

const INPUT_TARGET = { firstName: 'first_name', lastName: 'last_name', phone: 'phone', email: 'email', timezone: 'timezone' } as const;

/**
 * The values to write back to a lead's source, by target: only the ones sent, trimmed, the phone in
 * E.164. Checked as a person typing them can fix them, before anything leaves EstatePulse — the same
 * rules whether the source is a sheet or a CRM.
 */
export function validatedContactEdit(input: ContactEditInput, lead: { phone: string | null; email: string | null }): Map<ContactEditTarget, string> {
  const out = new Map<ContactEditTarget, string>();
  for (const [key, target] of Object.entries(INPUT_TARGET) as [keyof ContactEditInput, ContactEditTarget][]) {
    const raw = input[key];
    if (raw === undefined) continue;
    out.set(target, raw.trim());
  }

  const phone = out.get('phone');
  if (phone) {
    // No country is assumed from the digits: the same ten digits are a number in dozens of countries.
    const parsed = parsePhoneNumberFromString(phone);
    if (!parsed?.isValid()) {
      throw new AppError('VALIDATION_ERROR', `"${phone}" is not a phone number we can dial. Start with the country code, e.g. +1 415 555 0100.`);
    }
    out.set('phone', parsed.number);
  }
  const email = out.get('email');
  if (email && !isValidEmail(email)) throw new AppError('VALIDATION_ERROR', `"${email}" does not look like an email address.`);
  if (out.get('first_name') === '') throw new AppError('VALIDATION_ERROR', 'A lead needs a first name.');

  const phoneLeft = out.has('phone') ? out.get('phone') : lead.phone;
  const emailLeft = out.has('email') ? out.get('email') : lead.email;
  if (!phoneLeft && !emailLeft) throw new AppError('VALIDATION_ERROR', 'A lead needs a phone number or an email address.');
  return out;
}
