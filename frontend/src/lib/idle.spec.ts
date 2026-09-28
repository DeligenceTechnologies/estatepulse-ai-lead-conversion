import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearToken, getToken, setToken } from './api';
import { IDLE_TIMEOUT_MS, markActivity, readActivity, startIdleWatch } from './idle';

/**
 * Same plain-node setup as session.spec.ts: the code under test needs a
 * key-value store and two event targets, which is not worth a jsdom dependency.
 */
const store = new Map<string, string>();
const localStorageStub = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: vi.fn((k: string, v: string) => void store.set(k, String(v))),
  removeItem: (k: string) => void store.delete(k),
};

/** A document that can be hidden, so a backgrounded tab can be simulated. */
class DocumentStub extends EventTarget {
  hidden = false;
}

let doc: DocumentStub;

beforeEach(() => {
  store.clear();
  localStorageStub.setItem.mockClear();
  doc = new DocumentStub();
  vi.stubGlobal('localStorage', localStorageStub);
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', doc);
  vi.useFakeTimers();
  setToken('a-live-token');
  localStorageStub.setItem.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Exactly what AuthProvider passes as onIdle. */
const idleLogout = (onIdle: () => void) => (): void => {
  clearToken();
  onIdle();
};

const activity = (type: string): void => void window.dispatchEvent(new Event(type));
const nearly = IDLE_TIMEOUT_MS - 1000;

describe('idle session timeout', () => {
  it('gives an authenticated user a 30-minute idle timer', () => {
    const onIdle = vi.fn();
    startIdleWatch('authed', onIdle);

    vi.advanceTimersByTime(nearly);
    expect(onIdle).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('gives anonymous and loading sessions no idle timer', () => {
    const onIdle = vi.fn();

    expect(startIdleWatch('anon', onIdle)).toBeUndefined();
    expect(startIdleWatch('loading', onIdle)).toBeUndefined();

    vi.advanceTimersByTime(IDLE_TIMEOUT_MS * 2);
    expect(onIdle).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'])(
    'resets the timer on %s',
    (event) => {
      const onIdle = vi.fn();
      startIdleWatch('authed', onIdle);

      vi.advanceTimersByTime(nearly);
      activity(event);

      // The original deadline passes without a logout...
      vi.advanceTimersByTime(1000);
      expect(onIdle).not.toHaveBeenCalled();

      // ...and the new one lands a full 30 minutes after the activity.
      vi.advanceTimersByTime(nearly - 1000);
      expect(onIdle).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      expect(onIdle).toHaveBeenCalledOnce();
    },
  );

  it('throttles high-frequency events to one reset per second', () => {
    const onIdle = vi.fn();
    startIdleWatch('authed', onIdle);

    // 500 mousemoves inside the throttle window: the deadline is unchanged, so
    // the session still ends 30 minutes after the first one.
    for (let i = 0; i < 500; i += 1) activity('mousemove');
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(IDLE_TIMEOUT_MS);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('logs the user out after 30 minutes of no activity', () => {
    const onIdle = vi.fn();
    startIdleWatch('authed', idleLogout(onIdle));

    vi.advanceTimersByTime(IDLE_TIMEOUT_MS);

    expect(getToken()).toBeNull();
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('clears the timer and the listeners on logout', () => {
    const onIdle = vi.fn();
    const stop = startIdleWatch('authed', onIdle);

    stop?.();

    expect(vi.getTimerCount()).toBe(0);
    activity('keydown');
    vi.advanceTimersByTime(IDLE_TIMEOUT_MS * 2);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('starts a fresh timer on the next login', () => {
    const first = vi.fn();
    startIdleWatch('authed', first)?.();

    vi.advanceTimersByTime(nearly);

    // What logging in does, and the reason the second watcher does not inherit
    // the first one's deadline: a watcher now reads the persisted stamp, and
    // signing in writes a new one.
    setToken('a-second-token');

    const second = vi.fn();
    startIdleWatch('authed', second);

    // The new session gets its own full 30 minutes, not the old one's remainder.
    vi.advanceTimersByTime(nearly);
    expect(second).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
  });

  it('logs out on return to a tab that was hidden for more than 30 minutes', () => {
    const onIdle = vi.fn();
    startIdleWatch('authed', idleLogout(onIdle));

    // A backgrounded tab: real time passes, throttled timers never ran.
    doc.hidden = true;
    vi.setSystemTime(Date.now() + IDLE_TIMEOUT_MS + 60_000);
    doc.hidden = false;
    doc.dispatchEvent(new Event('visibilitychange'));

    expect(onIdle).toHaveBeenCalledOnce();
    expect(getToken()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the remaining timeout on return to a tab hidden for less than 30 minutes', () => {
    const onIdle = vi.fn();
    startIdleWatch('authed', onIdle);

    doc.hidden = true;
    vi.setSystemTime(Date.now() + 20 * 60_000);
    doc.hidden = false;
    doc.dispatchEvent(new Event('visibilitychange'));

    expect(onIdle).not.toHaveBeenCalled();

    // 10 minutes left of the original 30, not a new 30.
    vi.advanceTimersByTime(10 * 60_000 - 1000);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('drops the token without reissuing or extending one', () => {
    startIdleWatch('authed', idleLogout(() => {}));

    vi.advanceTimersByTime(IDLE_TIMEOUT_MS);

    // Idle logout is a client-side disposal: nothing is written back to
    // storage, so the JWT's own 24-hour expiry is untouched.
    expect(getToken()).toBeNull();
    expect(localStorageStub.setItem).not.toHaveBeenCalled();
  });
});

/**
 * The half of the timeout that outlives the tab. What the boot check makes of a
 * stored stamp is restorableToken's, and lives in session.spec.ts; this is the
 * watcher's own end - writing the stamp, and reading back one it did not write.
 */
describe('persisted idle deadline', () => {
  it('records activity so the deadline survives the tab', () => {
    startIdleWatch('authed', vi.fn());

    vi.advanceTimersByTime(20 * 60_000);
    activity('keydown');

    expect(readActivity()).toBe(Date.now());
  });

  it('throttles the write rather than persisting every mouse movement', () => {
    startIdleWatch('authed', vi.fn());
    localStorageStub.setItem.mockClear();

    for (let i = 0; i < 500; i += 1) activity('mousemove');
    expect(localStorageStub.setItem).not.toHaveBeenCalled();

    // One write per throttle window, however many events land inside it.
    vi.advanceTimersByTime(1000);
    for (let i = 0; i < 500; i += 1) activity('mousemove');
    expect(localStorageStub.setItem).toHaveBeenCalledOnce();
  });

  it('continues the stored deadline across a reload', () => {
    // A tab closed after 25 idle minutes: the watcher is torn down, the stamp
    // stays behind.
    startIdleWatch('authed', vi.fn())?.();
    vi.advanceTimersByTime(25 * 60_000);

    const onIdle = vi.fn();
    startIdleWatch('authed', onIdle);

    // Five minutes of the original thirty are left, not a fresh thirty.
    vi.advanceTimersByTime(5 * 60_000 - 1000);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('keeps this tab alive while another tab is being used', () => {
    const onIdle = vi.fn();
    startIdleWatch('authed', onIdle);

    // The other tab is another watcher writing the same key.
    vi.advanceTimersByTime(25 * 60_000);
    markActivity();

    // This tab's own deadline passes without a logout...
    vi.advanceTimersByTime(5 * 60_000);
    expect(onIdle).not.toHaveBeenCalled();

    // ...and the new one lands 30 minutes after the other tab's activity.
    vi.advanceTimersByTime(25 * 60_000 - 1000);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('stamps the deadline when a session begins', () => {
    store.clear();

    setToken('a-fresh-token');

    expect(readActivity()).toBe(Date.now());
  });

  it('clears the stamp along with the token', () => {
    expect(readActivity()).not.toBeNull();

    clearToken();

    expect(getToken()).toBeNull();
    expect(readActivity()).toBeNull();
    // Both keys, and nothing of the session left behind.
    expect(store.size).toBe(0);
  });

  it('clears both keys when the idle timeout is what ends the session', () => {
    startIdleWatch('authed', idleLogout(() => {}));

    vi.advanceTimersByTime(IDLE_TIMEOUT_MS);

    expect(getToken()).toBeNull();
    expect(readActivity()).toBeNull();
  });
});
