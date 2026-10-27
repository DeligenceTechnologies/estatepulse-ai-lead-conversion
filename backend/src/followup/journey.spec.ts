import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, fitConditions, limitSlot, limitsOf, skipDaysOf, unmetCondition } from './journey';

describe('step conditions', () => {
  it('no condition: the step always runs', () => {
    expect(unmetCondition(undefined, { lastCall: null, replied: true })).toBeNull();
    expect(unmetCondition({}, { lastCall: 'connected', replied: true })).toBeNull();
  });

  it('"only if the last call was not answered" holds for every way a call goes unanswered', () => {
    for (const lastCall of ['no_answer', 'voicemail', 'busy', 'rejected', 'short', 'failed'] as const) {
      expect(unmetCondition({ lastCallMissed: true }, { lastCall, replied: false })).toBeNull();
    }
  });

  it('…and not after a conversation, or before any call has ended', () => {
    expect(unmetCondition({ lastCallMissed: true }, { lastCall: 'connected', replied: false })).toMatch(/it was \(connected\)/);
    expect(unmetCondition({ lastCallMissed: true }, { lastCall: null, replied: false })).toMatch(/no call has ended/);
  });

  it('"only if they have not replied", and both together', () => {
    expect(unmetCondition({ noReply: true }, { lastCall: null, replied: true })).toMatch(/they have/);
    expect(unmetCondition({ noReply: true, lastCallMissed: true }, { lastCall: 'no_answer', replied: false })).toBeNull();
    expect(unmetCondition({ noReply: true, lastCallMissed: true }, { lastCall: 'no_answer', replied: true })).not.toBeNull();
  });

  it('a condition is about the step before: when that step was skipped, so is this one', () => {
    // The call before was skipped; an older missed call must not make "tried calling" true.
    expect(unmetCondition({ lastCallMissed: true }, { lastCall: 'no_answer', replied: false, previousSkipped: true })).toMatch(/step before/);
    expect(unmetCondition({ noReply: true }, { lastCall: null, replied: false, previousSkipped: true })).toMatch(/step before/);
    // A step without a condition does not depend on the one before.
    expect(unmetCondition(undefined, { lastCall: null, replied: false, previousSkipped: true })).toBeNull();
  });

  it('only the condition that fits the step before is kept', () => {
    const both = { lastCallMissed: true, noReply: true };
    expect(fitConditions(both, undefined)).toBeUndefined();
    expect(fitConditions(both, 'sms')).toEqual({ noReply: true });
    expect(fitConditions(both, 'voice')).toEqual({ lastCallMissed: true });
    expect(fitConditions({ lastCallMissed: true }, 'sms')).toBeUndefined();
    expect(fitConditions({ noReply: true }, 'voice')).toBeUndefined();
    expect(fitConditions(undefined, 'voice')).toBeUndefined();
  });
});

describe('contact limits', () => {
  it('stored values are checked; anything missing or out of range is the default', () => {
    expect(limitsOf(undefined)).toEqual(DEFAULT_LIMITS);
    expect(limitsOf({ callsPerDay: 0, smsPerDay: 5, minGapMinutes: 15 })).toEqual({ callsPerDay: 0, smsPerDay: 5, minGapMinutes: 15 });
    expect(limitsOf({ callsPerDay: -1, smsPerDay: 2.5, minGapMinutes: 99999 })).toEqual(DEFAULT_LIMITS);
    expect(skipDaysOf([0, 6, 6, 9, 'x'])).toEqual([0, 6]);
    expect(skipDaysOf(null)).toEqual([]);
  });

  const NOW = new Date('2026-10-27T06:00:00.000Z');
  const TOMORROW = new Date('2026-10-28T02:30:00.000Z');
  const slot = (over: Partial<Parameters<typeof limitSlot>[0]>) =>
    limitSlot({ channel: 'voice', now: NOW, limits: DEFAULT_LIMITS, sentToday: 0, lastAt: null, tomorrow: TOMORROW, ...over });

  it('a touch goes now while under the limit and past the gap', () => {
    expect(slot({ sentToday: 1, lastAt: new Date(NOW.getTime() - 11 * 60_000) })).toEqual({ at: NOW, reason: null });
  });

  it('the day\'s limit used: the next day\'s contact window', () => {
    expect(slot({ sentToday: 2 })).toEqual({ at: TOMORROW, reason: 'Daily limit of 2 calls reached' });
    expect(slot({ channel: 'sms', sentToday: 3 })).toEqual({ at: TOMORROW, reason: 'Daily limit of 3 texts reached' });
  });

  it('too soon after the last one on the same channel: when the gap ends', () => {
    const last = new Date(NOW.getTime() - 4 * 60_000);
    expect(slot({ sentToday: 1, lastAt: last })).toEqual({ at: new Date(last.getTime() + 10 * 60_000), reason: 'Less than 10 min since the last of our calls' });
  });

  it('a limit of 0 is off', () => {
    expect(slot({ limits: { callsPerDay: 0, smsPerDay: 0, minGapMinutes: 0 }, sentToday: 50, lastAt: NOW })).toEqual({ at: NOW, reason: null });
  });
});
