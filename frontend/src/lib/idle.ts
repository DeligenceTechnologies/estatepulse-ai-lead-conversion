/**
 * Idle session timeout. The backend enforces the same 30 minutes on its own
 * session row (user_sessions.last_seen_at), and that is the rule that counts:
 * this timer only puts the login page up on time in a tab left open.
 */
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * How often real input is reported to the backend. The server moves
 * last_seen_at only on these, never on background requests, so a session with
 * someone at the keyboard stays alive and an unattended one does not.
 */
export const HEARTBEAT_MS = 60 * 1000;

/**
 * mousemove and scroll fire hundreds of times a second. One timestamp write per
 * second is enough to keep a session alive, and the deadline timer is never
 * re-armed by activity at all - it re-reads the timestamp when it fires.
 */
const ACTIVITY_THROTTLE_MS = 1000;

const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'];

/**
 * Calls onIdle once after timeoutMs with no user activity, and onActive on
 * activity at most once per HEARTBEAT_MS. Returns a stop function that clears
 * the timer and drops every listener.
 *
 * The deadline is a timestamp, not a countdown, so a tab that was backgrounded
 * (where browsers throttle setTimeout to about once a minute) still logs out on
 * real elapsed time rather than on how often the timer got to run.
 */
export function watchIdle(
  onIdle: () => void,
  timeoutMs: number = IDLE_TIMEOUT_MS,
  onActive: () => void = () => {},
): () => void {
  let last = Date.now();
  // 0, not now: after a reload the server's last_seen_at may be nearly 30
  // minutes old, so the first input must be reported at once, not a minute late.
  let lastBeat = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const arm = (): void => {
    if (stopped) return;
    const remaining = last + timeoutMs - Date.now();
    if (remaining <= 0) {
      stop();
      onIdle();
      return;
    }
    timer = setTimeout(arm, remaining);
  };

  const onActivity = (): void => {
    const now = Date.now();
    // Ahead of the idle throttle, which starts closed: input in the first
    // second after a reload would otherwise go unreported for a minute.
    if (now - lastBeat >= HEARTBEAT_MS) {
      lastBeat = now;
      onActive();
    }
    if (now - last < ACTIVITY_THROTTLE_MS) return;
    last = now;
  };

  // Coming back to a tab that was hidden: check real elapsed time now instead
  // of waiting for a throttled timer to notice.
  const onVisibility = (): void => {
    if (document.hidden) return;
    clearTimeout(timer);
    arm();
  };

  const stop = (): void => {
    stopped = true;
    clearTimeout(timer);
    for (const event of ACTIVITY_EVENTS) {
      window.removeEventListener(event, onActivity, { capture: true });
    }
    document.removeEventListener('visibilitychange', onVisibility);
  };

  for (const event of ACTIVITY_EVENTS) {
    // capture: scroll does not bubble, so a scrolling panel would be invisible
    // to a listener on window otherwise. passive: never block a gesture.
    window.addEventListener(event, onActivity, { capture: true, passive: true });
  }
  document.addEventListener('visibilitychange', onVisibility);
  arm();

  return stop;
}

/**
 * The rule AuthProvider's effect is: only a signed-in session has an idle
 * timer. 'loading' and 'anon' get nothing to tear down.
 */
export function startIdleWatch(
  status: string,
  onIdle: () => void,
  onActive: () => void = () => {},
  timeoutMs: number = IDLE_TIMEOUT_MS,
): (() => void) | undefined {
  if (status !== 'authed') return undefined;
  return watchIdle(onIdle, timeoutMs, onActive);
}
