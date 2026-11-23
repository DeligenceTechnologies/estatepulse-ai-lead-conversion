import { describe, expect, it } from 'vitest';
import { canonicalEmail, nationalNumber, normalizeEmail, normalizePhone } from './identity';

describe('identity keys', () => {
  it('phones become E.164; no country is assumed', () => {
    expect(normalizePhone('+1 (512) 555-0188')).toBe('+15125550188');
    expect(normalizePhone('+15125550188')).toBe('+15125550188');
    expect(normalizePhone('5125550188')).toBeNull();
    expect(normalizePhone('+91 123')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });

  it('emails are trimmed and lowercased, and must look like one', () => {
    expect(normalizeEmail('  Ana@Example.COM ')).toBe('ana@example.com');
    expect(normalizeEmail('not an email')).toBeNull();
  });

  it('the canonical inbox drops +tags everywhere and dots only at Gmail', () => {
    expect(canonicalEmail('a.na+leads@gmail.com')).toBe('ana@gmail.com');
    expect(canonicalEmail('a.na@googlemail.com')).toBe('ana@gmail.com');
    expect(canonicalEmail('a.na+x@work.com')).toBe('a.na@work.com');
  });

  it('the national number ignores the country code', () => {
    expect(nationalNumber('+15125550188')).toBe('5125550188');
  });
});
