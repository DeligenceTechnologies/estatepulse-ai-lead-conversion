import { apiFetch } from '../lib/api';

/**
 * Import Review's "Consent needed" tab: leads added by hand without their
 * consent box ticked. They are not called or texted, and stay out of All Leads,
 * until the owner records the consent or rejects them.
 */
const BASE = '/v1/leads/consent-review';

export interface ConsentReviewItem {
  leadId: string;
  name: string;
  phone: string | null;
  email: string | null;
  addedAt: string;
}

export const listConsentReview = () => apiFetch<{ items: ConsentReviewItem[]; total: number }>(BASE, { auth: true });

/** Records the consent: each lead becomes an ordinary lead and the AI outreach picks it up. */
export const approveConsent = (leadIds: string[]) =>
  apiFetch<{ approved: number }>(`${BASE}/approve`, { method: 'POST', auth: true, body: { leadIds } });

/** Closes the leads; they are never contacted. */
export const rejectConsent = (leadIds: string[]) =>
  apiFetch<{ rejected: number }>(`${BASE}/reject`, { method: 'POST', auth: true, body: { leadIds } });

/** How many leads wait for consent; 0 when it cannot be read (no permission, server unreachable). */
export const consentReviewCount = (): Promise<number> => listConsentReview().then((r) => r.total, () => 0);
