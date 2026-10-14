import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKING_HOURS } from '@/common/utils/working-hours';
import { readWeeklySchedule, scheduleToWorkingHours } from './schedule-to-working-hours';

describe('scheduleToWorkingHours', () => {
  it('turns each day into one span, keeping breaks inside it', () => {
    const hours = scheduleToWorkingHours(
      {
        weekly: {
          '1': [
            { from: '13:00', to: '17:30' },
            { from: '9:00', to: '12:00' },
          ],
          '6': [{ from: '10:00', to: '24:00' }],
        },
      },
      DEFAULT_WORKING_HOURS,
    );
    expect(hours?.[1]).toEqual({ dayOfWeek: 1, isAvailable: true, startTime: '09:00', endTime: '17:30' });
    expect(hours?.[6]).toEqual({ dayOfWeek: 6, isAvailable: true, startTime: '10:00', endTime: '23:59' });
  });

  it('marks missing days off, keeping the fallback times', () => {
    const hours = scheduleToWorkingHours({ weekly: { '1': [{ from: '08:00', to: '16:00' }] } }, DEFAULT_WORKING_HOURS);
    expect(hours).toHaveLength(7);
    expect(hours?.[2]).toEqual({ dayOfWeek: 2, isAvailable: false, startTime: '09:00', endTime: '18:00' });
  });

  it('ignores broken intervals and gives up when no day is left', () => {
    expect(scheduleToWorkingHours({ weekly: {} }, DEFAULT_WORKING_HOURS)).toBeNull();
    expect(
      scheduleToWorkingHours({ weekly: { '1': [{ from: '18:00', to: '09:00' }, { from: 'x', to: '10:00' }] } }, DEFAULT_WORKING_HOURS),
    ).toBeNull();
  });
});

describe('readWeeklySchedule', () => {
  it('keeps valid days sorted and drops malformed ones', () => {
    expect(
      readWeeklySchedule({
        timezone: 'Asia/Kolkata',
        weekly: { '1': [{ from: '14:00', to: '18:00' }, { from: '09:00', to: '13:00' }], '2': [], '9': [{ from: '09:00', to: '10:00' }] },
        dates: {},
      }),
    ).toEqual({ timezone: 'Asia/Kolkata', weekly: { '1': [{ from: '09:00', to: '13:00' }, { from: '14:00', to: '18:00' }] } });
    expect(readWeeklySchedule(null)).toBeNull();
    expect(readWeeklySchedule({ timezone: 'UTC' })).toBeNull();
  });
});
