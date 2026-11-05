import { legalWindows } from './call-windows';
import { contactZone, jurisdictionCode, type LeadZone } from './lead-timezone';
import { addDays, localDate, wallMinutes, weekday, zonedToInstant } from './zoned-time';

export interface QuietHours {
  start: string;
  end: string;
}

const toMinutes = (hhmm: string): number => {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export function minutesOfDay(timeZone: string, at: Date): number {
  return wallMinutes(at.getTime(), timeZone);
}

/** Quiet hours may wrap midnight (21:00–08:00). */
export function inQuietHours(timeZone: string, quiet?: QuietHours, at: Date = new Date()): boolean {
  if (!quiet) return false;
  const now = minutesOfDay(timeZone, at);
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  return start > end ? now >= start || now < end : now >= start && now < end;
}

/** `at`, or the end of the quiet window it falls in: the wall-clock end today or tomorrow, exact across a DST change. */
export function nextAllowedAt(timeZone: string, quiet: QuietHours | undefined, at: Date): Date {
  if (!quiet || !inQuietHours(timeZone, quiet, at)) return at;
  const now = minutesOfDay(timeZone, at);
  const end = toMinutes(quiet.end);
  const today = localDate(at.getTime(), timeZone);
  return new Date(zonedToInstant(end > now ? today : addDays(today, 1), end, timeZone));
}
/** 0 (Sunday) to 6 (Saturday), in `timeZone`. */
export function weekdayOf(timeZone: string, at: Date): number {
  return weekday(localDate(at.getTime(), timeZone));
}

/** The first instant of the local day after the one `at` falls in. */
export function nextLocalMidnight(timeZone: string, at: Date): Date {
  return new Date(zonedToInstant(addDays(localDate(at.getTime(), timeZone), 1), 0, timeZone));
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

/** How long a lead whose zone is unknown or disputed waits before the gate looks again. */
export const TZ_RECHECK_MS = 60 * 60_000;

/** The organization's part of the contact window; the law's part comes from the lead's jurisdiction. */
export interface ContactRules {
  /** Undefined when the organization switched quiet hours off; the legal windows still apply. */
  quiet?: QuietHours;
  /** 0 = Sunday … 6 = Saturday; every day skipped counts as none, as in `nextContactAt`. */
  skipDays: readonly number[];
}

export type ContactVerdict =
  /** `reason` names what moved the time when `allowedAt` is later than asked; null when it is not. */
  | { allowedAt: Date; reason: string | null }
  /** Nothing to measure against: `reason` is the full sentence to show (no usable phone, or a zone a person must set). */
  | { allowedAt: null; reason: string };

/** One line per gate decision, the same shape everywhere; ids and zones only, never a phone number or a name. */
export function gateLine(orgId: string, leadId: string, z: LeadZone, verdict: ContactVerdict, action: 'allowed' | 'deferred' | 'held'): string {
  const next = verdict.allowedAt ? verdict.allowedAt.toISOString() : 'none';
  return `contact gate org=${orgId} lead=${leadId} zone=${z.zone ?? 'none'} status=${z.status} jurisdiction=${jurisdictionCode(z)} restriction=${verdict.reason ?? 'none'} next=${next} action=${action}`;
}

/** Each pass settles, or moves to a window's end or the next midnight: at most two passes per local day, so three weeks fit. */
const MAX_PASSES = 42;

/**
 * `at`, or the first moment after it when the lead may be contacted, on the
 * LEAD's clock: outside the organization's quiet hours, inside every legal
 * calling window for the lead's jurisdiction, and not on a day the
 * organization skips or the law closes. A callback the lead asked for keeps
 * to the hours but not to the organization's days off.
 */
export function nextLeadContactAt(z: LeadZone, rules: ContactRules, at: Date, opts: { callback?: boolean } = {}): ContactVerdict {
  const zone = contactZone(z);
  if (!zone) {
    return { allowedAt: null, reason: z.hasPhone ? `Waiting for the lead's time zone to be set: ${z.reason}` : 'No usable phone number to call or text' };
  }
  const skipDays = rules.skipDays.length >= 7 ? [] : rules.skipDays;
  let t = at;
  let reason: string | null = null;
  // ponytail: bounded fixpoint rather than interval algebra; the windows can differ by weekday, so each day is looked at on its own.
  for (let i = 0; i < MAX_PASSES; i++) {
    const weekday = weekdayOf(zone, t);
    const legal = legalWindows(z.jurisdiction, zone, weekday);
    if (legal.closedBy) {
      t = nextLocalMidnight(zone, t);
      reason = `No calls on this day (${legal.closedBy})`;
      continue;
    }
    if (!opts.callback && skipDays.includes(weekday)) {
      t = nextLocalMidnight(zone, t);
      reason = 'A day the organization skips';
      continue;
    }
    const windows = [...(rules.quiet ? [{ hours: rules.quiet, rule: 'Quiet hours' }] : []), ...legal.quiet.map((w) => ({ hours: w.hours, rule: `Legal calling hours (${w.rule})` }))];
    let next = t;
    let moved: string | null = null;
    for (const w of windows) {
      const n = nextAllowedAt(zone, w.hours, t);
      if (n.getTime() > next.getTime()) {
        next = n;
        moved = w.rule;
      }
    }
    if (next.getTime() === t.getTime()) return { allowedAt: t, reason };
    // A window reaching into tomorrow is cut at midnight: tomorrow's own rules (a weekend's, a Sunday's) decide its morning.
    const midnight = nextLocalMidnight(zone, t);
    t = next.getTime() >= midnight.getTime() ? midnight : next;
    reason = moved;
  }
  return { allowedAt: t, reason };
}
