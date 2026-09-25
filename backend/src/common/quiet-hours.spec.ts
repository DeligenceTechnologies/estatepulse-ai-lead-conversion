import { describe, expect, it } from 'vitest';
import { deferredResume, inQuietHours, minutesOfDay, nextAllowedAt } from './quiet-hours';

/**
 * The compliance gate. Worth pinning tightly because both failure directions
 * are bad in different ways: too permissive texts somebody at 3am, too
 * restrictive silently stalls a sequence forever.
 *
 * Times are constructed in UTC and read in America/Chicago, which is UTC-5 in
 * summer (CDT). That offset is the point — a bug here is almost always
 * something comparing UTC hours against a wall clock.
 */

const TZ = 'America/Chicago';
const QUIET = { start: '21:00', end: '08:00' };

/** 2026-07-15 is firmly inside CDT, so the offset is a stable -5. */
const atChicago = (hour: number, minute = 0) =>
  new Date(Date.UTC(2026, 6, 15, hour + 5, minute));

describe('minutesOfDay', () => {
  it('reads the wall clock in the target zone, not UTC', () => {
    expect(minutesOfDay(TZ, atChicago(14, 30))).toBe(14 * 60 + 30);
  });
});

describe('inQuietHours', () => {
  it('is false when no window is configured', () => {
    expect(inQuietHours(TZ, undefined, atChicago(3))).toBe(false);
  });

  it.each([
    ['just after the window opens', 21, 1, true],
    ['at midnight', 0, 0, true],
    ['just before it closes', 7, 59, true],
    ['exactly at the close', 8, 0, false],
    ['midday', 12, 0, false],
    ['exactly at the open', 21, 0, true],
    ['just before it opens', 20, 59, false],
  ])('%s', (_label, h, m, expected) => {
    expect(inQuietHours(TZ, QUIET, atChicago(h, m))).toBe(expected);
  });

  it('handles a window that does not wrap midnight', () => {
    const lunch = { start: '12:00', end: '13:00' };
    expect(inQuietHours(TZ, lunch, atChicago(12, 30))).toBe(true);
    expect(inQuietHours(TZ, lunch, atChicago(11, 30))).toBe(false);
    expect(inQuietHours(TZ, lunch, atChicago(13, 30))).toBe(false);
  });
});

describe('nextAllowedAt', () => {
  it('returns the time unchanged when we are already allowed to send', () => {
    const at = atChicago(14);
    expect(nextAllowedAt(TZ, QUIET, at)).toBe(at);
  });

  it('returns the time unchanged when no window is configured', () => {
    const at = atChicago(3);
    expect(nextAllowedAt(TZ, undefined, at)).toBe(at);
  });

  it('pushes a late-evening step to the next morning', () => {
    const out = nextAllowedAt(TZ, QUIET, atChicago(22, 0));
    // 22:00 -> 08:00 is ten hours.
    expect(out.getTime() - atChicago(22, 0).getTime()).toBe(10 * 60 * 60_000);
    expect(minutesOfDay(TZ, out)).toBe(8 * 60);
  });

  it('pushes an early-morning step forward to the same morning', () => {
    const out = nextAllowedAt(TZ, QUIET, atChicago(3, 0));
    expect(out.getTime() - atChicago(3, 0).getTime()).toBe(5 * 60 * 60_000);
    expect(minutesOfDay(TZ, out)).toBe(8 * 60);
  });

  it('never moves a step backwards', () => {
    for (let h = 0; h < 24; h++) {
      const at = atChicago(h);
      expect(nextAllowedAt(TZ, QUIET, at).getTime()).toBeGreaterThanOrEqual(at.getTime());
    }
  });

  it('always lands outside the window, from every hour of the day', () => {
    for (let h = 0; h < 24; h++) {
      const out = nextAllowedAt(TZ, QUIET, atChicago(h));
      expect(inQuietHours(TZ, QUIET, out)).toBe(false);
    }
  });
});

/**
 * Resuming a strategy after quiet hours.
 *
 * The bug being pinned: every strategy step is its own timer measured from
 * enrolment, so a lead arriving overnight has all of them fall due while
 * sending is illegal. Resuming each independently made them fire together, and
 * a 0 / 30min / 2h cadence landed as three messages in one quarter of an hour.
 *
 * Times are UTC, read as America/Chicago (UTC-5 in summer), quiet 21:00-08:00.
 */
describe('deferredResume', () => {
  const TZ = 'America/Chicago';
  const QUIET = { start: '21:00', end: '08:00' };
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  /** 02:00 Chicago on 1 July 2026. */
  const AT_2AM = Date.UTC(2026, 6, 1, 7, 0);
  const chicagoHour = (ms: number) =>
    Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: TZ,
        hour: '2-digit',
        hour12: false,
      }).format(new Date(ms)),
    );

  it('spreads an overnight cadence instead of bunching it at the window', () => {
    const steps = [0, 30 * MIN, 2 * HOUR];
    let shift = 0;
    const landed: number[] = [];

    for (const offset of steps) {
      const r = deferredResume({
        tz: TZ,
        quiet: QUIET,
        // Each step wakes at its own original time, all of them still at night.
        now: AT_2AM + offset,
        enrolledAt: AT_2AM,
        offset,
        shift,
      });
      shift = r.shift;
      landed.push(r.resumeAt);
    }

    // First step at the top of the window, the rest keeping their spacing.
    expect(chicagoHour(landed[0])).toBe(8);
    expect(landed[1] - landed[0]).toBe(30 * MIN);
    expect(landed[2] - landed[0]).toBe(2 * HOUR);
  });

  it('does not push a step that already clears the window', () => {
    // Enrolled 20:00, so only the 2h step (22:00) falls inside quiet hours.
    const enrolledAt = Date.UTC(2026, 6, 2, 1, 0); // 20:00 Chicago
    const offset = 2 * HOUR;
    const r = deferredResume({
      tz: TZ,
      quiet: QUIET,
      now: enrolledAt + offset,
      enrolledAt,
      offset,
      shift: 0,
    });
    // 08:00 exactly — not 10:00, which is what re-adding the offset would give.
    expect(chicagoHour(r.resumeAt)).toBe(8);
  });

  it('leaves a cadence alone when quiet hours never bite', () => {
    const enrolledAt = Date.UTC(2026, 6, 2, 14, 0); // 09:00 Chicago
    const r = deferredResume({
      tz: TZ,
      quiet: QUIET,
      now: enrolledAt,
      enrolledAt,
      offset: 30 * MIN,
      shift: 0,
    });
    expect(r.shift).toBe(0);
    expect(r.resumeAt).toBe(enrolledAt + 30 * MIN);
  });
});
