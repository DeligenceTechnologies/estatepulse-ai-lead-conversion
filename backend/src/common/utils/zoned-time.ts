const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, format);
  }
  return format;
}

function wallClock(instant: number, timeZone: string) {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return parts as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

export function isTimeZone(zone: string | null | undefined): zone is string {
  if (!zone) return false;
  try {
    formatter(zone);
    return true;
  } catch {
    return false;
  }
}

export function zoneOffsetMs(instant: number, timeZone: string): number {
  const { year, month, day, hour, minute, second } = wallClock(instant, timeZone);
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  return asUtc - (instant - (instant % 1000));
}

export function zonedToInstant(date: string, minutesOfDay: number, timeZone: string): number {
  const [year, month, day] = date.split('-').map(Number);
  const wall = Date.UTC(year, month - 1, day) + minutesOfDay * MINUTE_MS;
  const first = wall - zoneOffsetMs(wall, timeZone);
  return wall - zoneOffsetMs(first, timeZone);
}

export function localDate(instant: number, timeZone: string): string {
  const { year, month, day } = wallClock(instant, timeZone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) + days * DAY_MS).toISOString().slice(0, 10);
}

export function weekday(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function minutesOf(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}
