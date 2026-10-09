/**
 * A member's weekly working hours: one entry per day, wall-clock in the
 * member's own timezone. Same shape as the backend's `users.working_hours`
 * (and the agent availability screen), so a future scheduling module can read
 * it as is.
 */
export interface WorkingDay {
  /** 0 = Sunday .. 6 = Saturday. */
  dayOfWeek: number;
  isAvailable: boolean;
  /** 'HH:MM', 24-hour. Kept on a day off so switching it back on restores the hours. */
  startTime: string;
  endTime: string;
}

export const DEFAULT_START = '09:00';
export const DEFAULT_END = '18:00';

/** What the server gives every new member: Monday-Friday 09:00-18:00, weekend off. */
export const DEFAULT_WORKING_HOURS: WorkingDay[] = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
  dayOfWeek,
  isAvailable: dayOfWeek >= 1 && dayOfWeek <= 5,
  startTime: DEFAULT_START,
  endTime: DEFAULT_END,
}));

/** Monday first, the way a working week reads. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
export const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export const DAY_LETTER = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const;

/** Seven days, Sunday first, whatever the server sent (missing days fall back to the default). */
export function normalizeWeek(days: readonly WorkingDay[] | null | undefined): WorkingDay[] {
  return DEFAULT_WORKING_HOURS.map((fallback) => days?.find((d) => d.dayOfWeek === fallback.dayOfWeek) ?? fallback);
}

/** '18:00' -> '6 PM', '09:30' -> '9:30 AM'. */
export function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return m ? `${hour}:${String(m).padStart(2, '0')} ${suffix}` : `${hour} ${suffix}`;
}

/**
 * One line for the whole week: "Mon–Fri · 9 AM – 6 PM". Days sharing the same
 * hours are grouped into runs; differing hours list each group.
 */
export function summarizeWeek(days: readonly WorkingDay[]): string {
  const week = normalizeWeek(days);
  const on = WEEK_ORDER.map((d) => week[d]).filter((d) => d.isAvailable);
  if (on.length === 0) return 'No working days';

  const groups = new Map<string, number[]>();
  for (const day of on) {
    const key = `${day.startTime}-${day.endTime}`;
    groups.set(key, [...(groups.get(key) ?? []), day.dayOfWeek]);
  }
  return [...groups.entries()]
    .map(([key, dayList]) => {
      const [start, end] = key.split('-');
      return `${dayRuns(dayList)} · ${formatTime(start)} – ${formatTime(end)}`;
    })
    .join(', ');
}

/** [1,2,3,5] -> "Mon–Wed, Fri", in Monday-first order. */
function dayRuns(dayList: number[]): string {
  const positions = dayList.map((d) => WEEK_ORDER.indexOf(d as (typeof WEEK_ORDER)[number])).sort((a, b) => a - b);
  const runs: string[] = [];
  let start = positions[0];
  for (let i = 1; i <= positions.length; i++) {
    if (positions[i] !== positions[i - 1] + 1) {
      const end = positions[i - 1];
      const first = DAY_SHORT[WEEK_ORDER[start]];
      const last = DAY_SHORT[WEEK_ORDER[end]];
      runs.push(start === end ? first : `${first}–${last}`);
      start = positions[i];
    }
  }
  return runs.join(', ');
}

/** '09:30' -> 570. */
export const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** Total scheduled hours in the week, e.g. 45. */
export function weeklyHours(days: readonly WorkingDay[]): number {
  const minutes = toMinutes;
  const total = normalizeWeek(days)
    .filter((d) => d.isAvailable)
    .reduce((sum, d) => sum + Math.max(0, minutes(d.endTime) - minutes(d.startTime)), 0);
  return Math.round((total / 60) * 10) / 10;
}

/** The day of week and 'HH:MM' it is right now in `timeZone`. */
export function nowIn(timeZone: string, now = new Date()): { dayOfWeek: number; time: string } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
    return {
      dayOfWeek: (DAY_SHORT as readonly string[]).indexOf(get('weekday')),
      time: `${get('hour')}:${get('minute')}`,
    };
  } catch {
    return null;
  }
}

/** Whether the member is inside their working hours at this moment, in their own timezone. */
export function isWorkingNow(days: readonly WorkingDay[], timeZone: string, now = new Date()): boolean {
  const current = nowIn(timeZone, now);
  if (!current) return false;
  const today = normalizeWeek(days)[current.dayOfWeek];
  return Boolean(today?.isAvailable && current.time >= today.startTime && current.time < today.endTime);
}

/** "3:42 PM" in `timeZone`, or null for a zone the browser does not know. */
export function localTimeIn(timeZone: string, now = new Date()): string | null {
  try {
    return now.toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit' });
  } catch {
    return null;
  }
}

/** "GMT+5:30" for `timeZone`. */
export function utcOffset(timeZone: string, now = new Date()): string {
  try {
    return (
      new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' })
        .formatToParts(now)
        .find((p) => p.type === 'timeZoneName')?.value ?? ''
    );
  } catch {
    return '';
  }
}

/** Every IANA zone the browser knows, with the common default guaranteed present. */
export function allTimeZones(): string[] {
  const zones =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['Asia/Kolkata', 'UTC'];
  return zones.includes('Asia/Kolkata') ? zones : ['Asia/Kolkata', ...zones];
}
