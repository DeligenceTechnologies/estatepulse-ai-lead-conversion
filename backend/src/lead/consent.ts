import { ConsentStatus, type Prisma } from '@prisma/client';

/**
 * A lead typed in by hand without its consent box ticked. It waits in Import
 * Review ("Consent needed"), paused and out of every lead list, until the owner
 * records the consent (it then joins outreach like any lead) or rejects it.
 */
export const CONSENT_REVIEW_REASON = 'Added manually without consent to be contacted';

export const AWAITING_CONSENT_REVIEW = { reviewReasons: { has: CONSENT_REVIEW_REASON } } satisfies Prisma.LeadWhereInput;

/**
 * Only a lead who agreed to be contacted gets the AI's calls and texts: the outreach strategy, the
 * follow-up sequences, and a resume of either. A lead still pending waits, and joins on its own
 * once its consent is recorded; one who withdrew consent is never contacted.
 */
export const MAY_CONTACT = { consentStatus: ConsentStatus.granted } satisfies Prisma.LeadWhereInput;

export const mayContact = (lead: { consentStatus: ConsentStatus }): boolean => lead.consentStatus === ConsentStatus.granted;

/** Why the AI does not reach a lead, in the words shown on the lead and its timeline. */
export const noConsentReason = (status: ConsentStatus): string =>
  status === ConsentStatus.revoked ? 'The lead withdrew consent to be contacted' : "Waiting for the lead's consent to be contacted";

