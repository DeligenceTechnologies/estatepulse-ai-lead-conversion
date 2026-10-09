import React from 'react';
import { CopyCheck, RotateCcw } from 'lucide-react';
import {
  DAY_SHORT,
  DEFAULT_WORKING_HOURS,
  WEEK_ORDER,
  normalizeWeek,
  summarizeWeek,
  weeklyHours,
  type WorkingDay,
} from '../../utils/workingHours';

interface WorkingHoursEditorProps {
  value: WorkingDay[];
  onChange: (days: WorkingDay[]) => void;
  disabled?: boolean;
}

/** Index of the first day whose end is not after its start, or -1. */
export const invalidDay = (days: readonly WorkingDay[]): number =>
  days.findIndex((d) => d.isAvailable && d.startTime >= d.endTime);

/**
 * The weekly schedule as seven rows, Monday first: a switch for the day and
 * its start and end time. Off days keep their hours, so turning one back on
 * restores them.
 */
export const WorkingHoursEditor: React.FC<WorkingHoursEditorProps> = ({ value, onChange, disabled }) => {
  const week = normalizeWeek(value);
  const bad = invalidDay(week);

  const patch = (dayOfWeek: number, change: Partial<WorkingDay>): void =>
    onChange(week.map((d) => (d.dayOfWeek === dayOfWeek ? { ...d, ...change } : d)));

  /** Monday's hours onto every working day. */
  const copyMonday = (): void => {
    const monday = week[1];
    onChange(week.map((d) => (d.isAvailable ? { ...d, startTime: monday.startTime, endTime: monday.endTime } : d)));
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-slate-400">
          <span className="font-semibold text-slate-200">{summarizeWeek(week)}</span>
          <span className="text-slate-500"> · {weeklyHours(week)} h / week</span>
        </p>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={copyMonday}
            disabled={disabled}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-2xs font-semibold text-slate-400 hover:text-emerald-300 hover:bg-emerald-500/10 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <CopyCheck className="w-3 h-3" />
            Copy Mon to all
          </button>
          <button
            type="button"
            onClick={() => onChange(DEFAULT_WORKING_HOURS)}
            disabled={disabled}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-2xs font-semibold text-slate-400 hover:text-emerald-300 hover:bg-emerald-500/10 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RotateCcw className="w-3 h-3" />
            Reset to Mon–Fri 9–6
          </button>
        </div>
      </div>

      <div className="bg-slate-950 border border-slate-800 rounded-xl divide-y divide-slate-800/70">
        {WEEK_ORDER.map((dayOfWeek) => {
          const day = week[dayOfWeek];
          const invalid = day.isAvailable && day.startTime >= day.endTime;
          return (
            <div key={dayOfWeek} className="flex items-center gap-3 px-3 py-2">
              <button
                type="button"
                role="switch"
                aria-checked={day.isAvailable}
                aria-label={`${DAY_SHORT[dayOfWeek]} working day`}
                onClick={() => patch(dayOfWeek, { isAvailable: !day.isAvailable })}
                disabled={disabled}
                className={`relative w-8 h-[18px] rounded-full shrink-0 transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 ${
                  day.isAvailable ? 'bg-emerald-600' : 'bg-slate-700'
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-3.5 h-3.5 rounded-full bg-white shadow transition-transform ${
                    day.isAvailable ? 'translate-x-3.5' : ''
                  }`}
                />
              </button>
              <span className={`w-9 font-semibold ${day.isAvailable ? 'text-slate-100' : 'text-slate-500'}`}>
                {DAY_SHORT[dayOfWeek]}
              </span>
              {day.isAvailable ? (
                <div className="flex items-center gap-1.5 flex-1 justify-end">
                  <input
                    type="time"
                    value={day.startTime}
                    onChange={(e) => e.target.value && patch(dayOfWeek, { startTime: e.target.value })}
                    disabled={disabled}
                    aria-label={`${DAY_SHORT[dayOfWeek]} start`}
                    aria-invalid={invalid}
                    className={`h-8 bg-slate-900 border rounded-md px-2 text-slate-200 focus:outline-none focus:border-emerald-500 ${
                      invalid ? 'border-rose-500/60' : 'border-slate-800'
                    }`}
                  />
                  <span className="text-slate-500">to</span>
                  <input
                    type="time"
                    value={day.endTime}
                    onChange={(e) => e.target.value && patch(dayOfWeek, { endTime: e.target.value })}
                    disabled={disabled}
                    aria-label={`${DAY_SHORT[dayOfWeek]} end`}
                    aria-invalid={invalid}
                    className={`h-8 bg-slate-900 border rounded-md px-2 text-slate-200 focus:outline-none focus:border-emerald-500 ${
                      invalid ? 'border-rose-500/60' : 'border-slate-800'
                    }`}
                  />
                </div>
              ) : (
                <span className="flex-1 text-right text-slate-500 italic">Day off</span>
              )}
            </div>
          );
        })}
      </div>
      {bad !== -1 && (
        <p className="text-rose-300">{DAY_SHORT[week[bad].dayOfWeek]}: the end time must be after the start time.</p>
      )}
    </div>
  );
};
