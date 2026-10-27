import { describe, expect, it } from 'vitest';
import { nextContactAt, nextLocalMidnight, weekdayOf } from './quiet-hours';

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
});
