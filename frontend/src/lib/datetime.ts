/**
 * Every date and time the app shows is in one zone: the signed-in user's
 * profile timezone (users.timezone), else this device's. The server stores
 * instants in UTC; this is the only place they become wall-clock time.
 *
 * AuthProvider sets the zone as soon as it knows the user, before any screen
 * renders, so plain functions here (not hooks) are safe to call anywhere.
 */

const FALLBACK_ZONE = 'UTC';

export const isTimeZone = (zone: string | null | undefined): zone is string => {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

export const deviceTimeZone = (): string => {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isTimeZone(zone) ? zone : FALLBACK_ZONE;
  } catch {
    return FALLBACK_ZONE;
  }
};

let zone = deviceTimeZone();

/** Called by AuthProvider with the user's profile timezone; an unknown or missing one keeps the device's. */
export const setDisplayTimeZone = (timeZone: string | null | undefined): void => {
  zone = isTimeZone(timeZone) ? timeZone : deviceTimeZone();
};

/** The zone every screen shows times in. */
export const displayTimeZone = (): string => zone;

type DateInput = string | number | Date;

const toDate = (value: DateInput): Date => (value instanceof Date ? value : new Date(value));

const formatters = new Map<string, Intl.DateTimeFormat>();

/** A formatter for the display zone (or `options.timeZone`), cached: building one is slow. */
export const formatterFor = (options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat => {
  const resolved = { ...options, timeZone: options.timeZone ?? zone };
  const key = JSON.stringify(resolved);
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(undefined, resolved);
    formatters.set(key, formatter);
  }
  return formatter;
};

const format = (value: DateInput, options: Intl.DateTimeFormatOptions): string => {
  const date = toDate(value);
  return Number.isNaN(date.getTime()) ? '—' : formatterFor(options).format(date);
};

/** "14 Oct 2026" by default. */
export const formatDate = (
  value: DateInput,
  options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' },
): string => format(value, options);

/** "3:20 PM" by default. */
export const formatTime = (value: DateInput, options: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' }): string =>
  format(value, options);

/** "14 Oct 2026, 3:20 PM" by default. */
export const formatDateTime = (
  value: DateInput,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
): string => format(value, options);

/** "GMT+5:30" for `timeZone` (the display zone by default) at `at`; '' for an unknown zone. */
export const zoneOffsetLabel = (timeZone: string = zone, at: DateInput = Date.now()): string => {
  try {
    return (
      formatterFor({ timeZone, timeZoneName: 'shortOffset' })
        .formatToParts(toDate(at))
        .find((part) => part.type === 'timeZoneName')?.value ?? ''
    );
  } catch {
    return '';
  }
};

// ---- Calendar days in the display zone -------------------------------------
// A "day" is the instant its midnight falls on in the display zone, so days
// compare with === and step across DST changes correctly.

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const partsIn = (instant: number, timeZone: string): Parts => {
  const values: Record<string, number> = {};
  for (const part of formatterFor({
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour === 24 ? 0 : values.hour,
    minute: values.minute,
    second: values.second,
  };
};

/** How far `timeZone` is ahead of UTC at `instant`, in ms. */
const offsetAt = (instant: number, timeZone: string): number => {
  const p = partsIn(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
};

/** The instant a wall-clock time in `timeZone` falls on. */
const zonedInstant = (year: number, month: number, day: number, timeZone: string): number => {
  const guess = Date.UTC(year, month - 1, day);
  const first = guess - offsetAt(guess, timeZone);
  // A second pass settles a DST change between the guess and the answer.
  return guess - offsetAt(first, timeZone);
};

/** Midnight of the day `time` falls on, in the display zone. */
export const startOfDay = (time: DateInput): number => {
  const p = partsIn(toDate(time).getTime(), zone);
  return zonedInstant(p.year, p.month, p.day, zone);
};

/** Midnight `days` calendar days after the day `day` falls on, in the display zone. */
export const addDays = (day: DateInput, days: number): number => {
  const p = partsIn(toDate(day).getTime(), zone);
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return zonedInstant(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), zone);
};

/** 0 = Sunday .. 6 = Saturday, in the display zone. */
export const weekdayOf = (time: DateInput): number => {
  const p = partsIn(toDate(time).getTime(), zone);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
};

/** The calendar year `time` falls in, in the display zone. */
export const yearOf = (time: DateInput): number => partsIn(toDate(time).getTime(), zone).year;

/** 'YYYY-MM-DD' of the day `time` falls on, in the display zone (for date inputs). */
export const isoDateOf = (time: DateInput): string => {
  const p = partsIn(toDate(time).getTime(), zone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
};

/** Midnight of a 'YYYY-MM-DD' date in the display zone; null when it is not a date. */
export const dayFromIsoDate = (date: string): number | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  return zonedInstant(Number(match[1]), Number(match[2]), Number(match[3]), zone);
};
