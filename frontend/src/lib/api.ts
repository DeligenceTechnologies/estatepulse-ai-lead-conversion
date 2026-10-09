/**
 * The single place the backend is called for auth, and the single place its
 * error responses are decoded.
 *
 * Session model (matches the backend's /auth module):
 *  - The access token is short-lived and lives ONLY in memory. It is never
 *    written to localStorage, so an XSS bug cannot lift a long-lived credential.
 *  - The refresh token is an httpOnly cookie the browser sends to /auth/refresh.
 *    JavaScript never sees it.
 *  - A reload has no access token, so it restores the session by calling
 *    /auth/refresh. A small localStorage hint (`ep_session`) says whether there
 *    is a session worth restoring, so a visitor who never signed in gets the
 *    login page at once instead of a spinner and a failed request.
 *
 * The backend rotates the refresh token on every use and treats a replayed old
 * token as theft (every session of the user is revoked). So refreshes must never
 * overlap: within a tab they share one in-flight promise, and across tabs they
 * are serialised with the Web Locks API; the winning tab shares the new access
 * token with the others over a BroadcastChannel.
 */

import { IDLE_TIMEOUT_MS, clearActivity, markActivity, readActivity } from './idle';

const BASE = import.meta.env.VITE_API_URL ?? '';

/** Present while a session may be restorable; holds the "keep me signed in" choice. */
const SESSION_KEY = 'ep_session';

/** Fired on the window whenever the session is dropped. */
export const SESSION_ENDED_EVENT = 'ep:session-ended';

/** Refresh this long before the access token expires. */
const REFRESH_AHEAD_MS = 60_000;

/** Used when a token arrives without an expiry (tests, or a malformed response). */
const DEFAULT_ACCESS_TTL_MS = 15 * 60_000;

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'BAD_REQUEST'
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_INACTIVE'
  | 'UNAUTHENTICATED'
  | 'TOKEN_EXPIRED'
  | 'SESSION_EXPIRED'
  | 'SESSION_REVOKED'
  | 'REFRESH_TOKEN_MISSING'
  | 'REFRESH_TOKEN_INVALID'
  | 'REFRESH_TOKEN_REUSED'
  | 'REFRESH_TOKEN_RACE'
  | 'EMAIL_TAKEN'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'INTERNAL'
  | 'NETWORK';

/**
 * Which application shell a user gets. The backend has free-form roles; the
 * system role (Owner) gets the owner shell, every other role the agent shell.
 */
export type Role = 'owner' | 'agent';

export interface AuthUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone?: string | null;
  status?: string;
  timezone?: string;
  lastLoginAt?: string | null;
}

/**
 * Asked at sign-up only to pick the owner's starting roles; not stored.
 * individual: one person working alone; team: an office with agents.
 */
export type OrganizationType = 'individual' | 'team';

export interface AuthOrganization {
  id: string;
  name: string;
  status?: string;
}

export interface AuthRole {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
}

/** GET /auth/me */
export interface MeResponse extends AuthUser {
  organization: AuthOrganization;
  /** Every role the user holds. */
  roles: AuthRole[];
  /** Effective permissions: the union of every role's; all of them with the system role. */
  permissions: string[];
}

export interface AuthTokens {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
}

/** POST /auth/login and /auth/register */
export interface AuthSessionResponse extends AuthTokens {
  user: AuthUser;
}

export interface RegisterInput {
  organizationName: string;
  /** individual: the owner also gets the Agent role; team: Owner only. */
  organizationType: OrganizationType;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  password: string;
}

export interface ChangePasswordInput {
  oldPassword: string;
  newPassword: string;
  confirmPassword: string;
}

export interface ErrorDetail {
  path: string;
  message: string;
}

export class ApiError extends Error {
  code: ErrorCode;
  status: number;
  details?: ErrorDetail[];

