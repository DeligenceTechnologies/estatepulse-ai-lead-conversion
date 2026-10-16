import { describe, expect, it } from 'vitest';
import { PHONE_UNPARSED_REASON } from '../google-sheets/sheet-rows';
import { extractDelivery, previewLead } from './extract';
import { expandFields, type MappingField } from './mapping';

const fields: MappingField[] = [
  { path: 'name', target: 'full_name' },
  { path: 'contact.phone', target: 'phone' },
  { path: 'contact.email', target: 'email' },
  { path: 'budget', target: 'budget_range' },
  { path: 'beds', target: 'bedrooms' },
  { path: 'notes', target: 'motivation' },
  { path: 'consent', target: 'consent_status' },
  { path: 'meta.utm', target: 'utm_source' },
  { path: 'meta.source', target: '__custom__', customName: 'Source' },
];
const rows = expandFields(fields, 'US');

const payload = {
  name: 'Ann Lee',
  contact: { phone: '(512) 555-0101', email: 'Ann@Example.COM' },
  budget: '400k-500k',
  beds: '3',
  notes: 'wants a yard',
  consent: 'yes',
  meta: { utm: 'facebook', source: 'fb-ads', ignored: 'x' },
};

describe('extractDelivery', () => {
  it('reads exactly the mapped paths, one answer per path, custom ones under a prefixed key', () => {
    const d = extractDelivery(payload, rows);
    expect(d.eventType).toBe('custom.delivery');
    expect(d.answers.map((a) => [a.key, a.label, a.scalarText])).toEqual([
      ['name', 'name', 'Ann Lee'],
      ['contact.phone', 'contact.phone', '(512) 555-0101'],
      ['contact.email', 'contact.email', 'Ann@Example.COM'],
      ['budget', 'budget', '400k-500k'],
      ['beds', 'beds', '3'],
      ['notes', 'notes', 'wants a yard'],
      ['consent', 'consent', 'yes'],
      ['meta.utm', 'meta.utm', 'facebook'],
      ['__custom__:meta.source', 'Source', 'fb-ads'],
    ]);
    expect(d.answers.find((a) => a.key === 'name')?.textValues).toEqual(['Ann Lee']);
  });

  it('reads a missing path as an empty answer rather than failing', () => {
    const d = extractDelivery({ name: 'Solo' }, rows);
    const phone = d.answers.find((a) => a.key === 'contact.phone')!;
    expect(phone.scalarText).toBe('');
    expect(phone.textValues).toEqual([]);
  });

  it('copes with a payload that is not an object', () => {
    expect(extractDelivery(null, rows).answers.every((a) => a.scalarText === '')).toBe(true);
  });
});

describe('previewLead', () => {
  it('shows the lead the worker would create: normalized, validated, extras kept', () => {
    const p = previewLead(payload, rows, 'US');
    expect(p.wouldCreate).toBe(true);
    expect(p.status).toBe('new');
    expect(p.values).toEqual({
      first_name: 'Ann',
      last_name: 'Lee',
      phone: '+15125550101',
      email: 'ann@example.com',
      min_budget: 400000,
      max_budget: 500000,
      bedrooms: 3,
      motivation: 'wants a yard',
      consent_status: true,
      utm_source: 'facebook',
    });
    expect(p.customFields).toEqual({ Source: 'fb-ads' });
    expect(p.warnings).toEqual([]);
    expect(p.reviewReasons).toEqual([]);
    expect(p.trace.find((t) => t.target === 'phone')).toEqual({ path: 'contact.phone', target: 'phone', value: '+15125550101' });
  });

  it('would create nothing without a phone or an email', () => {
    const p = previewLead({ name: 'Nobody' }, rows, 'US');
    expect(p.wouldCreate).toBe(false);
    expect(p.status).toBeNull();
  });

  it('flags an unparseable phone and demotes a bad number to an extra field', () => {
    const p = previewLead({ name: 'Ann', contact: { phone: '12345' }, beds: 'lots' }, rows, 'US');
    expect(p.wouldCreate).toBe(true);
    expect(p.status).toBe('invalid');
    expect(p.values.phone).toBe('12345');
    expect(p.reviewReasons).toContain(PHONE_UNPARSED_REASON);
    expect(p.values.bedrooms).toBeUndefined();
    expect(p.warnings.some((w) => /beds/.test(w))).toBe(true);
  });
});
