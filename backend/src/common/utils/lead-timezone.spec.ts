import { describe, expect, it } from 'vitest';
import { canonicalZone, contactZone, leadZone } from './lead-timezone';

const lead = (normalizedPhone: string | null, timezone: string | null = null) => leadZone({ timezone, normalizedPhone });

describe('lead time zone from the phone number', () => {
  it('a Vancouver area code is one zone, inferred, with its country and province', () => {
    const z = lead('+16045550199');
    expect(z).toMatchObject({ zone: 'America/Vancouver', status: 'inferred', source: 'phone', candidates: ['America/Vancouver'] });
    expect(z.jurisdiction).toEqual({ country: 'CA', region: 'BC', status: 'estimated' });
    expect(z.reason).toBe('from area code 604');
    expect(contactZone(z)).toBe('America/Vancouver');
  });

  it('an area code spanning two zones needs review and is not callable', () => {
    const z = lead('+17095550100');
    expect(z.status).toBe('needs_review');
    expect(z.candidates).toEqual(['America/Halifax', 'America/St_Johns']);
    expect(z.jurisdiction).toEqual({ country: 'CA', region: 'NL', status: 'estimated' });
    expect(contactZone(z)).toBeNull();
  });

  it('a toll-free number has no place, so it needs review', () => {
    const z = lead('+18005550100');
    expect(z.status).toBe('needs_review');
    expect(z.candidates.length).toBeGreaterThan(3);
    expect(z.reason).toBe('toll-free or non-geographic number');
    expect(z.jurisdiction.region).toBeNull();
  });

  it('an Indian number is inferred with the current tzdata name', () => {
    expect(lead('+919876543210')).toMatchObject({ zone: 'Asia/Kolkata', status: 'inferred', reason: 'from country code +91' });
  });

  it('a Caribbean +1 number is its own country, not the US', () => {
    const z = lead('+18765550100');
    expect(z).toMatchObject({ zone: 'America/Jamaica', status: 'inferred' });
    expect(z.jurisdiction).toEqual({ country: 'JM', region: null, status: 'estimated' });
  });

  it('no number, or one that cannot be a phone number, is unknown and has no phone', () => {
    expect(lead(null)).toMatchObject({ zone: null, status: 'unknown', source: null, hasPhone: false, reason: 'no usable phone number' });
    expect(lead('garbage')).toMatchObject({ status: 'unknown', hasPhone: false });
    expect(lead('+1604555')).toMatchObject({ status: 'unknown', hasPhone: false, jurisdiction: { country: null, region: null, status: 'unknown' } });
    expect(lead('+16045550199').hasPhone).toBe(true);
  });
});

describe('a provided time zone', () => {
  it('is verified and wins over the phone', () => {
    const z = lead('+17095550100', 'America/St_Johns');
    expect(z).toMatchObject({ zone: 'America/St_Johns', status: 'verified', source: 'provided' });
    expect(z.jurisdiction.status).toBe('estimated');
    expect(contactZone(z)).toBe('America/St_Johns');
  });

  it('is normalized, and agrees with the phone through its alias', () => {
    expect(canonicalZone(' Asia/Calcutta ')).toBe('Asia/Kolkata');
    expect(lead('+919876543210', 'Asia/Calcutta')).toMatchObject({ zone: 'Asia/Kolkata', jurisdiction: { status: 'estimated' } });
  });

  it('that contradicts the phone keeps the lead callable but marks the jurisdiction disputed', () => {
    const z = lead('+16045550199', 'America/Toronto');
    expect(z.status).toBe('verified');
    expect(z.jurisdiction).toEqual({ country: 'CA', region: 'BC', status: 'conflict' });
  });

  it('without a phone is verified on its own', () => {
    expect(lead(null, 'America/New_York')).toMatchObject({ zone: 'America/New_York', status: 'verified', jurisdiction: { country: null, status: 'unknown' } });
  });

  it('removed again falls back to the phone', () => {
    expect(lead('+16045550199', null).status).toBe('inferred');
  });

  it('that Intl cannot format is ignored, and said so', () => {
    const z = lead('+16045550199', 'Mars/Phobos');
    expect(z).toMatchObject({ zone: 'America/Vancouver', status: 'inferred', reason: 'Stored time zone is invalid; from area code 604' });
  });
});