  constructor(code: ErrorCode, message: string, status: number, details?: ErrorDetail[]) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * NETWORK is ours, not the server's — the backend being unreachable is a
 * different problem from it rejecting the request, and the login form says so.
 */
const MESSAGES: Record<ErrorCode, string> = {
  VALIDATION_ERROR: 'Please check the highlighted fields and try again.',
  BAD_REQUEST: 'That request could not be completed.',
  INVALID_CREDENTIALS: 'That email and password combination is not correct.',
  ACCOUNT_INACTIVE: 'This account is inactive. Contact your administrator.',
  UNAUTHENTICATED: 'Please sign in to continue.',
  TOKEN_EXPIRED: 'Your session has expired. Please sign in again.',
  SESSION_EXPIRED: 'Your session has expired. Please sign in again.',
  SESSION_REVOKED: 'You were signed out. Please sign in again.',
  REFRESH_TOKEN_MISSING: 'Please sign in to continue.',
  REFRESH_TOKEN_INVALID: 'Your session is no longer valid. Please sign in again.',
  REFRESH_TOKEN_REUSED: 'For your security you were signed out everywhere. Please sign in again.',
  REFRESH_TOKEN_RACE: 'Please try again.',
  EMAIL_TAKEN: 'An account with that email already exists.',
  FORBIDDEN: 'You do not have permission to do that.',
  NOT_FOUND: 'That page or resource does not exist.',
  CONFLICT: 'That conflicts with something that already exists.',
  RATE_LIMITED: 'Too many attempts. Please wait a minute and try again.',
  INTERNAL: 'Something went wrong on our end. Please try again.',
  NETWORK: 'Cannot reach the server. Check that the API is running.',
};

/** Codes whose server message is written for people and beats our generic one. */
const SERVER_WORDED: ErrorCode[] = ['BAD_REQUEST', 'CONFLICT', 'FORBIDDEN'];

/**
 * Prefers the server's own wording where it is meant for the user: a field
 * message ("password must be longer than or equal to 8 characters") or a
 * business rule ("Old password is incorrect").
 */
export function messageFor(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'VALIDATION_ERROR' && err.details?.length) {
      return err.details[0].message;
    }
    if (SERVER_WORDED.includes(err.code) && err.message) return err.message;
    return MESSAGES[err.code] ?? MESSAGES.INTERNAL;
  }
  return MESSAGES.INTERNAL;
}

const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Turns any error body the backend can produce into an ApiError:
 *  - auth errors:        { statusCode, message, code }
 *  - validation errors:  { statusCode: 400, message: string[], error }
 *  - other Nest errors:  { statusCode, message, error }
 *  - legacy envelope:    { error: { code, message, details } }
 */
export function decodeError(status: number, payload: unknown): ApiError {
  const body = (payload ?? {}) as {
    code?: unknown;
    message?: unknown;
    error?: unknown;
  };

  if (body.error && typeof body.error === 'object') {
    const legacy = body.error as { code?: string; message?: string; details?: ErrorDetail[] };
    const code = (legacy.code ?? 'INTERNAL') as ErrorCode;
    return new ApiError(code, legacy.message ?? MESSAGES[code] ?? MESSAGES.INTERNAL, status, legacy.details);
  }

  const messages = Array.isArray(body.message)
    ? body.message.filter((m): m is string => typeof m === 'string')
    : [];
  const message = typeof body.message === 'string' ? body.message : messages[0];

  let code: ErrorCode;
  if (typeof body.code === 'string') {
    code = body.code as ErrorCode;
  } else if (status === 400) {
    code = messages.length ? 'VALIDATION_ERROR' : 'BAD_REQUEST';
  } else if (status === 401) {
    code = 'UNAUTHENTICATED';
  } else if (status === 403) {
    code = 'FORBIDDEN';
  } else if (status === 404) {
    code = 'NOT_FOUND';
  } else if (status === 409) {
    code = message && /email/i.test(message) ? 'EMAIL_TAKEN' : 'CONFLICT';
  } else if (status === 429) {
    code = 'RATE_LIMITED';
  } else {
    code = 'INTERNAL';
  }

  const details = messages.length ? messages.map((m) => ({ path: '', message: capitalise(m) })) : undefined;
  return new ApiError(code, message ? capitalise(message) : MESSAGES[code] ?? MESSAGES.INTERNAL, status, details);
}

// --- Access token (memory only) ---------------------------------------------

let accessToken: string | null = null;
let accessTokenExpiresAt = 0;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

