import type { Prisma } from '@prisma/client';

/**
 * A lead typed in by hand without its consent box ticked. It waits in Import
 * Review ("Consent needed"), paused and out of every lead list, until the owner
 * records the consent (it then joins outreach like any lead) or rejects it.
 */
export const CONSENT_REVIEW_REASON = 'Added manually without consent to be contacted';

export const AWAITING_CONSENT_REVIEW = { reviewReasons: { has: CONSENT_REVIEW_REASON } } satisfies Prisma.LeadWhereInput;
