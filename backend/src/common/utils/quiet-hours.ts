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

/**
 * Pushes the remaining cadence back by however long quiet hours held a step,
 * so the gaps between steps stay as configured.
 */
export function deferredResume(args: {
  timeZone: string;
  quiet: QuietHours | undefined;
  now: number;
  enrolledAt: number;
  offset: number;
  shift: number;
}): { shift: number; resumeAt: number } {
  const { timeZone, quiet, now, enrolledAt, offset } = args;
  const nominal = enrolledAt + offset + args.shift;
  const opensAt = nextAllowedAt(timeZone, quiet, new Date(now)).getTime();
  const shift = nominal < opensAt ? args.shift + (opensAt - nominal) : args.shift;
  return { shift, resumeAt: enrolledAt + offset + shift };
}