import { describe, expect, it } from 'vitest';
import { validateCanonicalValues } from './validators';
import { isValidEmail } from './transforms';

/**
 * These tests encode the one invariant that matters here: a bad answer costs
 * its own field and nothing else. If any of them start asserting that a lead
 * was rejected, the rule has been broken.
 */
describe('validateCanonicalValues', () => {
  it('passes clean values through untouched', () => {
    const r = validateCanonicalValues({
      first_name: 'Priya',
      email: 'priya.r@outlook.com',
      phone: '+15125550419',
      bedrooms: 3,
      min_budget: 500000,
      max_budget: 650000,
      timeline: '3_to_6_months',
    });

    expect(r.rejected).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.values.bedrooms).toBe(3);
    expect(r.values.timeline).toBe('3_to_6_months');
  });

  it('demotes an out-of-range bedroom count instead of storing it', () => {
    const r = validateCanonicalValues({ phone: '+15125550419', bedrooms: 78704 });

    expect(r.values.bedrooms).toBeUndefined();
    expect(r.values.phone).toBe('+15125550419'); // the rest of the lead survives
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]).toMatchObject({ field: 'bedrooms', raw: '78704' });
  });

  it('rejects an enum value it was never given, rather than coercing one', () => {
    const r = validateCanonicalValues({ timeline: 'whenever we find the right place' });

    expect(r.values.timeline).toBeUndefined();
    expect(r.rejected[0].reason).toContain('under_30_days');
  });

  it('swaps a reversed budget range', () => {
    const r = validateCanonicalValues({ min_budget: 650000, max_budget: 500000 });

    expect(r.values.min_budget).toBe(500000);
    expect(r.values.max_budget).toBe(650000);
    expect(r.warnings.join()).toMatch(/reversed/);
  });

  it('rejects a budget that would overflow the column', () => {
    const r = validateCanonicalValues({ max_budget: 1e15 });

    expect(r.values.max_budget).toBeUndefined();
    expect(r.rejected).toHaveLength(1);
  });

  it('truncates an overlong answer rather than failing the insert', () => {
    const r = validateCanonicalValues({ location: 'Round Rock, '.repeat(100) });

    expect((r.values.location as string).length).toBe(255);
    expect(r.warnings.join()).toMatch(/truncated/);
  });

  it('keeps an unusable email but warns, so it can still be read by a human', () => {
    const r = validateCanonicalValues({ email: 'n/a' });

    expect(r.values.email).toBe('n/a');
    expect(r.warnings.join()).toMatch(/does not look like an email/);
  });

  it('never rejects the whole set when one field is bad', () => {
    const r = validateCanonicalValues({
      first_name: 'Marcus',
      phone: '+15125550142',
      bedrooms: -4,
      timeline: 'nonsense',
    });

    expect(r.values.first_name).toBe('Marcus');
    expect(r.values.phone).toBe('+15125550142');
    expect(r.rejected.map((x) => x.field).sort()).toEqual(['bedrooms', 'timeline']);
  });
});

/**
 * The predicate that decides whether an address may act as an identity.
 * `createLead` calls the same function, which is the point.
 */
describe('isValidEmail', () => {
  it.each(['priya.r@outlook.com', 'b.hayes+tag@example.co.uk', 'A@B.IO'])('accepts %s', (v) => {
    expect(isValidEmail(v)).toBe(true);
  });

  // Every one of these is a real thing people type into a required email box,
  // and every one of them used to become a shared merge key.
  it.each(['n/a', 'none', '-', 'asdf', 'no thanks', 'test@test', '@example.com', ''])(
    'rejects %s',
    (v) => {
      expect(isValidEmail(v)).toBe(false);
    },
  );
});
