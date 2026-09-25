import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearToken, getToken, setToken } from './api';
import { HEARTBEAT_MS, IDLE_TIMEOUT_MS, startIdleWatch } from './idle';

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

  it('reports the first input at once, then at most once a minute', () => {
    // The heartbeat is what keeps the server-side session alive. First input
    // goes immediately: after a reload the server may be close to its own
    // 30-minute limit, and a minute's delay could let it lapse under a user
    // who is plainly active.
    const onActive = vi.fn();
    startIdleWatch('authed', () => {}, onActive);

    expect(onActive).not.toHaveBeenCalled(); // no input, no heartbeat
    activity('keydown');
    expect(onActive).toHaveBeenCalledOnce();

    // A minute of steady input, one event per second: still just the one.
    for (let i = 0; i < HEARTBEAT_MS / 1000 - 1; i += 1) {
      vi.advanceTimersByTime(1000);
      activity('mousemove');
    }
    expect(onActive).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(1000);
    activity('mousemove');
    expect(onActive).toHaveBeenCalledTimes(2);
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
