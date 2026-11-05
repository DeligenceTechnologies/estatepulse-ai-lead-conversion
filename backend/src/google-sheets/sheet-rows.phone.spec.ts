import { describe, expect, test } from 'vitest';
import { PHONE_UNPARSED_REASON, buildRow } from './sheet-rows';

/** One sheet row: a name, a phone, and an optional email column. */
const row = (phone: string, email = '') =>
  buildRow(['Manish', phone, email], 2, {
    headerIndex: new Map([
      ['name', 0],
      ['phone', 1],
      ['email', 2],
    ]),
    labels: new Map([
      ['name', 'Name'],
      ['phone', 'Phone'],
      ['email', 'Email'],
    ]),
    mappings: [
      { source_field_key: 'name', target_field: 'first_name', transform: { kind: 'text', maxLen: 100 } },
      { source_field_key: 'phone', target_field: 'phone', transform: { kind: 'phone_e164' } },
      { source_field_key: 'email', target_field: 'email', transform: { kind: 'email' } },
    ],
    identity: { mode: 'fallback' },
  });

describe('a phone number with no country code', () => {
  test('is never silently turned into another country’s number', () => {
    const built = row('9024848980', 'manish@example.test');
    expect(built.lead?.phone).toBe('9024848980');
    expect(built.lead?.normalized_phone).toBeNull();
  });

  test('cannot be dialled: the outreach runner skips a row with no normalized phone', () => {
    expect(row('9024848980', 'manish@example.test').lead?.phone_valid).toBe(false);
  });

  test('is flagged, so it waits in Import Review instead of being approved on arrival', () => {
    const built = row('9024848980', 'manish@example.test');
    expect(built.reviewReasons).toContain(PHONE_UNPARSED_REASON);
    expect(built.reviewReasons.join(' ')).toMatch(/no country code/);
  });

  // With no email either there is nothing to reach the person by, so the row is held out of
  // the import — but under its own name, not "no usable phone or email": there IS a number,
  // it just does not say which country it is from. The sheet keeps the row, so adding the
  // code and syncing again brings the lead in. Nothing is lost.
  test('with no email either, the row is held out under its own reason', () => {
    const built = row('9024848980');
    expect(built.issue).toBe('PHONE_NO_COUNTRY_CODE');
    expect(built.lead).toBeUndefined();
  });

  test('a genuinely broken number is still just "no usable contact", not a missing code', () => {
    expect(row('+91 123').issue).toBe('NO_CONTACT');
    expect(row('').issue).toBe('NO_CONTACT');
  });
});

describe('a sheet that mixes countries', () => {
  test('keeps every number that carries its own country code', () => {
    expect(row('+91 90248 48980').lead?.normalized_phone).toBe('+919024848980');
    expect(row('+1 512 555 0188').lead?.normalized_phone).toBe('+15125550188');
    expect(row('+44 20 7946 0958').lead?.normalized_phone).toBe('+442079460958');
    expect(row('+971 50 123 4567').lead?.normalized_phone).toBe('+971501234567');
  });

  test('a row that carries its code is clean: no flag, dialable', () => {
    const built = row('+91 90248 48980');
    expect(built.reviewReasons).toEqual([]);
    expect(built.lead?.phone_valid).toBe(true);
  });
});
