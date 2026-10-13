import type { AvailabilityDay, AvailabilityReport, TimeRange } from '../../utils/calendarApi';

export const DAY_MINUTES = 24 * 60;
export const DEFAULT_HOURS: [number, number] = [8, 20];

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

export const hourLabel = (hour: number): string => {
  const h = hour % 24;
  return `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`;
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

export function visibleHours(report: AvailabilityReport): [number, number] {
  let first = Infinity;
  let last = -Infinity;
  for (const member of report.members) {
    for (const range of [...(member.hours ?? []), ...member.free, ...member.busy]) {
      for (const day of report.days) {
        if (!overlaps(range, day)) continue;
        first = Math.min(first, Math.max(0, dayOffset(ms(range.start), day)));
        last = Math.max(last, Math.min(DAY_MINUTES, dayOffset(ms(range.end), day)));
      }
    }
  }
  if (!Number.isFinite(first)) return DEFAULT_HOURS;
  let start = Math.max(0, Math.floor(first / 60) - 1);
  let end = Math.min(24, Math.ceil(last / 60) + 1);
  if (end - start < 8) {
    const grow = 8 - (end - start);
    start = Math.max(0, start - Math.ceil(grow / 2));
    end = Math.min(24, start + 8);
  }
  return [start, end];
}

export function placeIn(range: TimeRange, day: AvailabilityDay, hours: [number, number]) {
  const span = (hours[1] - hours[0]) * 60;
  const left = Math.max(0, dayOffset(ms(range.start), day) - hours[0] * 60);
  const right = Math.min(span, dayOffset(ms(range.end), day) - hours[0] * 60);
  if (right <= 0 || left >= span || right <= left) return null;
  return { left: (left / span) * 100, width: ((right - left) / span) * 100, minutes: right - left };
}
