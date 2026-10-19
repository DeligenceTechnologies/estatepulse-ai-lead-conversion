import { describe, expect, it } from 'vitest';
import { HUBSPOT_CONTACT_PROPERTIES, modifiedAtMs, toCrmContact } from './hubspot-contacts';

describe('toCrmContact createdAt', () => {
  it('asks HubSpot for the created date on every read', () => {
    expect(HUBSPOT_CONTACT_PROPERTIES).toContain('createdate');
  });

  it('reads epoch-ms digits and ISO dates', () => {
    expect(toCrmContact({ id: '1', properties: { createdate: '1760000000000' } }).createdAt).toBe(1760000000000);
    expect(toCrmContact({ id: '1', properties: { createdate: '2026-10-19T10:00:00.000Z' } }).createdAt).toBe(Date.parse('2026-10-19T10:00:00.000Z'));
  });

  it('is null when HubSpot sent none or an unreadable one', () => {
    expect(toCrmContact({ id: '1', properties: {} }).createdAt).toBeNull();
    expect(toCrmContact({ id: '1', properties: { createdate: 'not a date' } }).createdAt).toBeNull();
  });

  it('never reaches the lead: extra stays the two labelled HubSpot fields', () => {
    const c = toCrmContact({ id: '1', properties: { createdate: '1760000000000', lifecyclestage: 'lead' } });
    expect(Object.keys(c.extra)).toEqual(['HubSpot lifecycle stage', 'HubSpot lead status']);
  });

  it('modifiedAtMs still reads the modified date', () => {
    expect(modifiedAtMs({ id: '1', properties: { lastmodifieddate: '1760000000000' } })).toBe(1760000000000);
    expect(modifiedAtMs({ id: '1', updatedAt: '2026-10-19T10:00:00.000Z' })).toBe(Date.parse('2026-10-19T10:00:00.000Z'));
    expect(modifiedAtMs({ id: '1' })).toBe(0);
  });
});
