import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api as ingestApi } from '../api/client';
import {
  SESSION_ENDED_EVENT,
  api,
  clearToken,
  consumeSessionEndReason,
  decodeError,
  getToken,
  hasStoredSession,
  messageFor,
  refreshAccessToken,
  rememberSession,
  restorableSession,
  setToken,
} from './api';
import { IDLE_TIMEOUT_MS, clearActivity, markActivity, readActivity } from './idle';
import { pump } from './liveEvents';

/**
 * Which HTTP failures end the session (across all three fetch wrappers), how
 * the refresh cookie is used, and the boot-time restore decision.
 *
 * Runs on plain node globals rather than a DOM environment - the code under
 * test needs a key-value store and an event target, and a jsdom dependency to
 * supply them would be the larger half of this file.
 */
const ACTIVITY_KEY = 'ep_last_activity';
const store = new Map<string, string>();

const stubStorage = (): void => {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal('window', new EventTarget());
};
stubStorage();

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** An auth error exactly as the backend's authError() writes it. */
const authError = (status: number, code: string): Response => json(status, { statusCode: status, message: 'nope', code });

const tokens = (token: string) => ({
  accessToken: token,
  accessTokenExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
});

/** Every call gets a fresh Response: a body can only be read once. */
const stubFetch = (make: (url: string) => Response): ReturnType<typeof vi.fn> => {
  const fetchMock = vi.fn(async (url: string) => make(url));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

beforeEach(() => {
  store.clear();
  setToken('a-live-token');
  consumeSessionEndReason();
});

afterEach(() => {
  clearToken();
  vi.unstubAllGlobals();
  // unstubAllGlobals cleared the storage/window stubs too.
  stubStorage();
});

describe('decodeError', () => {
  it('reads the auth error code', () => {
    expect(decodeError(401, { statusCode: 401, message: 'x', code: 'TOKEN_EXPIRED' }).code).toBe('TOKEN_EXPIRED');
  });

  it('turns class-validator messages into a validation error', () => {
    const error = decodeError(400, { statusCode: 400, message: ['phone should not be empty'], error: 'Bad Request' });
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(messageFor(error)).toBe('Phone should not be empty');
  });

  it('keeps a business-rule message for the user', () => {
    const error = decodeError(400, { statusCode: 400, message: 'Old password is incorrect' });
    expect(messageFor(error)).toBe('Old password is incorrect');
  });

  it('recognises a taken email', () => {
    expect(decodeError(409, { statusCode: 409, message: 'User with this email already exists' }).code).toBe('EMAIL_TAKEN');
  });
});

describe('lib/api apiFetch', () => {
  it('ends a session the server no longer accepts', async () => {
    stubFetch(() => authError(401, 'SESSION_REVOKED'));

    await expect(api.me()).rejects.toThrow();
    expect(getToken()).toBeNull();
  });

  it('keeps the token on a failed login attempt', async () => {
    // INVALID_CREDENTIALS is a 401 as well; it ends nothing.
    stubFetch(() => authError(401, 'INVALID_CREDENTIALS'));

    await expect(api.login({ email: 'a@b.test', password: 'wrong', keepSignIn: false })).rejects.toThrow();
    expect(getToken()).toBe('a-live-token');
  });

  it('announces the ended session so the UI can leave the authed shell', async () => {
    stubFetch(() => authError(401, 'UNAUTHENTICATED'));
    const heard = vi.fn();
    window.addEventListener(SESSION_ENDED_EVENT, heard);

    await expect(api.me()).rejects.toThrow();
    expect(heard).toHaveBeenCalledOnce();
  });

  it('refreshes an expired access token and replays the request', async () => {
    rememberSession(false);
    let meCalls = 0;
    stubFetch((url) => {
      if (url.endsWith('/api/auth/refresh')) return json(200, tokens('a-new-token'));
      meCalls += 1;
      return meCalls === 1 ? authError(401, 'TOKEN_EXPIRED') : json(200, { id: 'u1' });
    });

    await expect(api.me()).resolves.toEqual({ id: 'u1' });
    expect(getToken()).toBe('a-new-token');
  });

  it('ends the session when the refresh itself is rejected', async () => {
    rememberSession(false);
    stubFetch((url) =>
      url.endsWith('/api/auth/refresh') ? authError(401, 'REFRESH_TOKEN_REUSED') : authError(401, 'TOKEN_EXPIRED'),
    );

    await expect(api.me()).rejects.toThrow();
    expect(getToken()).toBeNull();
    expect(hasStoredSession()).toBe(false);
    expect(consumeSessionEndReason()).toBe('security');
  });
});

describe('refreshAccessToken', () => {
  it('shares one request between concurrent callers', async () => {
    // Two refreshes with the same cookie would look like token theft to the
    // server and end every session of the user.
    rememberSession(false);
    const fetchMock = stubFetch(() => json(200, tokens('a-new-token')));

    const [a, b] = await Promise.all([refreshAccessToken(), refreshAccessToken()]);

    expect(a).toBe('a-new-token');
    expect(b).toBe('a-new-token');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('sends the refresh cookie', async () => {
    rememberSession(false);
    const fetchMock = stubFetch(() => json(200, tokens('a-new-token')));

    await refreshAccessToken();

    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', credentials: 'include' });
  });
});

describe('api/client request', () => {
  it('clears the token on an authentication 401', async () => {
    stubFetch(() => authError(401, 'SESSION_EXPIRED'));

    await expect(ingestApi.listLeadSources()).rejects.toThrow();
    expect(getToken()).toBeNull();
  });

  it('clears the token on a 401 whose body is not readable', async () => {
    // A proxy's HTML error page. Still a rejected token.
    stubFetch(() => new Response('<html>401</html>', { status: 401 }));

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
    stubFetch(() => authError(status, code));

    await expect(ingestApi.listLeadSources()).rejects.toThrow();
    expect(getToken()).toBe('a-live-token');
  });

  it('ends the session when the account is switched off', async () => {
    stubFetch(() => authError(403, 'ACCOUNT_INACTIVE'));

    await expect(ingestApi.listLeadSources()).rejects.toThrow();
    expect(getToken()).toBeNull();
  });

  it('keeps the session when the API is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('failed to fetch')));

    await expect(ingestApi.listLeadSources()).rejects.toThrow();
    expect(getToken()).toBe('a-live-token');
  });
});

describe('lib/liveEvents pump', () => {
  const noop = (): void => {};

  it('clears the token when the stream rejects the session', async () => {
    stubFetch(() => new Response(null, { status: 401 }));

    await expect(pump(new AbortController().signal, noop, noop)).rejects.toThrow('session rejected');
    expect(getToken()).toBeNull();
  });

  it('keeps the token when the stream returns 403', async () => {
    stubFetch(() => new Response(null, { status: 403 }));

    await expect(pump(new AbortController().signal, noop, noop)).rejects.toThrow('session rejected');
    expect(getToken()).toBe('a-live-token');
  });

  it('keeps the token when the stream fails for any other reason', async () => {
    stubFetch(() => new Response(null, { status: 502 }));

    await expect(pump(new AbortController().signal, noop, noop)).rejects.toThrow('stream failed');
    expect(getToken()).toBe('a-live-token');
  });
});

/**
 * The boot check AuthProvider makes before it spends the refresh cookie: is
 * there a session, and has the idle deadline passed while the app was closed?
 */
describe('lib/api restorableSession', () => {
  beforeEach(() => rememberSession(false));

  it('restores a session whose last activity is inside the idle window', () => {
    const at = Date.now() - 29 * 60_000;
    markActivity(at);

    expect(restorableSession()).toBe(true);
    // Booting is not by itself 30 more minutes: one of them is still left.
    expect(readActivity()).toBe(at);
  });

  it('drops and revokes a session whose last activity is outside the idle window', async () => {
    const fetchMock = stubFetch(() => json(200, { success: true }));
    markActivity(Date.now() - (IDLE_TIMEOUT_MS + 1));

    expect(restorableSession()).toBe(false);
    await vi.waitFor(() => expect(hasStoredSession()).toBe(false));
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/api/auth/logout'))).toBe(true);
    expect(readActivity()).toBeNull();
  });

  it('never idles out a "keep me signed in" session', () => {
    rememberSession(true);
    markActivity(Date.now() - 10 * IDLE_TIMEOUT_MS);

    expect(restorableSession()).toBe(true);
  });

  it.each([
    ['not-a-number', 'unparseable'],
    ['0', 'out of range'],
  ])('treats %o in storage as no stamp rather than an expired one', (raw) => {
    store.set(ACTIVITY_KEY, raw);

    expect(restorableSession()).toBe(true);
    expect(readActivity()).not.toBeNull();
  });

  it('initialises the stamp for a session without one', () => {
    clearActivity();

    expect(restorableSession()).toBe(true);
    expect(readActivity()).not.toBeNull();
  });

  it('reports nothing to restore when there is no session, without writing a stamp', () => {
    clearToken();

    expect(restorableSession()).toBe(false);
    expect(readActivity()).toBeNull();
  });
});
