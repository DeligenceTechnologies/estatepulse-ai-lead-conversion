import { afterEach, describe, expect, it } from 'vitest';
import {
  addDays,
  dayFromIsoDate,
  displayTimeZone,
  formatDateTime,
  formatTime,
  isoDateOf,
  setDisplayTimeZone,
  startOfDay,
  weekdayOf,
  zoneOffsetLabel,
} from './datetime';

afterEach(() => setDisplayTimeZone(null));

describe('display timezone', () => {
  it("shows a UTC instant in the user's zone", () => {
    const instant = '2026-10-14T09:00:00.000Z';
    setDisplayTimeZone('Asia/Kolkata');
    expect(formatTime(instant, { hour: 'numeric', minute: '2-digit', hour12: true })).toMatch(/2:30\s?PM/);
    setDisplayTimeZone('America/New_York');
    expect(formatTime(instant, { hour: 'numeric', minute: '2-digit', hour12: true })).toMatch(/5:00\s?AM/);
  });

  it('keeps the device zone for a missing or unknown one', () => {
    setDisplayTimeZone('Asia/Kolkata');
    setDisplayTimeZone('Mars/Base');
    expect(displayTimeZone()).not.toBe('Mars/Base');
  });

  it('prints a dash for an invalid date', () => {
    expect(formatDateTime('not a date')).toBe('—');
  });

  it('labels the offset', () => {
    expect(zoneOffsetLabel('Asia/Kolkata', '2026-10-14T00:00:00Z')).toBe('GMT+5:30');
  });
});

describe('days in the display zone', () => {
  it("starts the day at the user's midnight, not the device's", () => {
    setDisplayTimeZone('Asia/Kolkata');
    // 20:00 UTC on the 14th is already the 15th in Kolkata.
    const day = startOfDay('2026-10-14T20:00:00.000Z');
    expect(new Date(day).toISOString()).toBe('2026-10-14T18:30:00.000Z');
    expect(isoDateOf(day)).toBe('2026-10-15');
    expect(weekdayOf(day)).toBe(4);
  });

  it('steps over a DST change by calendar day', () => {
    setDisplayTimeZone('America/New_York');
    const saturday = dayFromIsoDate('2026-10-31')!;
    const monday = addDays(saturday, 2);
    expect(isoDateOf(monday)).toBe('2026-11-02');
    expect(new Date(monday).toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect(monday - saturday).toBe(49 * 3_600_000);
  });

  it('rejects a malformed date', () => {
    expect(dayFromIsoDate('14/10/2026')).toBeNull();
  });
});
