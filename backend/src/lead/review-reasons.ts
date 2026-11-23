import { NO_NAME_REASON_PREFIX } from '@/crm/crm-records';
import { PHONE_UNPARSED_REASON } from '@/google-sheets/sheet-rows';

/** The lead as it is now, which is what a stored reason is checked against. */
export interface ReviewFacts {
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  phoneValid: boolean;
  reviewReasons: string[];
}

/**
 * One undialable number collects a reason from every check it fails — the column validator, the
 * row builder, the importer — so a lead can carry three sentences saying the same thing. They
 * collapse into one of these, said once and said short.
 */
export const PHONE_NO_CODE_REASON = 'Phone has no country code (e.g. +91) — it cannot be dialled';
export const PHONE_UNREADABLE_REASON = 'Phone number cannot be read — it cannot be dialled';

/**
 * Left on a lead held for review when an agent corrects its phone and that was the only reason
 * it was held: the hold stays until a person approves it, so outreach never starts from an edit.
 */
export const PHONE_CORRECTED_REASON = 'Phone number was corrected by hand — approve to start outreach';

/** Every wording the pipeline uses for "this number is no good": the validator's, and the importer's. */
export const isPhoneReason = (r: string): boolean => r === PHONE_UNPARSED_REASON || r.startsWith('Phone: ');

/**
 * A review reason is written once, when a lead arrives, and never looked at again — so a reason
 * about the lead's own data goes stale the moment that data is corrected at the source. These
 * are the ones that can be checked against the lead as it is now.
 *
 * Not here on purpose: a do-not-contact note (dncStatus never goes back to false by itself, and
 * warning too much about contacting someone errs the safe way) and a possible-duplicate note
 * (confirming it needs a query, which a read of a list cannot afford).
 */
const CONTRADICTED: { matches: (reason: string) => boolean; stale: (lead: ReviewFacts) => boolean }[] = [
  // Corrected at the source and synced, or the number was taken out altogether.
  { matches: isPhoneReason, stale: (l) => l.phoneValid || !l.phone },
  // A later sync filled the name in. Matches the sheet approval's own rule (sheet-review.service).
  { matches: (r) => r.startsWith(NO_NAME_REASON_PREFIX), stale: (l) => Boolean(l.firstName ?? l.lastName) },
];

/** The stored reasons minus the ones the lead's current values disprove, each said once. */
export const liveReviewReasons = (lead: ReviewFacts): string[] => {
  const live = lead.reviewReasons.filter((r) => !CONTRADICTED.some((c) => c.matches(r) && c.stale(lead)));
  const phone = live.filter(isPhoneReason);
  if (phone.length === 0) return live;
  // Which of the two it is: what the validator said, or failing that the number itself — no
  // leading "+" is the missing-code case, the same test the import makes (transforms.ts).
  const noCode = phone.some((r) => r.includes('no country code')) || !lead.phone?.trim().startsWith('+');
  const one = noCode ? PHONE_NO_CODE_REASON : PHONE_UNREADABLE_REASON;
  return live.flatMap((r) => (!isPhoneReason(r) ? [r] : r === phone[0] ? [one] : []));
};
