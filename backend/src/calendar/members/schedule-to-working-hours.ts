import type { WorkingDay } from '@/common/utils/working-hours';
import type { ScheduleInterval, WeeklySchedule } from '../calendar.types';

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** '9:00' → '09:00', '24:00' → '23:59'; null when it is not a time of day. */
function clock(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours === 24 && minutes === 0) return '23:59';
  const text = `${String(hours).padStart(2, '0')}:${match[2]}`;
  return TIME.test(text) ? text : null;
}

/**
 * A calendar's weekly schedule as EstatePulse working hours: one span per day,
 * from the first interval's start to the last one's end (a lunch break stays
 * inside the working day). Days that are off keep `fallback`'s times so that
 * switching them on later starts from something sensible.
 *
 * Returns null when the schedule has no working day at all, so the caller
 * falls back to the organization's hours instead of creating someone who is
 * never available.
 */
export function scheduleToWorkingHours(
  schedule: Pick<WeeklySchedule, 'weekly'>,
  fallback: readonly WorkingDay[],
): WorkingDay[] | null {
  const days = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek): WorkingDay => {
    const base = fallback.find((day) => day.dayOfWeek === dayOfWeek) ?? {
      dayOfWeek,
      isAvailable: false,
      startTime: '09:00',
      endTime: '18:00',
    };
    const spans = (schedule.weekly[String(dayOfWeek)] ?? [])
      .map((interval) => ({ from: clock(interval.from), to: clock(interval.to) }))
      .filter((span): span is { from: string; to: string } => Boolean(span.from && span.to && span.from < span.to));
    if (!spans.length) return { dayOfWeek, isAvailable: false, startTime: base.startTime, endTime: base.endTime };

    const startTime = spans.reduce((min, span) => (span.from < min ? span.from : min), spans[0].from);
    const endTime = spans.reduce((max, span) => (span.to > max ? span.to : max), spans[0].to);
    return { dayOfWeek, isAvailable: true, startTime, endTime };
  });
  return days.some((day) => day.isAvailable) ? days : null;
}

/** A stored schedule (JSON from the database) as a `WeeklySchedule`, dropping anything malformed. */
export function readWeeklySchedule(value: unknown): WeeklySchedule | null {
  if (!value || typeof value !== 'object') return null;
  const { timezone, weekly } = value as { timezone?: unknown; weekly?: unknown };
  if (!weekly || typeof weekly !== 'object') return null;
  const days: WeeklySchedule['weekly'] = {};
  for (const [day, intervals] of Object.entries(weekly as Record<string, unknown>)) {
    if (!/^[0-6]$/.test(day)) continue;
    const spans = readIntervals(intervals);
    if (spans?.length) days[day] = spans;
  }
  return { timezone: typeof timezone === 'string' ? timezone : null, weekly: days };
}

/**
 * A stored schedule's one-off dates ('YYYY-MM-DD' → hours), dropping anything
 * malformed. An empty list stays: it is a day off overriding the weekly hours.
 */
export function readDateOverrides(value: unknown): Record<string, ScheduleInterval[]> {
  const dates: Record<string, ScheduleInterval[]> = {};
  if (!value || typeof value !== 'object') return dates;
  for (const [date, intervals] of Object.entries(value as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const spans = readIntervals(intervals);
    if (spans) dates[date] = spans;
  }
  return dates;
}

/** Valid 'HH:MM' spans in order; null when the value is not a list at all. */
function readIntervals(value: unknown): ScheduleInterval[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .map((interval) => ({ from: clock((interval as { from?: unknown })?.from), to: clock((interval as { to?: unknown })?.to) }))
    .filter((span): span is ScheduleInterval => Boolean(span.from && span.to && span.from < span.to))
    .sort((a, b) => a.from.localeCompare(b.from));
}
