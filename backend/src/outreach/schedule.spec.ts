import { describe, expect, it } from 'vitest';
import { defaultStrategy } from '@/telnyx/strategy-store.service';
import { awaitingWindowMs, releaseCapacity, scheduledStart } from './schedule';

const BEFORE = new Date('2026-01-01T00:00:00Z');
const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as { getResponse(): { error: { code: string } } }).getResponse().error.code;
  }
  return undefined;
};

describe('scheduledStart', () => {
  it('reads the wall clock in the chosen zone', () => {
    expect(scheduledStart('2026-07-01', '10:00', 'America/New_York', BEFORE).toISOString()).toBe('2026-07-01T14:00:00.000Z');
    expect(scheduledStart('2026-10-21', '09:00', 'Asia/Kolkata', BEFORE).toISOString()).toBe('2026-10-21T03:30:00.000Z');
    expect(scheduledStart('2026-07-01', '23:45', 'UTC', BEFORE).toISOString()).toBe('2026-07-01T23:45:00.000Z');
  });

  it('follows daylight saving: winter and summer offsets differ for the same wall time', () => {
    expect(scheduledStart('2026-01-15', '10:00', 'America/New_York', BEFORE).toISOString()).toBe('2026-01-15T15:00:00.000Z');
    expect(scheduledStart('2026-06-15', '10:00', 'America/New_York', BEFORE).toISOString()).toBe('2026-06-15T14:00:00.000Z');
  });

  it('moves a time skipped by spring-forward ahead by the gap (02:30 → 03:30 EDT)', () => {
    expect(scheduledStart('2026-03-08', '02:30', 'America/New_York', BEFORE).toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });

  it('takes the first of a time repeated by fall-back (01:30 EDT, not EST)', () => {
    expect(scheduledStart('2026-11-01', '01:30', 'America/New_York', BEFORE).toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('rejects a time that has passed, or is exactly now', () => {
    const now = new Date('2026-07-01T14:00:00Z');
    expect(code(() => scheduledStart('2026-07-01', '09:59', 'America/New_York', now))).toBe('SCHEDULE_IN_PAST');
    expect(code(() => scheduledStart('2026-07-01', '10:00', 'America/New_York', now))).toBe('SCHEDULE_IN_PAST');
    expect(scheduledStart('2026-07-01', '10:01', 'America/New_York', now).toISOString()).toBe('2026-07-01T14:01:00.000Z');
  });

  it('rejects an unknown zone and a date that does not exist', () => {
    expect(code(() => scheduledStart('2026-07-01', '10:00', 'Mars/Olympus', BEFORE))).toBe('INVALID_TIMEZONE');
    expect(code(() => scheduledStart('2026-02-30', '10:00', 'UTC', BEFORE))).toBe('INVALID_SCHEDULE');
  });
});

describe('releaseCapacity', () => {
  it('is the limit minus the reserve, live calls and released leads still waiting for theirs', () => {
    expect(releaseCapacity({ maxConcurrent: 5, reserved: 1, activeCalls: 0, awaitingCall: 0 })).toBe(4);
    expect(releaseCapacity({ maxConcurrent: 5, reserved: 1, activeCalls: 2, awaitingCall: 1 })).toBe(1);
  });

  it('never goes below zero', () => {
    expect(releaseCapacity({ maxConcurrent: 3, reserved: 1, activeCalls: 5, awaitingCall: 2 })).toBe(0);
  });

  it('keeps one slot for the batch when the reserve is as large as the limit, so a batch never stalls', () => {
    expect(releaseCapacity({ maxConcurrent: 2, reserved: 2, activeCalls: 0, awaitingCall: 0 })).toBe(1);
    expect(releaseCapacity({ maxConcurrent: 1, reserved: 1, activeCalls: 0, awaitingCall: 0 })).toBe(1);
    expect(releaseCapacity({ maxConcurrent: 2, reserved: 5, activeCalls: 1, awaitingCall: 0 })).toBe(0);
  });
});

describe('awaitingWindowMs', () => {
  it('is the first voice step plus a margin, and zero when the strategy never calls', () => {
    expect(awaitingWindowMs(defaultStrategy().steps)).toBe(6 * 60_000);
    expect(awaitingWindowMs(defaultStrategy().steps.filter((s) => s.channel === 'sms'))).toBe(0);
  });

  it('counts the waits of every step before the first call, since each wait follows the step before', () => {
    const steps = [
      { id: 'a', channel: 'sms' as const, after: { value: 2, unit: 'minutes' as const } },
      { id: 'b', channel: 'sms' as const, after: { value: 3, unit: 'minutes' as const } },
      { id: 'c', channel: 'voice' as const, after: { value: 4, unit: 'minutes' as const } },
    ];
    expect(awaitingWindowMs(steps)).toBe((9 + 5) * 60_000);
  });
});
