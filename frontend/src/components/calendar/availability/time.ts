import type { AvailabilityDay, AvailabilityReport, TimeRange } from '../../../utils/calendarApi';

export const DAY_MINUTES = 24 * 60;
/** 9:00 AM – 6:00 PM with an hour either side, for a report with no working hours at all. */
export const DEFAULT_HOURS: [number, number] = [8, 19];

export const ms = (iso: string): number => Date.parse(iso);

export const todayIn = (timeZone: string): string => {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
      new Date(),
    );
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
};

export const shiftDate = (date: string, days: number): string => {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
};

export const timeFormatter = (timeZone: string): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat(undefined, { timeZone, hour: 'numeric', minute: '2-digit' });

export const dayLabel = (date: string, style: 'long' | 'short' | 'weekday'): string => {
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  if (style === 'weekday') return value.toLocaleDateString(undefined, { timeZone: 'UTC', weekday: 'short' });
  return value.toLocaleDateString(undefined, {
    timeZone: 'UTC',
    weekday: style === 'long' ? 'long' : 'short',
    day: 'numeric',
    month: 'short',
  });
};

/** `8 AM` for the axis ticks; `full` gives `8:00 AM` where there is room. */
export const hourLabel = (hour: number, full = false): string => {
  const h = hour % 24;
  return `${h % 12 === 0 ? 12 : h % 12}${full ? ':00' : ''} ${h < 12 ? 'AM' : 'PM'}`;
};

export const duration = (minutes: number): string => {
  const rounded = Math.round(minutes);
  if (rounded <= 0) return '0m';
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
};

export const overlaps = (range: TimeRange, day: AvailabilityDay): boolean =>
  ms(range.end) > ms(day.start) && ms(range.start) < ms(day.end);

export const minutesInDay = (range: TimeRange, day: AvailabilityDay): number =>
  Math.max(0, Math.min(ms(range.end), ms(day.end)) - Math.max(ms(range.start), ms(day.start))) / 60_000;

export const dayOffset = (instant: number, day: AvailabilityDay): number => {
  const start = ms(day.start);
  return ((instant - start) / (ms(day.end) - start)) * DAY_MINUTES;
};

/** Hours of padding shown either side of the working day, so its edges are visible. */
const PAD_HOURS = 1;

/** Earliest start and latest end, in minutes into the day, of `ranges` across the report's days. */
function spanOf(ranges: TimeRange[], days: AvailabilityDay[]): [number, number] | null {
  let first = Infinity;
  let last = -Infinity;
  for (const range of ranges) {
    for (const day of days) {
      if (!overlaps(range, day)) continue;
      first = Math.min(first, Math.max(0, dayOffset(ms(range.start), day)));
      last = Math.max(last, Math.min(DAY_MINUTES, dayOffset(ms(range.end), day)));
    }
  }
  return Number.isFinite(first) ? [first, last] : null;
}

/**
 * The hours the timeline shows: the team's working day with one hour either
 * side — working 9:00 AM – 6:00 PM shows 8:00 AM – 7:00 PM. Meetings outside
 * that are clipped, so one late call never stretches the whole bar. Without
 * working hours, free time stands in for them (it only falls inside working
 * hours); with neither, the default day.
 */
export function visibleHours(report: AvailabilityReport): [number, number] {
  const span =
    spanOf(report.members.flatMap((member) => member.hours ?? []), report.days) ??
    spanOf(report.members.flatMap((member) => member.free), report.days);
  if (!span) return DEFAULT_HOURS;
  const start = Math.max(0, Math.floor(span[0] / 60) - PAD_HOURS);
  const end = Math.min(24, Math.ceil(span[1] / 60) + PAD_HOURS);
  return end > start ? [start, end] : DEFAULT_HOURS;
}

export function placeIn(range: TimeRange, day: AvailabilityDay, hours: [number, number]) {
  const span = (hours[1] - hours[0]) * 60;
  const left = Math.max(0, dayOffset(ms(range.start), day) - hours[0] * 60);
  const right = Math.min(span, dayOffset(ms(range.end), day) - hours[0] * 60);
  if (right <= 0 || left >= span || right <= left) return null;
  return { left: (left / span) * 100, width: ((right - left) / span) * 100, minutes: right - left };
}
