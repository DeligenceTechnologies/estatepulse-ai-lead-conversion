import { describe, expect, it } from 'vitest';
import type { AvailabilityReport, MemberAvailability } from '../../../utils/calendarApi';
import { DEFAULT_HOURS, visibleHours } from './time';

// A UTC day, so offsets read as wall-clock hours.
const DAY = { date: '2026-10-14', start: '2026-10-14T00:00:00Z', end: '2026-10-15T00:00:00Z' };
const at = (hhmm: string) => `2026-10-14T${hhmm}:00Z`;

const member = (parts: Partial<MemberAvailability>): MemberAvailability =>
  ({ hours: null, free: [], busy: [], ...parts }) as MemberAvailability;

const report = (members: MemberAvailability[]): AvailabilityReport =>
  ({ days: [DAY], members }) as unknown as AvailabilityReport;

describe('visibleHours', () => {
  it('shows the working day with one hour either side', () => {
    const hours = [{ start: at('09:00'), end: at('18:00') }];
    expect(visibleHours(report([member({ hours })]))).toEqual([8, 19]);
  });

  it('spans the earliest start and latest end across members', () => {
    const a = member({ hours: [{ start: at('09:00'), end: at('17:00') }] });
    const b = member({ hours: [{ start: at('10:00'), end: at('19:00') }] });
    expect(visibleHours(report([a, b]))).toEqual([8, 20]);
  });

  it('rounds a half-hour working day outward', () => {
    const hours = [{ start: at('09:30'), end: at('17:30') }];
    expect(visibleHours(report([member({ hours })]))).toEqual([8, 19]);
  });

  it('is not stretched by meetings outside working hours', () => {
    const m = member({
      hours: [{ start: at('09:00'), end: at('18:00') }],
      busy: [{ start: at('05:00'), end: at('23:00'), source: 'calendar' }],
    });
    expect(visibleHours(report([m]))).toEqual([8, 19]);
  });

  it('falls back to free time, then to the default day', () => {
    const free = [{ start: at('10:00'), end: at('16:00') }];
    expect(visibleHours(report([member({ free })]))).toEqual([9, 17]);
    expect(visibleHours(report([member({})]))).toEqual(DEFAULT_HOURS);
  });
});
