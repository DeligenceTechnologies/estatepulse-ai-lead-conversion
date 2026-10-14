import { describe, expect, it } from 'vitest';
import { clockLabel, summarizeSchedule } from './schedule';

const span = (from: string, to: string) => [{ from, to }];

describe('member schedule', () => {
  it('formats clock times compactly', () => {
    expect(clockLabel('09:00')).toBe('9 AM');
    expect(clockLabel('17:30')).toBe('5:30 PM');
    expect(clockLabel('00:00')).toBe('12 AM');
    expect(clockLabel('12:15')).toBe('12:15 PM');
  });

  it('merges consecutive days with the same hours, Monday first', () => {
    const weekly = {
      '1': span('09:00', '17:00'),
      '2': span('09:00', '17:00'),
      '3': span('09:00', '17:00'),
      '4': span('09:00', '17:00'),
      '5': span('09:00', '13:00'),
      '0': span('10:00', '12:00'),
    };
    expect(summarizeSchedule({ timezone: null, weekly })).toEqual([
      { days: 'Mon–Thu', hours: '9 AM – 5 PM' },
      { days: 'Fri', hours: '9 AM – 1 PM' },
      { days: 'Sun', hours: '10 AM – 12 PM' },
    ]);
  });

  it('keeps split days and returns nothing for an empty week', () => {
    const weekly = { '1': [{ from: '09:00', to: '12:00' }, { from: '13:00', to: '18:00' }] };
    expect(summarizeSchedule({ timezone: null, weekly })).toEqual([{ days: 'Mon', hours: '9 AM – 12 PM, 1 PM – 6 PM' }]);
    expect(summarizeSchedule({ timezone: null, weekly: {} })).toEqual([]);
  });
});