/** Why the last session ended, for the login page to explain. Read once. */
export type SessionEndReason = 'expired' | 'security' | 'password_changed' | 'signed_out_everywhere' | 'idle';
let endReason: SessionEndReason | null = null;

export const consumeSessionEndReason = (): SessionEndReason | null => {
  const reason = endReason;
  endReason = null;
  return reason;
};

type ChannelMessage =
  | { type: 'token'; token: string; expiresAt: number }
  | { type: 'ended'; reason: SessionEndReason | null };

let channel: BroadcastChannel | null | undefined;
const getChannel = (): BroadcastChannel | null => {
  if (channel !== undefined) return channel;
  try {
    channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('ep-auth');
  } catch {
    channel = null;
  }
  // Node (tests) would otherwise keep the process alive for the channel.
  (channel as { unref?: () => void } | null)?.unref?.();
  channel?.addEventListener('message', (event: MessageEvent<ChannelMessage>) => {
    const message = event.data;
    if (message?.type === 'token') {
      // Another tab refreshed the shared session: use its token instead of
      // spending (and rotating) the refresh cookie again.
      if (hasStoredSession()) adoptToken(message.token, message.expiresAt);
    } else if (message?.type === 'ended') {
      // Same browser, same cookie: a sign-out in one tab is a sign-out in all.
      dropSession(message.reason, false);
    }
  });
  return channel;
};

const broadcast = (message: ChannelMessage): void => {
  try {
    getChannel()?.postMessage(message);
  } catch {
    /* other tabs will find out on their next refresh */
  }
};

export const getToken = (): string | null => accessToken;

function adoptToken(token: string, expiresAt?: string | number | Date): void {
  accessToken = token;
  const parsed = expiresAt === undefined ? NaN : new Date(expiresAt).getTime();
  accessTokenExpiresAt = Number.isFinite(parsed) ? parsed : Date.now() + DEFAULT_ACCESS_TTL_MS;
  scheduleRefresh();
}

/**
 * Keeps the access token fresh while the tab is open, so requests rarely meet
 * an expired token. Only for a real session (the hint is set): a token set by a
 * test, or one left over from a session already ended, gets no timer.
 */
function scheduleRefresh(): void {
  clearTimeout(refreshTimer);
  if (!accessToken || !hasStoredSession()) return;
  // A little jitter so tabs that loaded together do not all wake together.
  const wait = Math.max(accessTokenExpiresAt - Date.now() - REFRESH_AHEAD_MS - Math.random() * 10_000, 5_000);
  refreshTimer = setTimeout(() => void refreshAccessToken().catch(() => {}), wait);
}

/**
 * Starts the in-memory session with a token from login or register. Signing in
 * is activity, so it also starts the idle deadline.
 */
export const setToken = (token: string, expiresAt?: string | Date): void => {
  adoptToken(token, expiresAt);
  markActivity();
};

/** Records that a session exists in this browser, and whether it should outlive the idle timeout. */
export const rememberSession = (keepSignedIn: boolean): void => {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ keepSignedIn }));
  } catch {
    /* the session simply will not survive a reload */
  }
  scheduleRefresh();
};

function readSession(): { keepSignedIn: boolean } | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { keepSignedIn?: unknown };
    return { keepSignedIn: parsed.keepSignedIn === true };
  } catch {
    return null;
  }
}

export const hasStoredSession = (): boolean => readSession() !== null;

/** "Keep me signed in" sessions are exempt from the idle timeout. */
export const isKeepSignedIn = (): boolean => readSession()?.keepSignedIn === true;

function dropSession(reason: SessionEndReason | null, announce: boolean): void {
  const hadSession = accessToken !== null || hasStoredSession();
  accessToken = null;
  accessTokenExpiresAt = 0;
  clearTimeout(refreshTimer);
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* nothing to clear */
  }
  // The idle deadline belongs to the session, so it goes with it.
  clearActivity();
  if (reason) endReason = reason;
  if (announce && hadSession) broadcast({ type: 'ended', reason });
  // React holds the session in state and nothing re-reads storage until a
  // reload. AuthProvider listens for this and resets, so a session that dies
  // mid-use lands on the login page instead of on a shell that 401s.
  try {
    window.dispatchEvent(new Event(SESSION_ENDED_EVENT));
  } catch {
    /* no window (tests, SSR): the token is still gone, which is the point */
  }
}

