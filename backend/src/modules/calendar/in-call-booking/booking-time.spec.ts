import { describe, expect, it } from 'vitest';
import { localDate, parseTime, pickSlots, resolveDay, searchWindow, spoken, zonedToUtc } from './booking-time';

// Tuesday 6 October 2026, 14:00 UTC = 09:00 in Chicago (CDT, UTC-5).
const NOW = new Date('2026-10-06T14:00:00Z');
const CHI = 'America/Chicago';

describe('zonedToUtc / localDate', () => {
  it('converts a Chicago wall-clock time to UTC', () => {
    expect(zonedToUtc('2026-10-08', '15:00', CHI).toISOString()).toBe('2026-10-08T20:00:00.000Z');
  });

  it('is right on both sides of a DST change', () => {
    // US DST ends 1 Nov 2026: CDT (-5) before, CST (-6) after.
    expect(zonedToUtc('2026-10-31', '10:00', CHI).toISOString()).toBe('2026-10-31T15:00:00.000Z');
    expect(zonedToUtc('2026-11-02', '10:00', CHI).toISOString()).toBe('2026-11-02T16:00:00.000Z');
  });

  it('handles a half-hour zone', () => {
    expect(zonedToUtc('2026-10-08', '15:00', 'Asia/Kolkata').toISOString()).toBe('2026-10-08T09:30:00.000Z');
  });

  it('gives the local calendar date, not the UTC one', () => {
    expect(localDate(new Date('2026-10-07T03:00:00Z'), CHI)).toBe('2026-10-06');
  });
});

describe('resolveDay', () => {
  it('understands dates, today, tomorrow and weekday names', () => {
    expect(resolveDay('2026-10-09', NOW, CHI)).toBe('2026-10-09');
    expect(resolveDay('today', NOW, CHI)).toBe('2026-10-06');
    expect(resolveDay('Tomorrow', NOW, CHI)).toBe('2026-10-07');
    expect(resolveDay('friday', NOW, CHI)).toBe('2026-10-09');
    expect(resolveDay('tuesday', NOW, CHI)).toBe('2026-10-06');
    expect(resolveDay('monday', NOW, CHI)).toBe('2026-10-12');
  });

  it('is null for nothing or nonsense, never a guess', () => {
    expect(resolveDay(undefined, NOW, CHI)).toBeNull();
    expect(resolveDay('next-ish', NOW, CHI)).toBeNull();
  });
});

describe('parseTime', () => {
  it('accepts 24-hour HH:MM only', () => {
    expect(parseTime('15:30')).toBe('15:30');
    expect(parseTime('9:05')).toBe('09:05');
    expect(parseTime('25:00')).toBeNull();
    expect(parseTime('3pm')).toBeNull();
  });
});

describe('searchWindow', () => {
  it('covers one local day', () => {
    expect(searchWindow('2026-10-08', NOW, CHI)).toEqual({
      start: new Date('2026-10-08T05:00:00Z'),
      end: new Date('2026-10-09T05:00:00Z'),
    });
  });

  it('never starts in the past, and is null for a day that is over', () => {
    expect(searchWindow('2026-10-06', NOW, CHI)?.start).toEqual(new Date(NOW.getTime() + 60_000));
    expect(searchWindow('2026-10-05', NOW, CHI)).toBeNull();
  });

  it('with no day, looks ahead a week from now', () => {
    const w = searchWindow(null, NOW, CHI)!;
    expect(w.start).toEqual(new Date(NOW.getTime() + 60_000));
    expect(w.end).toEqual(new Date(NOW.getTime() + 7 * 86_400_000));
  });
});

describe('spoken', () => {
  it('reads the time in the office zone', () => {
    expect(spoken(new Date('2026-10-08T20:00:00Z'), CHI)).toBe('Thursday, October 8 at 3:00 PM');
  });
});

describe('pickSlots', () => {
  const at = (h: number) => new Date(Date.UTC(2026, 9, 8, h));
  const slots = [at(18), at(14), at(16), at(20), at(15)];

  it('offers the earliest when no time was asked for', () => {
    expect(pickSlots(slots, null, 3)).toEqual([at(14), at(15), at(16)]);
  });

  it('offers the closest to the requested time, in time order', () => {
    expect(pickSlots(slots, at(19), 3)).toEqual([at(16), at(18), at(20)]);
  });
});
