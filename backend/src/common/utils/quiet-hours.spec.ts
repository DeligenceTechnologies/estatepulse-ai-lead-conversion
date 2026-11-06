import { describe, expect, it } from 'vitest';
import { leadZone } from './lead-timezone';
import { nextAllowedAt, nextContactAt, nextLeadContactAt, nextLocalMidnight, quietHoursOf, weekdayOf } from './quiet-hours';

const TZ = 'Asia/Kolkata';
const QUIET = { start: '21:00', end: '08:00' };

describe('contact window', () => {
  it('reads the weekday and the next midnight in the organization time zone', () => {
    const at = new Date('2026-10-31T19:00:00.000Z'); // Sun 1 Nov 00:30 Kolkata
    expect(weekdayOf(TZ, at)).toBe(0);
    expect(nextLocalMidnight(TZ, new Date('2026-10-31T12:00:00.000Z'))).toEqual(new Date('2026-10-31T18:30:00.000Z'));
  });

  it('without skip days it is just the quiet hours', () => {
    expect(nextContactAt(TZ, QUIET, [], new Date('2026-10-27T06:00:00.000Z'))).toEqual(new Date('2026-10-27T06:00:00.000Z'));
    expect(nextContactAt(TZ, QUIET, undefined, new Date('2026-10-27T16:00:00.000Z'))).toEqual(new Date('2026-10-28T02:30:00.000Z'));
  });

  it('a skipped Sunday moves to Monday at the start of calling hours', () => {
    const saturdayNight = new Date('2026-10-31T16:00:00.000Z'); // Sat 21:30 Kolkata
    expect(nextContactAt(TZ, QUIET, [0], saturdayNight)).toEqual(new Date('2026-11-02T02:30:00.000Z')); // Mon 08:00
    const sundayNoon = new Date('2026-11-01T06:30:00.000Z');
    expect(nextContactAt(TZ, QUIET, [0], sundayNoon)).toEqual(new Date('2026-11-02T02:30:00.000Z'));
  });

  it('a whole skipped weekend, and no quiet hours at all', () => {
    const fridayNight = new Date('2026-10-30T17:00:00.000Z'); // Fri 22:30 Kolkata
    expect(nextContactAt(TZ, QUIET, [0, 6], fridayNight)).toEqual(new Date('2026-11-02T02:30:00.000Z'));
    expect(nextContactAt(TZ, undefined, [0], new Date('2026-11-01T06:30:00.000Z'))).toEqual(new Date('2026-11-01T18:30:00.000Z')); // Mon 00:00
  });

  it('every day skipped is treated as none, so a lead is never parked forever', () => {
    const at = new Date('2026-10-27T06:00:00.000Z');
    expect(nextContactAt(TZ, QUIET, [0, 1, 2, 3, 4, 5, 6], at)).toEqual(at);
  });

  it('the end of quiet hours is exact across a DST change', () => {
    // Los Angeles: clocks go forward on 8 Mar 2026 and back on 1 Nov 2026.
    expect(nextAllowedAt('America/Los_Angeles', QUIET, new Date('2026-03-08T07:00:00.000Z'))).toEqual(new Date('2026-03-08T15:00:00.000Z')); // Sat 23:00 PST -> Sun 08:00 PDT
    expect(nextAllowedAt('America/Los_Angeles', QUIET, new Date('2026-11-01T06:00:00.000Z'))).toEqual(new Date('2026-11-01T16:00:00.000Z')); // Sat 23:00 PDT -> Sun 08:00 PST
  });
});

// Leads by phone: Vancouver (CA/BC), Austin (US/TX), Toronto (CA/ON), Miami (US/FL), Los Angeles (US/CA), Providence (US/RI).
// tzdata 2026c keeps British Columbia on UTC-7 all year from November 2026, so Vancouver's clock is no longer Los Angeles's.
const vancouver = leadZone({ timezone: null, normalizedPhone: '+16045550199' });
const austin = leadZone({ timezone: null, normalizedPhone: '+15125550100' });
const toronto = leadZone({ timezone: null, normalizedPhone: '+14165550100' });
const miami = leadZone({ timezone: null, normalizedPhone: '+13055550100' });
const losAngeles = leadZone({ timezone: null, normalizedPhone: '+12135550100' });
const providence = leadZone({ timezone: null, normalizedPhone: '+14015550100' });
const unknown = leadZone({ timezone: null, normalizedPhone: null });
const ORG = { quiet: QUIET, skipDays: [] as number[] };

