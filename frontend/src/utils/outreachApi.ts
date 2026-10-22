import { ApiError, apiFetch } from '../lib/api';

/**
 * "Call now / schedule" for approved imports (the backend's OUTREACH_SCHEDULING_ENABLED).
 * Switched off, every endpoint answers 404: `getOutreachConfig` then resolves
 * to null and the screens behave exactly as before.
 */

export type OutreachMode = 'now' | 'scheduled';

export interface OutreachChoice {
  mode: OutreachMode;
  /** Scheduled only: a wall-clock date (YYYY-MM-DD), time (HH:mm) and IANA zone. */
  date?: string;
  time?: string;
  timeZone?: string;
}

export interface OutreachSummary {
  batchId: string;
  mode: OutreachMode;
  startAt: string;
  timeZone: string;
  queued: number;
}

export interface OutreachConfig {
  timeZone: string;
  /** Null when the organization does not hold outreach back at night. */
  quietHours: { start: string; end: string } | null;
  /** The concurrent call limit the call worker enforces (Call Capacity card). */
  maxConcurrentCalls: number;
  reservedCallSlots: number;
}

export type OutreachBatchStatus = 'pending' | 'running' | 'completed' | 'cancelled';

export interface OutreachBatch {
  id: string;
  mode: OutreachMode;
  status: OutreachBatchStatus;
  startAt: string;
  timeZone: string;
  total: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  /** `removed`: leads of the batch deleted since it launched. */
  progress: { called: number; failed: number; pending: number; skipped: number; cancelled: number; removed: number };
}

const BASE = '/outreach';

export const getOutreachConfig = (): Promise<OutreachConfig | null> =>
  apiFetch<OutreachConfig>(`${BASE}/config`, { auth: true }).catch((e) => {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  });

export const listOutreachBatches = (): Promise<OutreachBatch[]> =>
  apiFetch<{ items: OutreachBatch[] }>(`${BASE}/batches`, { auth: true }).then((r) => r.items);

export const cancelOutreachBatch = (id: string): Promise<{ cancelled: true; notStarted: number; repaused: number }> =>
  apiFetch(`${BASE}/batches/${id}/cancel`, { method: 'POST', auth: true });

export const rescheduleOutreachBatch = (id: string, when: { date: string; time: string; timeZone: string }): Promise<{ id: string; startAt: string; timeZone: string }> =>
  apiFetch(`${BASE}/batches/${id}/reschedule`, { method: 'POST', body: when, auth: true });

/** The wall clock in `timeZone` right now, as "YYYY-MM-DD HH:mm" — comparable as a string. */
export function wallClockNow(timeZone: string, now = new Date()): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** When a batch launches, in its own zone, e.g. "Tue, Oct 21, 6:00 PM IST". */
export function startLabel(startAt: string, timeZone: string): string {
  return new Date(startAt).toLocaleString('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}
