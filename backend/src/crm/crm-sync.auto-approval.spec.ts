import { describe, expect, it } from 'vitest';
import { CRM_PROVIDER_LABELS, HUBSPOT_PROVIDER, buildCrmRow, type CrmContact } from './crm-records';
import { autoApproval } from './crm-sync.service';

const label = CRM_PROVIDER_LABELS[HUBSPOT_PROVIDER];
const clean: CrmContact = {
  externalId: '101',
  firstName: 'Maya',
  lastName: 'Reyes',
  email: 'maya@example.com',
  phone: '+1 415 555 2671',
  extra: {},
};
const row = (over: Partial<CrmContact> = {}) => buildCrmRow(HUBSPOT_PROVIDER, label, { ...clean, ...over }, 'US');
const noFlags = { dnc: false, duplicate: false };
const approves = (r: ReturnType<typeof row>, flags = noFlags, createdSinceConnect = new Set([r.externalId!])) =>
  autoApproval(createdSinceConnect).rule(r, flags);

describe('autoApproval (HubSpot contacts that skip Import Review)', () => {
  it('approves a clean contact created after the connection, as the system', () => {
    expect(approves(row())).toBe(true);
    expect(autoApproval(new Set()).by).toEqual({ userId: null });
  });

  it('leaves contacts that were already in HubSpot for review', () => {
    expect(approves(row(), noFlags, new Set())).toBe(false);
  });

  it('needs a first name, a valid email and a dialable phone', () => {
    expect(approves(row({ firstName: null }))).toBe(false);
    expect(approves(row({ firstName: null, lastName: null }))).toBe(false);
    expect(approves(row({ email: null }))).toBe(false);
    expect(approves(row({ email: 'not-an-email' }))).toBe(false);
    expect(approves(row({ phone: null }))).toBe(false);
    expect(approves(row({ phone: '12' }))).toBe(false);
  });

  it('leaves possible duplicates and do-not-contact matches for review', () => {
    expect(approves(row(), { dnc: false, duplicate: true })).toBe(false);
    expect(approves(row(), { dnc: true, duplicate: false })).toBe(false);
  });

  it('leaves a row with anything flagged on it for review', () => {
    const flagged = { ...row(), reviewReasons: ['Phone: something looked off'] };
    expect(approves(flagged)).toBe(false);
  });
});