/** Ends the session in this tab and every other tab of this browser. */
export const clearToken = (reason: SessionEndReason | null = null): void => dropSession(reason, true);

/**
 * Whether a session restore should be attempted on boot. A session that is not
 * "keep me signed in" and has outlived the idle deadline is not restored: it is
 * revoked server-side (best effort) and dropped.
 *
 * A missing activity stamp is initialised rather than treated as expired.
 */
export const restorableSession = (): boolean => {
  if (!hasStoredSession()) return false;
  if (isKeepSignedIn()) return true;

  const activity = readActivity();
  if (activity === null) {
    markActivity();
    return true;
  }
  if (Date.now() - activity < IDLE_TIMEOUT_MS) return true;

  void revokeStoredSession('idle');
  return false;
};

/** Revokes the cookie's session on the server, then drops it locally. */
async function revokeStoredSession(reason: SessionEndReason): Promise<void> {
  try {
    const token = accessToken ?? (await refreshAccessToken());
    await api.logout(token);
  } catch {
    /* already gone, or offline: the session still expires on its own */
  } finally {
    clearToken(reason);
  }
}

// --- Refresh -----------------------------------------------------------------

/** Codes that mean "this session is finished" rather than "this request failed". */
const SESSION_ENDING_CODES: string[] = [
  'UNAUTHENTICATED',
  'TOKEN_EXPIRED',
  'SESSION_EXPIRED',
  'SESSION_REVOKED',
  'REFRESH_TOKEN_MISSING',
  'REFRESH_TOKEN_INVALID',
  'REFRESH_TOKEN_REUSED',
];

const reasonFor = (code?: string): SessionEndReason =>
  code === 'REFRESH_TOKEN_REUSED' ? 'security' : 'expired';

/**
 * The one place a dead session is recognised, for every fetch wrapper in the
 * app: apiFetch here, api/client.ts and lib/liveEvents.ts.
 *
 * A 403 is a permission error on a perfectly good session and never ends it —
 * except ACCOUNT_INACTIVE, which says the account itself is switched off.
 * INVALID_CREDENTIALS is a 401 from the login form, where there is no session
 * to end. Returns whether the session was ended.
 */
export function endSessionIfUnauthenticated(status: number, code?: string): boolean {
  if (status === 403 && code === 'ACCOUNT_INACTIVE') {
    clearToken('expired');
    return true;
  }
  if (status !== 401) return false;
  // A 401 whose body we could not read (a proxy's HTML error page) is still a
  // rejected token: fail towards the login page rather than towards a loop.
  if (code !== undefined && !SESSION_ENDING_CODES.includes(code)) return false;

  clearToken(reasonFor(code));
  return true;
}

let inflightRefresh: Promise<string> | null = null;

/**
 * Exchanges the refresh cookie for a new access token. Concurrent callers in
 * this tab share one request; other tabs wait on the same lock.
 */
export function refreshAccessToken(): Promise<string> {
  if (!inflightRefresh) {
    const tokenBefore = accessToken;
    inflightRefresh = withRefreshLock(() => doRefresh(tokenBefore)).finally(() => {
      inflightRefresh = null;
    });
  }
  return inflightRefresh;
}

async function withRefreshLock<T>(task: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  return locks ? locks.request('ep-auth-refresh', task) : task();
}

const isFresh = (): boolean => accessToken !== null && accessTokenExpiresAt - Date.now() > REFRESH_AHEAD_MS;

