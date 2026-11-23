import { describe, expect, it } from 'vitest';
import { decideMatch } from './lead-intake.service';

const lead = (id: string, phone: string | null, email: string | null) => ({ id, normalizedPhone: phone, normalizedEmail: email });
const P = '+15125550188';
const E = 'ana@example.com';

/** Leads are passed newest first, as findExact loads them. */
describe('decideMatch: which existing lead a submission belongs to', () => {
  it('nothing shared: a new lead', () => {
    expect(decideMatch(P, E, [])).toEqual({ kind: 'none' });
  });

  it('same phone: attaches by phone, even when the email differs or is new', () => {
    expect(decideMatch(P, 'other@x.com', [lead('a', P, 'ana@old.com')])).toEqual({ kind: 'match', leadId: 'a', by: 'phone' });
    expect(decideMatch(P, null, [lead('a', P, null)])).toEqual({ kind: 'match', leadId: 'a', by: 'phone' });
  });

  it('several old duplicates share the phone: the one with the email too, else the newest', () => {
    expect(decideMatch(P, E, [lead('new', P, null), lead('old', P, E)])).toEqual({ kind: 'match', leadId: 'old', by: 'phone' });
    expect(decideMatch(P, null, [lead('new', P, null), lead('old', P, null)])).toEqual({ kind: 'match', leadId: 'new', by: 'phone' });
  });

  it('the phone is one lead and the email another: a person decides', () => {
    expect(decideMatch(P, E, [lead('a', P, null), lead('b', '+15125550199', E)])).toEqual({ kind: 'conflict', leadIds: ['a', 'b'] });
  });

  it('same email: attaches when that lead has no other phone', () => {
    expect(decideMatch(null, E, [lead('a', '+15125550199', E)])).toEqual({ kind: 'match', leadId: 'a', by: 'email' });
    expect(decideMatch(P, E, [lead('a', null, E)])).toEqual({ kind: 'match', leadId: 'a', by: 'email' });
  });

  it('same email, different phone: could be a household sharing an inbox, so not automatic', () => {
    expect(decideMatch(P, E, [lead('a', '+15125550199', E)])).toEqual({ kind: 'conflict', leadIds: ['a'] });
  });
});
