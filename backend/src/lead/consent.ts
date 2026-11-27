import { ConsentStatus, type Prisma } from '@prisma/client';

/**
 * A lead typed in by hand without its consent box ticked. It waits in Import
 * Review ("Consent needed"), paused and out of every lead list, until the owner
 * records the consent (it then joins outreach like any lead) or rejects it.
 */
export const CONSENT_REVIEW_REASON = 'Added manually without consent to be contacted';

export const AWAITING_CONSENT_REVIEW = { reviewReasons: { has: CONSENT_REVIEW_REASON } } satisfies Prisma.LeadWhereInput;

/**
 * Who the AI may reach. A lead that came in by itself (a form, a webhook, a CRM, a sheet) filled in its
 * own details, so a pending consent does not hold it back. A lead typed in by hand without consent is
 * held by consent review instead (paused, CONSENT_REVIEW_REASON) until the owner records it. A lead who
 * withdrew consent is never contacted, whichever way it came in: the strategy, sequences and resume all
 * skip it.
 */
export const MAY_CONTACT = { consentStatus: { not: ConsentStatus.revoked } } satisfies Prisma.LeadWhereInput;

export const mayContact = (lead: { consentStatus: ConsentStatus }): boolean => lead.consentStatus !== ConsentStatus.revoked;

/** Why the AI does not reach a lead who withdrew consent, in the words shown on its timeline. */
export const CONSENT_WITHDRAWN = 'The lead withdrew consent to be contacted';
