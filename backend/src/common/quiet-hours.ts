/**
 * The compliance gate: when we are allowed to contact somebody.
 *
 * Shared because there are now two schedulers that must agree. The strategy
 * engine asks "may I send this right now, and if not I will ask again in
 * fifteen minutes"; the follow-up runner cannot do that — its steps are days
 * apart and it holds nothing in memory — so it asks "what is the next moment I
 * am allowed to send" and writes that answer to `next_action_at`. Two functions,
 * one definition of the window.
 */

export interface QuietHours {
  /** 'HH:MM', 24-hour, in the organization's timezone. */
  start: string;
  end: string;
}

const DEFAULT_TZ = 'America/Chicago';

const toMinutes = (hhmm: string): number => {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** Minutes past midnight, as the clock on the wall in `tz` reads at `at`. */
export function minutesOfDay(tz: string, at: Date): number {
  const hhmm = new Intl.DateTimeFormat('en-US', {
    timeZone: tz || DEFAULT_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
  return toMinutes(hhmm);
}

/**
 * Is `at` inside the quiet window?
 *
 * The window usually wraps midnight (21:00 → 08:00), which is why this is not
 * a simple range check: for a wrapping window the inside is the union of the
 * two ends of the day, not the span between them.
 */
export function inQuietHours(tz: string, quiet?: QuietHours, at: Date = new Date()): boolean {
  if (!quiet) return false;
  const now = minutesOfDay(tz, at);
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  return start > end ? now >= start || now < end : now >= start && now < end;
}

/**
 * The first moment at or after `at` that is outside the quiet window.
 *
 * Returns `at` unchanged when we are already allowed to send, so a caller can
 * apply it unconditionally. Deliberately pushes forward rather than skipping
 * the step: a message due at 3am is late, not cancelled.
 *
 * Computed by adding the number of minutes until the window's end, rather than
 * by constructing a date in the target timezone — which cannot be done without
 * a timezone library. The one case this gets wrong is a step that lands across
 * a DST transition, which arrives an hour early or late; for a nurture cadence
 * measured in days that is not worth a dependency.
 */
export function nextAllowedAt(tz: string, quiet: QuietHours | undefined, at: Date): Date {
  if (!inQuietHours(tz, quiet, at) || !quiet) return at;

  const now = minutesOfDay(tz, at);
  const end = toMinutes(quiet.end);
  const minutesUntilEnd = end > now ? end - now : 1440 - now + end;
  return new Date(at.getTime() + minutesUntilEnd * 60_000);
}

/**
 * Where a step pushed out of the quiet window should land, and how far that
 * moves the rest of its cadence.
 *
 * The strategy engine schedules every step as its own timer measured from
 * enrolment, so a lead arriving in the middle of the night has ALL of them come
 * due while sending is illegal. Resuming each one independently at the moment
 * the window opens made them fire together — a 0 / 30min / 2h cadence arrived as
 * three messages inside a quarter of an hour.
 *
 * The fix is one shift for the whole enrolment rather than one decision per
 * step: whatever a step needs to clear the window is applied to every step, so
 * the gaps between them survive intact. A step whose nominal time is already
 * past the opening does not move the shift, so a cadence clipped only at one end
 * is not pushed twice.
 *
 * Returns the new accumulated shift and the absolute time this step should run.
 */
export function deferredResume(args: {
  tz: string;
  quiet: QuietHours | undefined;
  /** Now, as ms. */
  now: number;
  /** When the enrolment began, as ms. */
  enrolledAt: number;
  /** This step's offset from enrolment, in ms. */
  offset: number;
  /** The shift already applied to this enrolment, in ms. */
  shift: number;
}): { shift: number; resumeAt: number } {
  const { tz, quiet, now, enrolledAt, offset } = args;
  const nominal = enrolledAt + offset + args.shift;
  const opensAt = nextAllowedAt(tz, quiet, new Date(now)).getTime();
  const shift = nominal < opensAt ? args.shift + (opensAt - nominal) : args.shift;
  return { shift, resumeAt: enrolledAt + offset + shift };
}
