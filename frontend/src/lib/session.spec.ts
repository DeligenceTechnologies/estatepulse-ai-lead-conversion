import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api as ingestApi } from '../api/client';
import { SESSION_ENDED_EVENT, api, clearToken, getToken, restorableToken, setToken } from './api';
import { IDLE_TIMEOUT_MS, clearActivity, markActivity, readActivity } from './idle';
import { pump } from './liveEvents';

/**
 * One suite for one rule: which HTTP failures end the session, across all three
 * fetch wrappers in the app.
 *
 * Runs on plain node globals rather than a DOM environment - the code under
 * test needs exactly two browser things, a key-value store and an event target,
 * and a jsdom dependency to supply them would be the larger half of this file.
 */
const TOKEN_KEY = 'ep_auth_token';
const ACTIVITY_KEY = 'ep_last_activity';
const store = new Map<string, string>();

vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
});
vi.stubGlobal('window', new EventTarget());

/** A backend error envelope, exactly as AllExceptionsFilter writes it. */
const errorResponse = (status: number, code: string): Response =>
  new Response(JSON.stringify({ error: { code, message: 'nope' } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const stubFetch = (res: Response): void => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res));
};

beforeEach(() => {
  store.clear();
  setToken('a-live-token');
});

afterEach(() => {
  vi.unstubAllGlobals();
  // stubGlobal cleared the localStorage/window stubs too; the next beforeEach
  // runs after this, so they are restored below rather than left undefined.
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal('window', new EventTarget());
});

describe('lib/api apiFetch', () => {
  it('clears the token when the session expired', async () => {
    stubFetch(errorResponse(401, 'TOKEN_EXPIRED'));

    await expect(api.me()).rejects.toThrow();
    expect(getToken()).toBeNull();
  });

  it('clears the token on UNAUTHENTICATED', async () => {
    stubFetch(errorResponse(401, 'UNAUTHENTICATED'));

    await expect(api.me()).rejects.toThrow();
    expect(getToken()).toBeNull();
  });

  it('keeps the token on a failed login attempt', async () => {
    // INVALID_CREDENTIALS is a 401 as well. Signing a user out because someone
    // mistyped a password on a re-auth prompt would be a regression.
    stubFetch(errorResponse(401, 'INVALID_CREDENTIALS'));

    await expect(api.login({ email: 'a@b.test', password: 'wrong' })).rejects.toThrow();
    expect(getToken()).toBe('a-live-token');
  });

  it('announces the ended session so the UI can leave the authed shell', async () => {
    stubFetch(errorResponse(401, 'TOKEN_EXPIRED'));
    const heard = vi.fn();
    window.addEventListener(SESSION_ENDED_EVENT, heard);

    await expect(api.me()).rejects.toThrow();
    expect(heard).toHaveBeenCalledOnce();
  });
});

describe('api/client request', () => {
  it('clears the token on an authentication 401', async () => {
    stubFetch(errorResponse(401, 'TOKEN_EXPIRED'));

    await expect(ingestApi.listLeadSources()).rejects.toThrow();
    expect(getToken()).toBeNull();
  });

  it('clears the token on a 401 whose body is not a readable envelope', async () => {
    // A proxy's HTML error page. Still a rejected token.
    stubFetch(new Response('<html>401</html>', { status: 401 }));

    await expect(ingestApi.listLeadSources()).rejects.toThrow();
    expect(getToken()).toBeNull();
  });

  it.each([
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [429, 'RATE_LIMITED'],
    [500, 'INTERNAL'],
  ])('keeps the session on %i %s', async (status, code) => {
    stubFetch(errorResponse(status, code));

    await expect(ingestApi.listLeadSources()).rejects.toThrow();
    expect(getToken()).toBe('a-live-token');
  });

  it('keeps the session when the API is unreachable', async () => {
    // A dropped connection is not proof the token is bad.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('failed to fetch')));

    await expect(ingestApi.listLeadSources()).rejects.toThrow();
    expect(getToken()).toBe('a-live-token');
  });
});

describe('lib/liveEvents pump', () => {
  const noop = (): void => {};

  it('clears the token when the stream rejects the session', async () => {
    stubFetch(new Response(null, { status: 401 }));

    await expect(pump(new AbortController().signal, noop, noop)).rejects.toThrow('session rejected');
    expect(getToken()).toBeNull();
  });

  it('keeps the token when the stream returns 403', async () => {
    // The stream stops retrying either way, but a permission error leaves a
    // perfectly good session in place.
    stubFetch(new Response(null, { status: 403 }));

    await expect(pump(new AbortController().signal, noop, noop)).rejects.toThrow('session rejected');
    expect(getToken()).toBe('a-live-token');
  });

  it('keeps the token when the stream fails for any other reason', async () => {
    stubFetch(new Response(null, { status: 502 }));

    await expect(pump(new AbortController().signal, noop, noop)).rejects.toThrow('stream failed');
    expect(getToken()).toBe('a-live-token');
  });
});

/**
 * The other way a session ends: not an HTTP failure, but the persisted idle
 * deadline having passed while the app was not running. This is the boot check
 * AuthProvider makes before it calls /api/auth/me.
 */
describe('lib/api restorableToken', () => {
  it('restores a token whose last activity is inside the idle window', () => {
    const at = Date.now() - 29 * 60_000;
    markActivity(at);

    expect(restorableToken()).toBe('a-live-token');
    expect(getToken()).toBe('a-live-token');
    // Booting is not by itself 30 more minutes: one of them is still left.
    expect(readActivity()).toBe(at);
  });

  it('drops a token whose last activity is outside the idle window', () => {
    markActivity(Date.now() - (IDLE_TIMEOUT_MS + 1));

    // Refused before /me is ever called: /me would restore this token happily,
    // since the JWT itself is good for 24 hours.
    expect(restorableToken()).toBeNull();
    expect(getToken()).toBeNull();
    expect(readActivity()).toBeNull();
  });

  it('is deterministic at exactly 30 minutes', () => {
    // The deadline is inclusive, matching watchIdle, which fires the moment the
    // remaining time reaches zero rather than after it.
    markActivity(Date.now() - IDLE_TIMEOUT_MS);
    expect(restorableToken()).toBeNull();

    setToken('a-live-token');
    markActivity(Date.now() - (IDLE_TIMEOUT_MS - 1));
    expect(restorableToken()).toBe('a-live-token');
  });

  it.each([
    ['not-a-number', 'unparseable'],
    ['0', 'out of range'],
  ])('treats %o in storage as no stamp rather than an expired one', (raw) => {
    store.set(ACTIVITY_KEY, raw);

    // Corrupt is not evidence that anyone was idle.
    expect(restorableToken()).toBe('a-live-token');
    expect(readActivity()).not.toBeNull();
  });

  it('initialises the stamp for a session that predates the feature', () => {
    clearActivity();

    expect(restorableToken()).toBe('a-live-token');
    expect(readActivity()).not.toBeNull();
  });

  it('reports no token when there is none, without writing a stamp', () => {
    clearToken();

    expect(restorableToken()).toBeNull();
    expect(readActivity()).toBeNull();
  });
});
