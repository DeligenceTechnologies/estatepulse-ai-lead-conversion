import { describe, expect, it } from 'vitest';
import { expandSchedule, freeTime, summarize } from './availability-math';

const iso = (value: string) => Date.parse(value);
const schedule = {
  timezone: 'Asia/Kolkata',
  weekly: { '2': [{ from: '09:00', to: '13:00' }, { from: '14:00', to: '18:00' }] },
  dates: { '2026-10-20': [] },
};

describe('availability math', () => {
  it('expands weekly rules into instants in the schedule zone', () => {
    const hours = expandSchedule(schedule, { start: iso('2026-10-13T00:00:00Z'), end: iso('2026-10-14T00:00:00Z') });
    expect(hours).toEqual([
      { start: iso('2026-10-13T03:30:00Z'), end: iso('2026-10-13T07:30:00Z') },
      { start: iso('2026-10-13T08:30:00Z'), end: iso('2026-10-13T12:30:00Z') },
    ]);
  });

  it('lets a date override close a working day', () => {
    expect(expandSchedule(schedule, { start: iso('2026-10-20T00:00:00Z'), end: iso('2026-10-21T00:00:00Z') })).toEqual([]);
  });

  it('removes buffered busy time and slivers from free time', () => {
    const hours = [{ start: iso('2026-10-13T03:30:00Z'), end: iso('2026-10-13T07:30:00Z') }];
    const busy = [
      {
        start: iso('2026-10-13T04:00:00Z'),
        end: iso('2026-10-13T04:30:00Z'),
        blockedStart: iso('2026-10-13T03:50:00Z'),
        blockedEnd: iso('2026-10-13T04:40:00Z'),
      },
      {
        start: iso('2026-10-13T03:33:00Z'),
        end: iso('2026-10-13T03:34:00Z'),
        blockedStart: iso('2026-10-13T03:33:00Z'),
        blockedEnd: iso('2026-10-13T03:34:00Z'),
      },
    ];
    expect(freeTime(hours, busy, { start: iso('2026-10-13T00:00:00Z'), end: iso('2026-10-14T00:00:00Z') })).toEqual([
      { start: iso('2026-10-13T03:34:00Z'), end: iso('2026-10-13T03:50:00Z') },
      { start: iso('2026-10-13T04:40:00Z'), end: iso('2026-10-13T07:30:00Z') },
    ]);
  });

  it('summarizes the current state', () => {
    const now = iso('2026-10-13T05:00:00Z');
    const summary = summarize(
      [{ start: iso('2026-10-13T06:00:00Z'), end: iso('2026-10-13T07:00:00Z') }],
      [{ start: iso('2026-10-13T04:30:00Z'), end: iso('2026-10-13T05:30:00Z') }],
      now,
    );
    expect(summary).toEqual({
      freeMinutes: 60,
      busyMinutes: 60,
      freeNow: false,
      busyNow: true,
      nextFreeAt: '2026-10-13T06:00:00.000Z',
    });
  });
});
