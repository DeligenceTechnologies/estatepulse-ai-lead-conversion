import { DUPLICATE_REASON_PREFIX } from './merge-rules';

/**
 * On a new lead whose phone is one existing lead's and whose email is another's: it could not be
 * attached to either, so it was created held and a person picks (Duplicates screen). Settled — and
 * dropped from the lead — by a merge or a dismiss.
 */
export const DUPLICATE_REASON = `${DUPLICATE_REASON_PREFIX}: another lead has the same phone or email`;