describe("the lead's contact window", () => {
  it('a Vancouver lead at 23:00 their time waits for the morning on their clock, whatever zone the organization is in', () => {
    const late = new Date('2026-11-04T06:00:00.000Z'); // Tue 23:00 in Vancouver (UTC-7)
    // The organization opens at 08:00, but a Canadian weekday opens at 09:00 under the CRTC rules.
    expect(nextLeadContactAt(vancouver, ORG, late)).toEqual({ allowedAt: new Date('2026-11-04T16:00:00.000Z'), reason: 'Legal calling hours (CA)' });
    // The organization's zone (Kolkata, Toronto) is not an input: only its quiet-hour settings are.
    const morning = new Date('2026-11-03T17:00:00.000Z'); // Tue 10:00 Vancouver = 22:30 Kolkata = 12:00 Toronto
    expect(nextLeadContactAt(vancouver, ORG, morning)).toEqual({ allowedAt: morning, reason: null });
    const earlyEvening = new Date('2026-11-04T01:30:00.000Z'); // Tue 18:30 Vancouver = 20:30 Toronto: fine for the lead
    expect(nextLeadContactAt(vancouver, ORG, earlyEvening)).toEqual({ allowedAt: earlyEvening, reason: null });
    const lateEvening = new Date('2026-11-04T04:30:00.000Z'); // Tue 21:30 Vancouver: too late for the lead even if it were fine in Toronto
    expect(nextLeadContactAt(vancouver, ORG, lateEvening).allowedAt).toEqual(new Date('2026-11-04T16:00:00.000Z'));
  });

  it('Texas on a Sunday opens at noon; the legal window names itself', () => {
    const sundayMorning = new Date('2026-11-08T16:00:00.000Z'); // Sun 10:00 CST
    expect(nextLeadContactAt(austin, ORG, sundayMorning)).toEqual({ allowedAt: new Date('2026-11-08T18:00:00.000Z'), reason: 'Legal calling hours (US-TX)' });
    const monday = new Date('2026-11-09T16:00:00.000Z'); // Mon 10:00 CST
    expect(nextLeadContactAt(austin, ORG, monday).allowedAt).toEqual(monday);
  });

  it('Canada on a Saturday evening waits for Sunday 10:00', () => {
    const saturdayEvening = new Date('2026-11-08T00:00:00.000Z'); // Sat 19:00 EST
    expect(nextLeadContactAt(toronto, ORG, saturdayEvening)).toEqual({ allowedAt: new Date('2026-11-08T15:00:00.000Z'), reason: 'Legal calling hours (CA)' });
  });

  it('Florida closes at 20:00 even with the organization quiet hours switched off', () => {
    const lateEvening = new Date('2026-11-04T01:30:00.000Z'); // Tue 20:30 EST
    const expected = new Date('2026-11-04T13:00:00.000Z'); // Wed 08:00 EST
    expect(nextLeadContactAt(miami, ORG, lateEvening).allowedAt).toEqual(expected);
    const lawOnly = nextLeadContactAt(miami, { quiet: undefined, skipDays: [] }, lateEvening);
    expect(lawOnly.allowedAt).toEqual(expected);
    // Florida and the federal rule both reopen at 08:00; either may be named.
    expect(lawOnly.reason).toMatch(/^Legal calling hours \(US(-FL)?\)$/);
  });

  it("skip days use the lead's weekday; a callback ignores them but not the law", () => {
    const sunday = new Date('2026-11-08T17:00:00.000Z'); // Sun 10:00 Vancouver
    const rules = { quiet: QUIET, skipDays: [0] };
    expect(nextLeadContactAt(vancouver, rules, sunday)).toEqual({ allowedAt: new Date('2026-11-09T16:00:00.000Z'), reason: 'Legal calling hours (CA)' }); // Mon 09:00
    expect(nextLeadContactAt(vancouver, rules, sunday, { callback: true })).toEqual({ allowedAt: sunday, reason: null });
    // Sunday night: Sunday's window ends at 18:00, but Monday's own rules open the morning at 09:00, not at Sunday's 10:00.
    const sundayNight = new Date('2026-11-09T04:30:00.000Z'); // Sun 21:30 Vancouver
    expect(nextLeadContactAt(vancouver, rules, sundayNight, { callback: true })).toEqual({ allowedAt: new Date('2026-11-09T16:00:00.000Z'), reason: 'Legal calling hours (CA)' });
    const sundayMorningAustin = new Date('2026-11-08T16:00:00.000Z'); // Sun 10:00 CST
    expect(nextLeadContactAt(austin, ORG, sundayMorningAustin, { callback: true }).allowedAt).toEqual(new Date('2026-11-08T18:00:00.000Z'));
  });

  it('a day the law closes moves to the next open day', () => {
    const sunday = new Date('2026-11-08T17:00:00.000Z'); // Sun 12:00 EST, Rhode Island
    expect(nextLeadContactAt(providence, ORG, sunday)).toEqual({ allowedAt: new Date('2026-11-09T14:00:00.000Z'), reason: 'Legal calling hours (US-RI)' }); // Mon 09:00 EST
  });

  it('an unknown or disputed zone has no callable time', () => {
    expect(nextLeadContactAt(unknown, ORG, new Date())).toEqual({ allowedAt: null, reason: 'No usable phone number to call or text' });
    const twoZones = leadZone({ timezone: null, normalizedPhone: '+17095550100' });
    expect(nextLeadContactAt(twoZones, ORG, new Date())).toEqual({ allowedAt: null, reason: "Waiting for the lead's time zone to be set: area code 709 spans more than one time zone" });
    // A zone set by hand does not make a lead without a number contactable.
    const zoneButNoPhone = leadZone({ timezone: 'America/Toronto', normalizedPhone: null });
    expect(zoneButNoPhone.status).toBe('verified');
    expect(zoneButNoPhone.hasPhone).toBe(false);
  });

  it('a provided zone is used as soon as it is set', () => {
    const resolved = leadZone({ timezone: 'America/St_Johns', normalizedPhone: '+17095550100' });
    const evening = new Date('2026-11-04T01:00:00.000Z'); // Tue 21:30 NST
    expect(nextLeadContactAt(resolved, ORG, evening).allowedAt).toEqual(new Date('2026-11-04T12:30:00.000Z')); // Wed 09:00 NST (CRTC weekday)
  });

  it('lands on 08:00 local across both DST changes', () => {
    expect(nextLeadContactAt(losAngeles, ORG, new Date('2026-03-08T07:00:00.000Z')).allowedAt).toEqual(new Date('2026-03-08T15:00:00.000Z'));
    expect(nextLeadContactAt(losAngeles, ORG, new Date('2026-11-01T06:00:00.000Z')).allowedAt).toEqual(new Date('2026-11-01T16:00:00.000Z'));
  });

  it('always returns, even when every day is closed or skipped', () => {
    const everyDay = { quiet: QUIET, skipDays: [0, 1, 2, 3, 4, 5, 6] };
    const at = new Date('2026-11-03T18:00:00.000Z');
    expect(nextLeadContactAt(vancouver, everyDay, at)).toEqual({ allowedAt: at, reason: null });
    // Rhode Island closes Sundays and the organization skips the other six: nothing is ever open, yet the loop ends.
    const verdict = nextLeadContactAt(providence, { quiet: QUIET, skipDays: [1, 2, 3, 4, 5, 6] }, at);
    expect(verdict.allowedAt).toBeInstanceOf(Date);
  });
});

