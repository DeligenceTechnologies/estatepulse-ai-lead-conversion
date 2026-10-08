/**
 * Time handling for in-call booking, kept pure so it can be tested without a
 * clock or a network: the AI speaks in the office's local time, Calendly
 * speaks UTC, and every conversion between them happens here.
 *
 * Tested in booking-time.spec.ts.
 */

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Minutes the zone is ahead of UTC at `at` (e.g. America/Chicago in October → -300). */
function offsetMinutes(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** The UTC instant of a wall-clock time in a zone. Correct across DST changes. */
export function zonedToUtc(date: string, time: string, timeZone: string): Date {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  // Two passes: the offset at the guess, then at the corrected instant, so a
  // time on a DST-change day lands on the right side of the change.
  const first = guess - offsetMinutes(timeZone, new Date(guess)) * 60_000;
  return new Date(guess - offsetMinutes(timeZone, new Date(first)) * 60_000);
}

/** YYYY-MM-DD of `at` in the zone. */
export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * What the caller said about the day, as a local date: YYYY-MM-DD, "today",
 * "tomorrow", or a weekday name (the next one, today included). Null when it
 * is none of those, so the caller can be asked again rather than guessed at.
 */
export function resolveDay(input: string | undefined, now: Date, timeZone: string): string | null {
  const today = localDate(now, timeZone);
  const v = input?.trim().toLowerCase();
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  if (v === 'today') return today;
  if (v === 'tomorrow') return addDays(today, 1);
  const wanted = WEEKDAYS.indexOf(v);
  if (wanted >= 0) {
    const [y, m, d] = today.split('-').map(Number);
    const todayIdx = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return addDays(today, (wanted - todayIdx + 7) % 7);
  }
  return null;
}

/** "HH:MM" (24h), or null. */
export function parseTime(input: string | undefined): string | null {
  const m = input?.trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

/**
 * The UTC window to ask Calendly about: one local day, or the next `spanDays`
 * days when no day was given. Calendly rejects a start in the past, so the
 * window never starts before `now` (plus a minute); null when the day is over.
 */
export function searchWindow(
  day: string | null,
  now: Date,
  timeZone: string,
  spanDays = 7,
): { start: Date; end: Date } | null {
  const soonest = new Date(now.getTime() + 60_000);
  const start = day ? zonedToUtc(day, '00:00', timeZone) : soonest;
  const end = day ? zonedToUtc(addDays(day, 1), '00:00', timeZone) : new Date(now.getTime() + spanDays * 86_400_000);
  const from = start < soonest ? soonest : start;
  return from < end ? { start: from, end } : null;
}

/** "Wednesday, October 8 at 3:00 PM" in the office's zone — what the AI reads out. */
export function spoken(at: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', month: 'long', day: 'numeric' }).format(at);
  const time = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(at);
  return `${day} at ${time}`;
}

/**
 * Which open times to offer: the requested one first if it is open, otherwise
 * the ones closest to it; with no requested time, simply the earliest.
 */
export function pickSlots(slots: Date[], preferred: Date | null, max: number): Date[] {
  const sorted = [...slots].sort((a, b) => a.getTime() - b.getTime());
  if (!preferred) return sorted.slice(0, max);
  return sorted
    .sort((a, b) => Math.abs(a.getTime() - preferred.getTime()) - Math.abs(b.getTime() - preferred.getTime()))
    .slice(0, max)
    .sort((a, b) => a.getTime() - b.getTime());
}
