import { describe, expect, test } from 'vitest';
import { applyTransform, type Transform } from './transforms';

const phone = (raw: string, stored: Record<string, unknown> = {}) =>
  applyTransform({ kind: 'phone_e164', ...stored } as Transform, [raw], raw);

describe('phone_e164', () => {
  // The whole point: a country is never assumed. The same ten digits are a valid number in
  // dozens of countries, so guessing one turns a reachable lead into a wrong number that
  // still looks right. Unparsed is what flags the row and keeps it out of the dialler.
  test('a number with no country code is never guessed at', () => {
    for (const raw of ['9024848980', '9876543210', '512 555 0188', '09024848980']) {
      const out = phone(raw);
      expect(out.value).toBe(raw);
      expect(out.warning).toMatch(/no country code/);
    }
  });

  test('a region frozen into an old saved mapping cannot bring the guess back', () => {
    const out = phone('9024848980', { defaultRegion: 'US' });
    expect(out.value).toBe('9024848980');
    expect(out.warning).toMatch(/no country code/);
  });

  test('a number that carries its country code is read, whatever the country', () => {
    expect(phone('+91 90248 48980').value).toBe('+919024848980');
    expect(phone('+1 512 555 0188').value).toBe('+15125550188');
    expect(phone('  +44 20 7946 0958 ').value).toBe('+442079460958');
  });

  test('a country code that leads nowhere says so, rather than blaming the missing code', () => {
    const out = phone('+91 123');
    expect(out.value).toBe('+91 123');
    expect(out.warning).toMatch(/not a phone number we can read/);
  });

  test('an empty cell is simply empty, not a flag', () => {
    expect(phone('')).toEqual({ value: null });
  });
});
