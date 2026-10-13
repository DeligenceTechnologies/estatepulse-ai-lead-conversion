import { addDays, localDate, minutesOf, weekday, zonedToInstant } from '@/common/utils/zoned-time';
import type { CalendlySchedule } from '../providers/calendly.client';
import { clip, merge, subtract, type Interval } from './intervals';

export const MIN_FREE_MS = 5 * 60_000;

export interface Busy extends Interval {
  blockedStart: number;
  blockedEnd: number;
}

export function expandSchedule(schedule: CalendlySchedule, window: Interval): Interval[] {
  const intervals: Interval[] = [];
  const last = addDays(localDate(window.end, schedule.timezone), 1);
  for (let day = addDays(localDate(window.start, schedule.timezone), -1); day <= last; day = addDays(day, 1)) {
    const rules = schedule.dates[day] ?? schedule.weekly[String(weekday(day))] ?? [];
    for (const { from, to } of rules) {
      const startMinutes = minutesOf(from);
      const endMinutes = minutesOf(to) > startMinutes ? minutesOf(to) : 24 * 60;
      intervals.push({
        start: zonedToInstant(day, startMinutes, schedule.timezone),
        end: zonedToInstant(day, endMinutes, schedule.timezone),
      });
    }
  }
  return clip(merge(intervals), window);
}

export function freeTime(hours: Interval[], busy: Busy[], window: Interval): Interval[] {
  const blocked = busy.map(({ blockedStart, blockedEnd }) => ({ start: blockedStart, end: blockedEnd }));
  return subtract(clip(hours, window), blocked).filter((interval) => interval.end - interval.start >= MIN_FREE_MS);
}

export interface AvailabilitySummary {
  freeMinutes: number;
  busyMinutes: number;
  freeNow: boolean;
  busyNow: boolean;
  nextFreeAt: string | null;
}

export function summarize(free: Interval[], busy: Interval[], now: number): AvailabilitySummary {
  const merged = merge(busy);
  const minutes = (intervals: Interval[]) =>
    Math.round(intervals.reduce((total, interval) => total + interval.end - interval.start, 0) / 60_000);
  const upcoming = free.find((interval) => interval.end > now);
  return {
    freeMinutes: minutes(free),
    busyMinutes: minutes(merged),
    freeNow: free.some((interval) => interval.start <= now && interval.end > now),
    busyNow: merged.some((interval) => interval.start <= now && interval.end > now),
    nextFreeAt: upcoming ? new Date(Math.max(upcoming.start, now)).toISOString() : null,
  };
}
