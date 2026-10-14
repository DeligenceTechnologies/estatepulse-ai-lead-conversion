import { describe, expect, it } from 'vitest';
import { zonedToInstant } from '@/common/utils/zoned-time';
import { expandSchedule } from './availability-math';
import { scheduleOf, workingTimezone } from './calendar-availability.service';

describe('workingTimezone', () => {
  it("prefers the schedule's zone over the profile's", () => {
    expect(workingTimezone({ timezone: 'Asia/Calcutta', scheduleTimezone: 'America/Toronto' })).toBe('America/Toronto');
  });

  it('falls back to the profile, and skips zones that are not real', () => {
    expect(workingTimezone({ timezone: 'Europe/London', scheduleTimezone: null })).toBe('Europe/London');
    expect(workingTimezone({ timezone: 'Europe/London', scheduleTimezone: 'Mars/Base' })).toBe('Europe/London');
    expect(workingTimezone({ timezone: null, scheduleTimezone: null })).toBeNull();
  });
});

describe('scheduleOf + expandSchedule', () => {
  const nineToFive = { from: '09:00', to: '17:00' };

  it("puts the hours on the member's own day", () => {
    const schedule = scheduleOf({
      timezone: 'Asia/Calcutta',
      scheduleTimezone: 'America/Toronto',
      schedule: { weekly: { '3': [nineToFive] }, dates: {} },
    });
    // Wednesday 14 Oct 2026 in Toronto.
    const day = { start: zonedToInstant('2026-10-14', 0, 'America/Toronto'), end: zonedToInstant('2026-10-15', 0, 'America/Toronto') };
    expect(expandSchedule(schedule!, day)).toEqual([
      { start: zonedToInstant('2026-10-14', 540, 'America/Toronto'), end: zonedToInstant('2026-10-14', 1020, 'America/Toronto') },
    ]);
  });

  it('keeps a day-off override and drops malformed hours', () => {
    const schedule = scheduleOf({
      timezone: 'UTC',
      scheduleTimezone: null,
      schedule: { weekly: { '1': [nineToFive, { from: 'x', to: 3 }] }, dates: { '2026-10-19': [], bad: [] } },
    });
    expect(schedule).toEqual({ timezone: 'UTC', weekly: { '1': [nineToFive] }, dates: { '2026-10-19': [] } });
    const monday = { start: Date.UTC(2026, 9, 19), end: Date.UTC(2026, 9, 20) };
    expect(expandSchedule(schedule!, monday)).toEqual([]);
  });

  it('has no hours without a schedule or any valid zone', () => {
    expect(scheduleOf({ timezone: 'UTC', scheduleTimezone: null, schedule: null })).toBeNull();
    expect(scheduleOf({ timezone: null, scheduleTimezone: 'Mars/Base', schedule: { weekly: {} } })).toBeNull();
  });
});
