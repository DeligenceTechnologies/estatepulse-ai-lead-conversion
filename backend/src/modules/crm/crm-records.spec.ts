import { describe, expect, it } from 'vitest';
import { PHONE_UNPARSED_REASON } from '../google-sheets/sheet-rows';
import {
  CRM_IMPORT_REVIEW_REASONS,
  CRM_INBOUND_FIELDS,
  CRM_OUTBOUND_FIELDS,
  CRM_PROVIDER_LABELS,
  ESTATEPULSE_OWNED_FIELDS,
  HUBSPOT_PROVIDER,
  buildCrmRow,
  crmMerge,
  crmOwnedHash,
  crmRowKey,
  crmValuesOf,
  mergeCrmCustom,
  type CrmContact,
  type CrmValues,
} from './crm-records';

const LABEL = CRM_PROVIDER_LABELS[HUBSPOT_PROVIDER];
const contact = (over: Partial<CrmContact> = {}): CrmContact => ({
  externalId: '101',
  firstName: 'Jane',
  lastName: 'Doe',
  email: 'jane@example.com',
  phone: '512-555-0101',
  extra: {},
  ...over,
});
const build = (over: Partial<CrmContact> = {}) => buildCrmRow(HUBSPOT_PROVIDER, LABEL, contact(over), 'US');

describe('the ownership policy', () => {
  it('lets a CRM fill only the four contact fields, and writes nothing back', () => {
    expect([...CRM_INBOUND_FIELDS]).toEqual(['first_name', 'last_name', 'email', 'phone']);
    expect(CRM_OUTBOUND_FIELDS).toEqual([]);
  });

  it('keeps status, temperature, DNC, consent, assignment and location EstatePulse’s', () => {
    for (const f of ['status', 'temperature', 'dnc_status', 'consent_status', 'automation_paused', 'takeover_user_id', 'location', 'min_budget']) {
      expect(ESTATEPULSE_OWNED_FIELDS).toContain(f);
    }
    for (const f of CRM_INBOUND_FIELDS) expect(ESTATEPULSE_OWNED_FIELDS).not.toContain(f);
  });

  it('gives each CRM its own import reason', () => {
    expect(CRM_IMPORT_REVIEW_REASONS).toEqual(['Imported from HubSpot — awaiting owner approval']);
  });
});

describe('buildCrmRow', () => {
  it('normalises the way every other import does: trimmed names, a lower-cased email key, an E.164 phone', () => {
    const r = build({ firstName: '  Jane ', lastName: ' Doe  ', email: '  Jane@Example.COM ', phone: ' (512) 555-0101 ' });
    expect(r.issue).toBeUndefined();
    expect(r.lead).toMatchObject({
      first_name: 'Jane',
      last_name: 'Doe',
      email: 'jane@example.com',
      normalized_email: 'jane@example.com',
      email_valid: true,
      phone: '+15125550101',
      normalized_phone: '+15125550101',
      phone_valid: true,
    });
    expect(r.externalId).toBe('101');
    expect(r.crmPrefix).toBe('HubSpot ');
    expect(r.rowNumber).toBe(1);
  });

  it('treats empty strings, whitespace and null alike, and never invents a value', () => {
    const r = build({ email: '   ', phone: null, firstName: '' });
    expect(r.issue).toBe('NO_CONTACT');
    const withPhone = build({ email: null, phone: '512-555-0101' });
    expect(withPhone.lead!.email).toBeNull();
    expect(withPhone.lead!.normalized_email).toBeNull();
  });

  it('refuses a contact with neither a dialable phone nor a valid email — but still knows its key', () => {
    const r = build({ email: 'not-an-email', phone: '12' });
    expect(r.issue).toBe('NO_CONTACT');
    expect(r.key).toBe(crmRowKey(HUBSPOT_PROVIDER, 'contact', '101'));
  });

  it('imports a contact with an email and no name, with a reason to check who it is', () => {
    const r = build({ firstName: null, lastName: null, phone: null });
    expect(r.issue).toBeUndefined();
    expect(r.reviewReasons.some((x) => x.startsWith('No name in HubSpot'))).toBe(true);
  });

  it('keeps an unparseable phone, flagged so it is never auto-dialled', () => {
    const r = build({ phone: '555-CALL-ME' });
    expect(r.lead!.phone).toBe('555-CALL-ME');
    expect(r.lead!.normalized_phone).toBeNull();
    expect(r.reviewReasons).toContain(PHONE_UNPARSED_REASON);
  });

  it('never fills an EstatePulse-owned column', () => {
    const r = build();
    expect(r.lead).toMatchObject({ location: null, min_budget: null, max_budget: null, bedrooms: null, motivation: null });
  });

  it('keeps only the provider’s namespaced extras, and drops empty ones', () => {
    const r = build({ extra: { 'HubSpot lifecycle stage': 'Lead', 'HubSpot lead status': null, 'Something else': 'x' } });
    expect(r.lead!.custom_fields).toEqual({ 'HubSpot lifecycle stage': 'Lead' });
  });

  it('hashes equal for equal content and differently for a real change', () => {
    expect(build().hash).toBe(build().hash);
    expect(build({ lastName: 'Smith' }).hash).not.toBe(build().hash);
    expect(build({ extra: { 'HubSpot lifecycle stage': 'Customer' } }).hash).not.toBe(build().hash);
  });
});

