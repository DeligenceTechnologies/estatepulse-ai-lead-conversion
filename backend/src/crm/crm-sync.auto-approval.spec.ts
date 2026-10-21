import { describe, expect, it } from 'vitest';
import { PHONE_UNPARSED_REASON } from '@/google-sheets/sheet-rows';
import { CRM_PROVIDER_LABELS, HUBSPOT_PROVIDER, crmImportReviewReason } from './crm-records';
import { isCleanCrmLead } from './crm-sync.service';

const importReason = crmImportReviewReason(CRM_PROVIDER_LABELS[HUBSPOT_PROVIDER]);
const complete: Parameters<typeof isCleanCrmLead>[0] = {
  firstName: 'Maya',
  normalizedEmail: 'maya@example.com',
  normalizedPhone: '+14155552671',
  dncStatus: false,
  reviewReasons: [importReason],
};
const clean = (over: Partial<typeof complete> = {}) => isCleanCrmLead({ ...complete, ...over }, importReason);

describe('isCleanCrmLead (HubSpot contacts that skip Import Review)', () => {
  it('passes a contact with a name, a valid email and phone, and only the import reason', () => {
    expect(clean()).toBe(true);
    expect(clean({ reviewReasons: [] })).toBe(true);
  });

  it('keeps a contact missing a name, email or phone for review', () => {
    expect(clean({ firstName: null })).toBe(false);
    expect(clean({ normalizedEmail: null })).toBe(false);
    expect(clean({ normalizedPhone: null })).toBe(false);
  });

  it('keeps do-not-contact and anything flagged for review', () => {
    expect(clean({ dncStatus: true })).toBe(false);
    expect(clean({ reviewReasons: [importReason, 'Possible duplicate: another lead has the same phone or email'] })).toBe(false);
    expect(clean({ reviewReasons: [importReason, PHONE_UNPARSED_REASON] })).toBe(false);
    expect(clean({ reviewReasons: [importReason, 'Email: "x" does not look like an email'] })).toBe(false);
  });
});
