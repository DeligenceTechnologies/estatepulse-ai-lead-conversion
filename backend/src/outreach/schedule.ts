import { httpError } from '@/common/errors/app-error';
import { minutesOfDay } from '@/common/utils/quiet-hours';
import { isTimeZone, minutesOf, zonedToInstant } from '@/common/utils/zoned-time';
import { stepOffsets, type StrategyStep } from '@/telnyx/strategy-store.service';

export type OutreachMode = 'now' | 'scheduled';

/**
 * The owner's launch choice on an approval. An import approves in chunks; the
 * first chunk that queues a lead creates the batch and the rest join it, so
 * the request carries the batch id and running counts between them.
 */
export interface OutreachRequest {
  mode: OutreachMode;
  startAt: Date;
  timeZone: string;
  by: { userId: string };
  batchId?: string;
  queued?: number;
  held?: number;
}

export interface OutreachSummary {
  batchId: string;
  mode: OutreachMode;
  startAt: string;
  timeZone: string;
  queued: number;
}

export const summaryOf = (r: OutreachRequest | undefined): OutreachSummary | undefined =>
  r?.batchId ? { batchId: r.batchId, mode: r.mode, startAt: r.startAt.toISOString(), timeZone: r.timeZone, queued: r.queued ?? 0 } : undefined;

/**
 * A wall-clock date and time in `timeZone` as an instant, which must be in the
 * future. A time that a spring-forward skips (02:30 in New York on the change
 * day) moves forward by the gap, to 03:30; one that falls-back repeats takes
 * its first occurrence.
 */
export function scheduledStart(date: string, time: string, timeZone: string, now: Date): Date {
  if (!isTimeZone(timeZone)) throw httpError(400, 'INVALID_TIMEZONE', 'Pick a valid time zone.');
  const [y, m, d] = date.split('-').map(Number);
  if (new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) !== date) throw httpError(400, 'INVALID_SCHEDULE', 'That date does not exist.');
  const wanted = minutesOf(time);
  let at = zonedToInstant(date, wanted, timeZone);
  const landed = minutesOfDay(timeZone, new Date(at));
  if (landed !== wanted) at += (((wanted - landed) % 1440) + 1440) % 1440 * 60_000;
  if (at <= now.getTime()) throw httpError(400, 'SCHEDULE_IN_PAST', 'That time has already passed. Pick a time in the future.');
  return new Date(at);
}

/**
 * How many more batch leads may be released now without the org's live AI calls
 * passing its limit. The reserve is capped one below the limit: lowering the
 * call limit under it slows a batch to one call at a time, never stops it.
 */
export function releaseCapacity(p: { maxConcurrent: number; reserved: number; activeCalls: number; awaitingCall: number }): number {
  const reserved = Math.min(p.reserved, Math.max(0, p.maxConcurrent - 1));
  return Math.max(0, p.maxConcurrent - reserved - p.activeCalls - p.awaitingCall);
}

/**
 * How long a released lead holds a call slot before its first call is on
 * record: the strategy's first voice step plus a margin for the watcher's
 * poll. Zero when the strategy places no calls, so nothing waits on a slot.
 */
// ponytail: only the first voice attempt is counted; later attempts (maxVoiceAttempts) wait in the call queue, whose worker enforces the limit. Count per-step if release pacing must account for them.
export function awaitingWindowMs(steps: StrategyStep[]): number {
  const offsets = stepOffsets(steps);
  const first = steps.findIndex((s) => s.channel === 'voice');
  return first < 0 ? 0 : offsets[first] + 5 * 60_000;
}