describe('crmRowKey', () => {
  it('is one key per (provider, object type, record id)', () => {
    expect(crmRowKey('HUBSPOT', 'contact', '1')).toBe(crmRowKey('HUBSPOT', 'contact', '1'));
    expect(crmRowKey('HUBSPOT', 'contact', '1')).not.toBe(crmRowKey('HUBSPOT', 'contact', '2'));
    expect(crmRowKey('HUBSPOT', 'contact', '1')).not.toBe(crmRowKey('PIPEDRIVE', 'contact', '1'));
    expect(crmRowKey('HUBSPOT', 'contact', '1')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('crmOwnedHash', () => {
  it('reads the same from the incoming contact and from the lead it was written to', () => {
    const r = build({ extra: { 'HubSpot lifecycle stage': 'Lead' } });
    const leadRow = { ...r.lead!, custom_fields: { ...r.lead!.custom_fields, 'Notes (from a form)': 'call after 5' } };
    // Other sources' custom fields are not the CRM's state.
    expect(crmOwnedHash(leadRow, 'HubSpot ')).toBe(r.hash);
  });
});

describe('mergeCrmCustom', () => {
  it('replaces the CRM’s keys and keeps everyone else’s', () => {
    expect(
      mergeCrmCustom({ 'HubSpot lifecycle stage': 'Lead', 'HubSpot old': 'gone', Budget: '500k' }, { 'HubSpot lifecycle stage': 'Customer' }, 'HubSpot '),
    ).toEqual({ Budget: '500k', 'HubSpot lifecycle stage': 'Customer' });
  });
});

describe('crmMerge — the field-level three-way merge', () => {
  const v = (over: Partial<CrmValues> = {}): CrmValues => ({
    first_name: 'Jane',
    last_name: 'Doe',
    email: 'jane@example.com',
    phone: '+15125550101',
    custom: {},
    ...over,
  });

  it('applies a field changed only in the CRM', () => {
    expect(crmMerge(v(), v(), v({ last_name: 'Smith' }))).toEqual({ apply: ['last_name'], conflicts: [] });
  });

  it('holds a field changed on both sides, to different values', () => {
    expect(crmMerge(v(), v({ phone: '+15125550199' }), v({ phone: '+15125550123' }))).toEqual({ apply: [], conflicts: ['phone'] });
  });

  it('does nothing when both sides already agree, or the CRM did not change it', () => {
    expect(crmMerge(v(), v({ last_name: 'Smith' }), v({ last_name: 'Smith' }))).toEqual({ apply: [], conflicts: [] });
    expect(crmMerge(v(), v({ last_name: 'Edited here' }), v())).toEqual({ apply: [], conflicts: [] });
  });

  it('never lets an empty CRM value clear one', () => {
    expect(crmMerge(v(), v(), v({ phone: null, email: '' }))).toEqual({ apply: [], conflicts: [] });
  });

  it('fills a field the lead has no value for', () => {
    expect(crmMerge(v(), v({ phone: null }), v({ phone: '+15125550123' }))).toEqual({ apply: ['phone'], conflicts: [] });
  });

  it('compares an email by case, and a phone by its normalised number rather than its formatting', () => {
    expect(crmMerge(v(), v({ email: 'JANE@example.com' }), v())).toEqual({ apply: [], conflicts: [] });
    const lead = { first_name: 'Jane', last_name: 'Doe', email: 'jane@example.com', custom_fields: {} };
    const ours = crmValuesOf({ ...lead, phone: '(512) 555-0101', normalized_phone: '+15125550101' }, 'HubSpot ');
    const theirs = crmValuesOf(build({ phone: '512.555.0101' }).lead!, 'HubSpot ');
    expect(crmMerge(v(), ours, theirs)).toEqual({ apply: [], conflicts: [] });
    // An unparseable number still compares by its digits.
    expect(crmMerge(v({ phone: 'ext 12-34' }), v({ phone: 'ext 1234' }), v({ phone: 'ext 12 34' }))).toEqual({ apply: [], conflicts: [] });
  });

  it('with no base (a lead just linked by email): fills blanks, and holds every real difference', () => {
    const ours = crmValuesOf({ first_name: 'Janet', last_name: null, email: 'jane@example.com', phone: null, custom_fields: {} }, 'HubSpot ');
    expect(crmMerge(null, ours, v())).toEqual({ apply: ['last_name', 'phone'], conflicts: ['first_name'] });
  });
});