async function doRefresh(tokenBefore: string | null, attempt = 1): Promise<string> {
  // While this tab waited for the lock, another tab may have refreshed and
  // broadcast a new token. Using it saves a rotation.
  if (accessToken && accessToken !== tokenBefore && isFresh()) return accessToken;

  let response: Response;
  try {
    response = await fetch(`${BASE}/api/auth/refresh`, { method: 'POST', credentials: 'include' });
  } catch {
    throw new ApiError('NETWORK', MESSAGES.NETWORK, 0);
  }
  const payload = await readJson(response);

  if (!response.ok) {
    const error = decodeError(response.status, payload);
    // Two refreshes crossed (only possible without Web Locks): the other one
    // won and set the new cookie. Trying again sends that cookie.
    if (error.code === 'REFRESH_TOKEN_RACE' && attempt === 1) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return doRefresh(tokenBefore, attempt + 1);
    }
    endSessionIfUnauthenticated(response.status, error.code);
    throw error;
  }

  const tokens = payload as AuthTokens;
  adoptToken(tokens.accessToken, tokens.accessTokenExpiresAt);
  broadcast({ type: 'token', token: tokens.accessToken, expiresAt: accessTokenExpiresAt });
  return tokens.accessToken;
}

/**
 * The access token to send now: refreshed first if it is missing or about to
 * expire and a session exists. Null when signed out. A network failure during
 * the refresh returns whatever token there is and lets the request fail itself.
 */
export async function getFreshToken(): Promise<string | null> {
  if (isFresh()) return accessToken;
  if (!hasStoredSession()) return accessToken;
  try {
    return await refreshAccessToken();
  } catch (error) {
    if (error instanceof ApiError && error.code === 'NETWORK') return accessToken;
    return null;
  }
}

// --- Requests ----------------------------------------------------------------

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

export async function apiFetch<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    auth?: boolean;
    /** Use this token instead of the session's (sign-out with a captured token). */
    token?: string | null;
  } = {},
): Promise<T> {
  const { method = 'GET', body, auth = false } = options;
  // Only /auth needs the refresh cookie; everything else authenticates by header.
  const credentials: RequestCredentials = path.startsWith('/auth/') ? 'include' : 'same-origin';

  const send = async (token: string | null): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers['Authorization'] = `Bearer ${token}`;
    try {
      return await fetch(`${BASE}/api${path}`, {
        method,
        headers,
        credentials,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ApiError('NETWORK', MESSAGES.NETWORK, 0);
    }
  };

  const explicitToken = options.token !== undefined;
  let response = await send(explicitToken ? options.token ?? null : auth ? await getFreshToken() : null);
  let payload = await readJson(response);

  // The access token expired between the freshness check and the server (clock
  // skew, a laptop waking from sleep): refresh once and replay the request.
  if (auth && !explicitToken && response.status === 401 && hasStoredSession()) {
    const first = decodeError(response.status, payload);
    if (first.code === 'TOKEN_EXPIRED') {
      const token = await refreshAccessToken();
      response = await send(token);
      payload = await readJson(response);
    }
  }

  if (!response.ok) {
    const error = decodeError(response.status, payload);
    if (auth) endSessionIfUnauthenticated(response.status, error.code);
    throw error;
  }

  return payload as T;
}

/**
 * No form asks for a timezone - the device already knows it. An environment
 * without ICU data returns '' here, and JSON.stringify drops the undefined key,
 * so the request simply omits it and the backend fallback stands.
 */
export const localTimeZone = (): string | undefined => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
};

export const api = {
  /** Creates the organization (with Owner and Agent roles) and signs its owner in. */
  register: (body: RegisterInput) =>
    apiFetch<AuthSessionResponse>('/auth/register', { method: 'POST', body }),

  login: (body: { email: string; password: string; keepSignIn: boolean }) =>
    apiFetch<AuthSessionResponse>('/auth/login', { method: 'POST', body }),

  me: () => apiFetch<MeResponse>('/auth/me', { auth: true }),

  /** Revokes this browser's session; the server also clears the refresh cookie. */
  logout: (token?: string | null) =>
    apiFetch<{ success: true }>('/auth/logout', { method: 'POST', auth: true, token }),

  /** Revokes every session of this user, on every device. */
  logoutAll: () => apiFetch<{ success: true }>('/auth/logout-all', { method: 'POST', auth: true }),

  /** Succeeds by signing the user out everywhere, this browser included. */
  changePassword: (body: ChangePasswordInput) =>
    apiFetch<{ success: true }>('/auth/change-password', { method: 'POST', auth: true, body }),
};
