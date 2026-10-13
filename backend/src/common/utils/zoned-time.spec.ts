import { describe, expect, it } from 'vitest';
import { addDays, isTimeZone, localDate, weekday, zonedToInstant } from './zoned-time';

describe('zoned-time', () => {
  it('converts a wall-clock time to an instant', () => {
    expect(new Date(zonedToInstant('2026-10-13', 9 * 60, 'Asia/Kolkata')).toISOString()).toBe('2026-10-13T03:30:00.000Z');
    expect(new Date(zonedToInstant('2026-07-01', 0, 'America/New_York')).toISOString()).toBe('2026-07-01T04:00:00.000Z');
  });

  it('handles daylight saving changes', () => {
    expect(new Date(zonedToInstant('2026-03-08', 12 * 60, 'America/New_York')).toISOString()).toBe('2026-03-08T16:00:00.000Z');
    expect(zonedToInstant('2026-11-02', 0, 'America/New_York') - zonedToInstant('2026-11-01', 0, 'America/New_York')).toBe(
      25 * 3_600_000,
    );
  });

  it('reads the local date and weekday', () => {
    expect(localDate(Date.parse('2026-10-13T20:00:00Z'), 'Asia/Kolkata')).toBe('2026-10-14');
    expect(weekday('2026-10-13')).toBe(2);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('validates zones', () => {
    expect(isTimeZone('Europe/London')).toBe(true);
    expect(isTimeZone('Mars/Base')).toBe(false);
    expect(isTimeZone(null)).toBe(false);
  });
});
