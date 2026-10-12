import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A polled read that behaves itself.
 *
 * This replaces the bare `setInterval(load, 5000)` the live views used to run.
 * Four behaviours, each of which fixes something that cost us real requests or
 * real data:
 *
 *  - **Nothing polls while the tab is hidden.** A dashboard left open in a
 *    background tab was the single largest source of traffic we had, and nobody
 *    was looking at it. Coming back refetches immediately, so the pause is
 *    invisible.
 *  - **The interval backs off while the payload is unchanged** and snaps back to
 *    the fast cadence the moment something differs, the tab regains focus, or
 *    the user asks. An idle screen costs about one request a minute instead of
 *    twelve.
 *  - **One request in flight at a time.** `setInterval` kept firing into a slow
 *    network and stacked ticks on top of each other, which is how a brief
 *    slowdown turned into a burst.
 *  - **A failed poll never clears data that is already on screen.** The previous
 *    code did `setLiveLeads([])` in its catch, so one rate-limited request made
 *    a working table look like an empty account. Whatever is rendered is still
 *    the best answer we have; `stale` is how the UI says so quietly.
 *
 * Why polling at all, given the backend knows exactly when a webhook lands: this
 * stays as the fallback for when the event stream is unavailable — a proxy that
 * buffers, a reconnect in progress, an older deployment. The backoff is what
 * makes it cheap enough to leave running underneath the push path.
 */

export interface LiveQueryOptions {
  /** Cadence right after a change, a manual refresh, or regaining focus. */
  baseIntervalMs?: number;
  /** Ceiling the backoff climbs to while the payload keeps coming back identical. */
  maxIntervalMs?: number;
  /** False suspends the loop entirely (an auto-refresh toggle, say). */
  enabled?: boolean;
  /**
   * Identifies *what* is being fetched. Changing it discards the current data
   * and refetches at once, because data belonging to the previously selected
   * thing is not stale — it is wrong.
   */
  refreshKey?: string | number | null;
}

export interface LiveQueryResult<T> {
  data: T | null;
  /** Last failure. Set alongside `data` rather than replacing it. */
  error: string | null;
  /** A refresh the user explicitly asked for is in flight. Drives the spinner. */
  refreshing: boolean;
  /** The last poll failed but we are still showing the previous good data. */
  stale: boolean;
  /** Refetch now and return to the fast cadence. */
  refresh: () => void;
  /** Same, for the push path: an event says something changed, so go look. */
  invalidate: () => void;
}

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function useLiveQuery<T>(
  /** Must be stable (`useCallback`), or nothing here can hold a cadence. */
  fetcher: () => Promise<T>,
  options: LiveQueryOptions = {},
): LiveQueryResult<T> {
  const { baseIntervalMs = 5000, maxIntervalMs = 60_000, enabled = true, refreshKey = null } = options;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Refs throughout: none of this may re-render the component or restart the
  // loop. `fetcher` in particular is read through a ref so that a caller who
  // forgets `useCallback` degrades to a stale closure rather than to a tight
  // reschedule loop.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  // The cadence too: a caller may change it while mounted (LeadsView slows down
  // while its live stream is up). That re-times the next poll — see the effect
  // below the main one — rather than restarting the query, which would clear
  // `data` and refetch.
  const baseRef = useRef(baseIntervalMs);
  baseRef.current = baseIntervalMs;
  const maxRef = useRef(maxIntervalMs);
  maxRef.current = maxIntervalMs;

  const alive = useRef(true);
  const inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const delay = useRef(baseIntervalMs);
  const lastPayload = useRef<string | null>(null);
  const run = useRef<(reason: 'auto' | 'manual') => Promise<void>>(async () => {});
  const reschedule = useRef<() => void>(() => {});

  useEffect(() => {
    alive.current = true;
    delay.current = baseRef.current;
    // A different key means different data. Forget what the last one returned so
    // an identical-looking payload is not mistaken for "nothing changed".
    lastPayload.current = null;
    setData(null);
    setError(null);

    const clear = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };

    const schedule = () => {
      clear();
      // A hidden tab schedules nothing at all. `visibilitychange` restarts it.
      if (!alive.current || !enabled || hidden()) return;
      timer.current = setTimeout(() => void tick('auto'), delay.current);
    };

    const tick = async (reason: 'auto' | 'manual') => {
      if (!alive.current || !enabled) return;
      // Single-flight. Returning rather than queueing is deliberate: the next
      // scheduled tick is a few seconds away and asks the same question.
      if (inFlight.current) return;

      inFlight.current = true;
      if (reason === 'manual') setRefreshing(true);

      try {
        const next = await fetcherRef.current();
        if (!alive.current) return;

        // One serialization drives both the render skip and the backoff, so the
        // cost of the comparison buys two things rather than one.
        const encoded = JSON.stringify(next) ?? '';
        if (encoded === lastPayload.current) {
          delay.current = Math.min(delay.current * 2, maxRef.current);
        } else {
          lastPayload.current = encoded;
          setData(next);
          // Something moved. Watch closely again — activity comes in bursts.
          delay.current = baseRef.current;
        }
        setError(null);
      } catch (e) {
        if (!alive.current) return;
        setError(messageOf(e));
        // NOT clearing `data`. See the header: blanking the screen on a blip is
        // how a transient 429 reads as "you have no leads".
        //
        // Backing off on failure matters more than on success: the most likely
        // cause is that we are being rate-limited, and retrying at full speed is
        // what got us limited.
        delay.current = Math.min(Math.max(delay.current, baseRef.current) * 2, maxRef.current);
      } finally {
        inFlight.current = false;
        if (reason === 'manual' && alive.current) setRefreshing(false);
        schedule();
      }
    };

    run.current = tick;
    reschedule.current = schedule;

    const onVisibility = () => {
      if (hidden()) {
        clear();
        return;
      }
      // Back from a hidden tab. The data is as old as the time away, so refetch
      // now and resume fast rather than wherever the backoff had climbed to.
      delay.current = baseRef.current;
      void tick('auto');
    };

    document.addEventListener('visibilitychange', onVisibility);
    if (enabled && !hidden()) void tick('auto');

    return () => {
      alive.current = false;
      clear();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, refreshKey]);

  // A new cadence applies from now: the pending poll is re-timed at the new
  // base, through the same single timer, so a switch can never leave two loops
  // running. No fetch and no reset — nothing about the data changed. A tick in
  // flight picks the new cadence up when it schedules its successor. On mount
  // this finds the first tick in flight and does nothing.
  useEffect(() => {
    delay.current = baseIntervalMs;
    if (!inFlight.current) reschedule.current();
  }, [baseIntervalMs, maxIntervalMs]);

  const refresh = useCallback(() => {
    delay.current = baseRef.current;
    void run.current('manual');
  }, []);

  /** The push path's entry point: silent, so no spinner flashes on every event. */
  const invalidate = useCallback(() => {
    delay.current = baseRef.current;
    void run.current('auto');
  }, []);

  return { data, error, refreshing, stale: error !== null && data !== null, refresh, invalidate };
}