describe('the contact window cannot be switched off or broken (FU-01)', () => {
  const mumbai = leadZone({ timezone: null, normalizedPhone: '+919876543210' }); // no legal rule is modelled for India
  const OFF = { quiet: undefined, skipDays: [] as number[] };

  it('with quiet hours off, a lead no law covers still waits for 08:00 on their clock', () => {
    const lateNight = new Date('2026-11-04T18:00:00.000Z'); // Wed 23:30 in Kolkata
    expect(nextLeadContactAt(mumbai, OFF, lateNight)).toEqual({ allowedAt: new Date('2026-11-05T02:30:00.000Z'), reason: 'Default contact hours (08:00–21:00)' });
    const afternoon = new Date('2026-11-05T09:30:00.000Z'); // Thu 15:00 in Kolkata
    expect(nextLeadContactAt(mumbai, OFF, afternoon)).toEqual({ allowedAt: afternoon, reason: null });
  });

  it("the organization's quiet hours narrow the floor but never widen it", () => {
    const sevenFortyFive = new Date('2026-11-05T02:15:00.000Z'); // 07:45 in Kolkata
    expect(nextLeadContactAt(mumbai, { quiet: { start: '23:00', end: '06:00' }, skipDays: [] }, sevenFortyFive).allowedAt).toEqual(new Date('2026-11-05T02:30:00.000Z'));
    expect(nextLeadContactAt(mumbai, { quiet: { start: '20:00', end: '10:00' }, skipDays: [] }, sevenFortyFive).allowedAt).toEqual(new Date('2026-11-05T04:30:00.000Z'));
  });

  it('reads quiet hours only when they are switched on and well formed', () => {
    expect(quietHoursOf({ quietHours: { start: '21:00', end: '08:00' } })).toEqual({ start: '21:00', end: '08:00' });
    expect(quietHoursOf({ respectQuietHours: false, quietHours: { start: '21:00', end: '08:00' } })).toBeUndefined();
    // Saved before validation: read as off, so the legal hours and the floor above still hold.
    expect(quietHoursOf({ quietHours: { start: 'x', end: 'y' } })).toBeUndefined();
    expect(quietHoursOf(undefined)).toBeUndefined();
  });
});
