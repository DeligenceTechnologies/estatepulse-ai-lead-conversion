import { describe, expect, it } from 'vitest';
import { scorePairs } from './pair-scoring';

const l = (id: string, phone: string | null, email: string | null) => ({
  id,
  normalizedPhone: phone,
  normalizedEmail: email,
});

describe('scorePairs: suggestions for review', () => {
  it('same phone or same email is a strong suggestion', () => {
    const pairs = scorePairs([l('a', '+15125550188', null), l('b', '+15125550188', 'b@x.com')]);
    expect(pairs).toEqual([{ leadAId: 'a', leadBId: 'b', score: 100, reasons: ['Same phone number'] }]);
  });

  it('a phone stored in another format still matches', () => {
    const pairs = scorePairs([l('a', '+1 512 555 0188', null), l('b', '+15125550188', null)]);
    expect(pairs[0]).toMatchObject({ score: 100 });
  });

  it('the same Gmail inbox written two ways', () => {
    const pairs = scorePairs([l('a', null, 'a.na@gmail.com'), l('b', null, 'ana+x@gmail.com')]);
    expect(pairs[0]).toMatchObject({ score: 80 });
  });

  it('the same number under a different country code', () => {
    const pairs = scorePairs([l('a', '+15125550188', null), l('b', '+445125550188', null)]);
    expect(pairs.find((p) => p.reasons.includes('Same number with a different country code'))).toBeTruthy();
  });

  it('nothing short of the same phone or email: a shared email name or similar number is not a pair', () => {
    expect(scorePairs([l('a', null, 'x@a.com'), l('b', null, 'y@b.com')])).toEqual([]);
    expect(scorePairs([l('a', null, 'ana.lee@a.com'), l('b', null, 'ana.lee@b.com')])).toEqual([]);
    expect(scorePairs([l('a', '+15125550188', null), l('b', '+15135550188', null)])).toEqual([]);
  });

  it('focus limits it to one lead', () => {
    const leads = [l('a', '+15125550188', null), l('b', '+15125550188', null), l('c', '+15125550188', null)];
    expect(scorePairs(leads, 'c').map((p) => [p.leadAId, p.leadBId])).toEqual([
      ['a', 'c'],
      ['b', 'c'],
    ]);
  });
});
