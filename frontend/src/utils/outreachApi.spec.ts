import { describe, expect, it } from 'vitest';
import { earliestStart, upcoming } from './outreachApi';

describe('earliestStart', () => {
  it('is at least 5 minutes out, on a 5-minute mark, in the zone', () => {
    expect(earliestStart('Asia/Kolkata', new Date('2026-10-23T05:00:00Z'))).toEqual({ date: '2026-10-23', time: '10:35' });
    expect(earliestStart('Asia/Kolkata', new Date('2026-10-23T05:01:10Z'))).toEqual({ date: '2026-10-23', time: '10:40' });
    expect(earliestStart('UTC', new Date('2026-10-23T23:57:00Z'))).toEqual({ date: '2026-10-24', time: '00:05' });
  });
});

describe('upcoming', () => {
  it('keeps a future time and moves a past one up', () => {
    const future = { date: '2999-01-01', time: '09:00', timeZone: 'UTC', mode: 'scheduled' };
    expect(upcoming(future)).toBe(future);
    const moved = upcoming({ date: '2000-01-01', time: '09:00', timeZone: 'UTC', mode: 'scheduled' });
    expect(moved.mode).toBe('scheduled');
    expect(`${moved.date} ${moved.time}` > new Date().toISOString().slice(0, 16).replace('T', ' ')).toBe(true);
  });
});
