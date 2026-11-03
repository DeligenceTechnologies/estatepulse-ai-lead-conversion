export interface QuietHours {
  start: string;
  end: string;
}

const toMinutes = (hhmm: string): number => {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export function minutesOfDay(timeZone: string, at: Date): number {
  const hhmm = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
  return toMinutes(hhmm) % 1440;
}

/** Quiet hours may wrap midnight (21:00–08:00). */
export function inQuietHours(timeZone: string, quiet?: QuietHours, at: Date = new Date()): boolean {
  if (!quiet) return false;
  const now = minutesOfDay(timeZone, at);
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  return start > end ? now >= start || now < end : now >= start && now < end;
}

/** `at`, or the end of the quiet window it falls in. */
export function nextAllowedAt(timeZone: string, quiet: QuietHours | undefined, at: Date): Date {
  if (!quiet || !inQuietHours(timeZone, quiet, at)) return at;
  const now = minutesOfDay(timeZone, at);
  const end = toMinutes(quiet.end);
  const minutesUntilEnd = end > now ? end - now : 1440 - now + end;
  return new Date(at.getTime() + minutesUntilEnd * 60_000);
}
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** 0 (Sunday) to 6 (Saturday), in `timeZone`. */
export function weekdayOf(timeZone: string, at: Date): number {
  return WEEKDAYS.indexOf(new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(at));
}

/** The first instant of the local day after the one `at` falls in. */
export function nextLocalMidnight(timeZone: string, at: Date): Date {
  return new Date(at.getTime() + (1440 - minutesOfDay(timeZone, at)) * 60_000 - (at.getTime() % 60_000));
}

/**
 * `at`, or the first moment after it when the lead may be contacted: outside
 * quiet hours and not on a day the organization skips (0 = Sunday).
 */
export function nextContactAt(timeZone: string, quiet: QuietHours | undefined, skipDays: readonly number[] | undefined, at: Date): Date {
  let t = nextAllowedAt(timeZone, quiet, at);
  if (!skipDays?.length || skipDays.length >= 7) return t;
  for (let i = 0; i < 7 && skipDays.includes(weekdayOf(timeZone, t)); i++) {
    t = nextAllowedAt(timeZone, quiet, nextLocalMidnight(timeZone, t));
  }
  return t;
}
