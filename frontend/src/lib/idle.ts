/**
 * Idle session timeout. Separate from the JWT: the token still expires on the
 * backend's own 24-hour schedule, which stays the absolute session ceiling.
 * This only drops the client's copy of it early when nobody is at the keyboard.
 *
 * The deadline is persisted next to the token, so it survives a reload, a
 * browser restart and a second tab. It is a client-side convenience and not a
 * security boundary: the whole record lives in the browser, and anyone willing
 * to edit localStorage can push the deadline back out. What the server enforces
 * is, and stays, the JWT's own 24 hours.
 */
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** Sits beside ep_auth_token, and is cleared with it. */
const ACTIVITY_KEY = 'ep_last_activity';

/**
 * mousemove and scroll fire hundreds of times a second. One timestamp per second
 * is enough to keep a session alive, and it doubles as the cap on how often this
 * writes to localStorage. The deadline timer is never re-armed by activity at
 * all - it re-reads the timestamp when it fires.
 */
const ACTIVITY_THROTTLE_MS = 1000;

const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'];

/**
 * Epoch ms of the last recorded activity, or null when there is none, when
 * storage is unreadable (private mode, site data blocked) or when the stored
 * value is not a positive number.
 *
 * Garbage reads as absent on purpose: a corrupt value is not evidence that
 * anyone was idle, and signing a user out over one would be a worse failure
 * than the one it guards against.
 */
export function readActivity(): number | null {
  try {
    const raw = localStorage.getItem(ACTIVITY_KEY);
    if (raw === null) return null;
    const at = Number(raw);
    return Number.isFinite(at) && at > 0 ? at : null;
  } catch {
    return null;
  }
}

export function markActivity(at: number = Date.now()): void {
  try {
    localStorage.setItem(ACTIVITY_KEY, String(at));
  } catch {
    /* storage blocked: the timeout degrades to this tab's in-memory timer */
  }
}

export function clearActivity(): void {
  try {
    localStorage.removeItem(ACTIVITY_KEY);
  } catch {
    /* nothing to clear */
  }
}

/**
 * Calls onIdle once after timeoutMs with no user activity. Returns a stop
 * function that clears the timer and drops every listener.
 *
 * The deadline is a timestamp, not a countdown, so a tab that was backgrounded
 * (where browsers throttle setTimeout to about once a minute) still logs out on
 * real elapsed time rather than on how often the timer got to run.
 */
export function watchIdle(onIdle: () => void, timeoutMs: number = IDLE_TIMEOUT_MS): () => void {
  // Seeded from storage so a reload continues the deadline it left behind
  // instead of starting a new one. The in-memory copy is what makes the
  // throttle check free, and what keeps this working with storage unavailable.
  let last = readActivity() ?? Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const arm = (): void => {
    if (stopped) return;

    // Re-read rather than trust the copy: another tab writing the same key is
    // this session being used, so the newer of the two stamps wins. That is the
    // whole of the cross-tab story - no storage listener, because every fire
    // already goes through here.
    const stored = readActivity();
    if (stored !== null && stored > last) last = stored;

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
    if (now - last < ACTIVITY_THROTTLE_MS) return;
    last = now;
    markActivity(now);
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
  timeoutMs: number = IDLE_TIMEOUT_MS,
): (() => void) | undefined {
  if (status !== 'authed') return undefined;
  return watchIdle(onIdle, timeoutMs);
}
