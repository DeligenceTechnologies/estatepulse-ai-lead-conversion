import type { AvailabilityReportDay, TimeRange } from '../../../utils/calendarApi';

export const DAY_MINUTES = 24 * 60;
/**
 * Every bar shows the whole 24-hour day, midnight to midnight in the report's
 * zone, so the framing never moves with the timezone or anyone's hours.
 */
export const DAY_HOURS: [number, number] = [0, 24];

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

const formatters = new Map<string, Intl.DateTimeFormat>();

/** "3:20 PM" in `timeZone`, cached per zone. */
export const timeFormatter = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(undefined, { timeZone, hour: 'numeric', minute: '2-digit' });
    formatters.set(timeZone, formatter);
  }
  return formatter;
};

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

/** `8 AM` for the axis ticks; `full` gives `8:00 AM` where there is room. 24, the day's end, is the next midnight: `12 AM`. */
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

export const overlaps = (range: TimeRange, day: AvailabilityReportDay): boolean =>
  ms(range.end) > ms(day.start) && ms(range.start) < ms(day.end);

export const minutesInDay = (range: TimeRange, day: AvailabilityReportDay): number =>
  Math.max(0, Math.min(ms(range.end), ms(day.end)) - Math.max(ms(range.start), ms(day.start))) / 60_000;

export const dayOffset = (instant: number, day: AvailabilityReportDay): number => {
  const start = ms(day.start);
  return ((instant - start) / (ms(day.end) - start)) * DAY_MINUTES;
};

export function placeIn(range: TimeRange, day: AvailabilityReportDay, hours: [number, number]) {
  const span = (hours[1] - hours[0]) * 60;
  const left = Math.max(0, dayOffset(ms(range.start), day) - hours[0] * 60);
  const right = Math.min(span, dayOffset(ms(range.end), day) - hours[0] * 60);
  if (right <= 0 || left >= span || right <= left) return null;
  return { left: (left / span) * 100, width: ((right - left) / span) * 100, minutes: right - left };
}

/** `Pacific/Pago_Pago` → `Pago Pago`: the city part, for tight spaces. */
export const zoneCity = (timeZone: string): string => (timeZone.split('/').pop() ?? timeZone).replace(/_/g, ' ');
