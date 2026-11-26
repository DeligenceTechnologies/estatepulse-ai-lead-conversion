import { ApiError, apiFetch } from '../lib/api';

/**
 * Outreach scheduling (the backend's OUTREACH_SCHEDULING_ENABLED). Switched off,
 * every endpoint answers 404. `getOutreachConfig` asks the capability flag first and,
 * when it is off, resolves to null without calling them.
 */

export interface OutreachConfig {
  timeZone: string;
  /** Null when the organization does not hold outreach back at night. */
  quietHours: { start: string; end: string } | null;
  /** The concurrent call limit the call worker enforces (Call Capacity card). */
  maxConcurrentCalls: number;
  reservedCallSlots: number;
}

const BASE = '/outreach';

// One question per page load, however many screens ask; forgotten after a failure so the next one asks again.
let enabledOnce: Promise<boolean> | null = null;

/** Whether the server has outreach scheduling on. A server from before the flag existed answers 404: off. */
const outreachSchedulingEnabled = (): Promise<boolean> =>
  (enabledOnce ??= apiFetch<{ enabled: boolean }>(`${BASE}/enabled`, { auth: true })
    .then((r) => r.enabled)
    .catch((e) => {
      enabledOnce = null;
      if (e instanceof ApiError && e.status === 404) return false;
      throw e;
    }));

export const getOutreachConfig = async (): Promise<OutreachConfig | null> => {
  if (!(await outreachSchedulingEnabled())) return null;
  return apiFetch<OutreachConfig>(`${BASE}/config`, { auth: true }).catch((e) => {
    // Switched off between the two calls: the same as off.
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  });
};

/** When a batch launches, in its own zone, e.g. "Tue, Oct 21, 6:00 PM IST". */
export function startLabel(startAt: string, timeZone: string): string {
  return new Date(startAt).toLocaleString('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}
