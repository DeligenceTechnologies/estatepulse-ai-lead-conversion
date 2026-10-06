/**
 * The single place the backend's error envelope is decoded.
 *
 * Auth DTOs are declared here rather than imported from a shared package: they
 * are three small shapes, and the backend's real source of truth is its
 * generated Prisma types, which must not leak into the browser bundle.
 */

import { IDLE_TIMEOUT_MS, clearActivity, markActivity, readActivity } from './idle';

const BASE = import.meta.env.VITE_API_URL ?? '';

const TOKEN_KEY = 'ep_auth_token';

/** Fired on the window whenever the stored token is dropped. */
export const SESSION_ENDED_EVENT = 'ep:session-ended';

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_CREDENTIALS'
  | 'UNAUTHENTICATED'
  | 'TOKEN_EXPIRED'
  | 'EMAIL_TAKEN'
  | 'NO_ORGANIZATION'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'INTERNAL'
  | 'NETWORK';

/** Verbatim from organization_members_role_check. */
export type Role = 'owner' | 'agent';

export interface AuthUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

export interface AuthOrganization {
  id: string;
  name: string;
  slug: string;
}

export interface AuthSession {
  token: string;
  user: AuthUser;
  organization: AuthOrganization;
  role: Role;
  /** Non-null when this user takes leads — an agent, or an owner who does too. */
  agentProfileId: string | null;
}

export type TeamSize = 'solo' | 'team';

export interface MeResponse {
  user: AuthUser;
  organization: AuthOrganization;
  role: Role;
  agentProfileId: string | null;
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
  INVALID_CREDENTIALS: 'That email and password combination is not correct.',
  UNAUTHENTICATED: 'Please sign in to continue.',
  TOKEN_EXPIRED: 'Your session has expired. Please sign in again.',
  EMAIL_TAKEN: 'An account with that email already exists.',
  NO_ORGANIZATION: 'Your account is not attached to an active organization. Contact your administrator.',
  FORBIDDEN: 'Only the organization owner can do that.',
  NOT_FOUND: 'That page or resource does not exist.',
  CONFLICT: 'That conflicts with something that already exists.',
  RATE_LIMITED: 'Too many attempts. Please wait a minute and try again.',
  INTERNAL: 'Something went wrong on our end. Please try again.',
  NETWORK: 'Cannot reach the server. Check that the API is running.',
};

/**
 * Prefers the server's per-field message when there is exactly one, since
 * "Password must be at least 8 characters" beats a generic form-level error.
 */
export function messageFor(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'VALIDATION_ERROR' && err.details?.length === 1) {
      return err.details[0].message;
    }
    return MESSAGES[err.code] ?? MESSAGES.INTERNAL;
  }
  return MESSAGES.INTERNAL;
}

export const getToken = (): string | null => {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    // private mode, or site data blocked
    return null;
  }
};

export const setToken = (token: string): void => {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* session simply will not survive a reload */
  }
  // Signing in is activity, and starts the idle deadline here rather than on
  // the first mousemove: a tab closed straight after login is still subject to
  // it when it reopens.
  markActivity();
};

/**
 * The token a session restore may use, or null. The one place the persisted
 * idle deadline is judged, and it runs before GET /api/auth/me, which would
 * restore any token inside its 24 hours without knowing about idleness.
 *
 * A missing stamp is initialised rather than treated as expired: it is what
 * every session predating this feature looks like. A stamp inside the window
 * is read but never rewritten, so a reload continues the deadline instead of
 * being granted a fresh 30 minutes.
 */
export const restorableToken = (): string | null => {
  const token = getToken();
  if (token === null) return null;

  const activity = readActivity();
  if (activity === null) {
    markActivity();
    return token;
  }
  if (Date.now() - activity < IDLE_TIMEOUT_MS) return token;

  clearToken();
  return null;
};

export const clearToken = (): void => {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* nothing to clear */
  }
  // The deadline belongs to the session, so it goes with it. Every way a
  // session ends - sign out, idle timeout, a 401 from any fetch wrapper -
  // already comes through here, which is why there is nothing to clean up
  // anywhere else.
  clearActivity();
  // Removing the token is not the same as leaving the authed UI: React is
  // holding the session in state and nothing re-reads localStorage until the
  // next reload. AuthProvider listens for this and resets, so a session that
  // dies mid-use lands on the login page instead of on a shell that 401s.
  try {
    window.dispatchEvent(new Event(SESSION_ENDED_EVENT));
  } catch {
    /* no window (tests, SSR): the token is still gone, which is the point */
  }
};

/**
 * Codes that mean "this token is finished". INVALID_CREDENTIALS is also a 401
 * but comes from the login form, where there is no session to end - treating it
 * as one would clear a token the user is about to replace anyway, and would
 * bounce a signed-in user who mistyped a password on a re-auth prompt.
 */
const SESSION_ENDING_CODES = ['UNAUTHENTICATED', 'TOKEN_EXPIRED'];

/**
 * The one place a dead session is recognised, for every fetch wrapper in the
 * app: this module's apiFetch, api/client.ts and lib/liveEvents.ts. Put the
 * decision in each caller instead and they drift, which is exactly how
 * client.ts and liveEvents.ts ended up leaving a dead token in localStorage.
 *
 * A 403 is a permission error on a perfectly good session and never ends it;
 * neither does a 404, a 429 or a 500. Returns whether the session was ended.
 */
export function endSessionIfUnauthenticated(status: number, code?: string): boolean {
  if (status !== 401) return false;
  // A 401 whose envelope we could not read (a proxy's HTML error page) is still
  // a rejected token: fail towards the login page rather than towards a loop.
  if (code !== undefined && !SESSION_ENDING_CODES.includes(code)) return false;

  clearToken();
  return true;
}

export async function apiFetch<T>(
  path: string,
  options: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<T> {
  const { method = 'GET', body, auth = false } = options;

  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) {
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(`${BASE}/api${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError('NETWORK', MESSAGES.NETWORK, 0);
  }

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    /* fall through to the generic error below */
  }

  if (!response.ok) {
    const envelope = (payload as { error?: { code?: string; message?: string; details?: ErrorDetail[] } } | null)
      ?.error;
    const code = (envelope?.code ?? 'INTERNAL') as ErrorCode;

    // An expired token is not an error the user needs to read — it is just a
    // session that ended. Drop it so the guard falls through to the login page.
    endSessionIfUnauthenticated(response.status, code);

    throw new ApiError(code, envelope?.message ?? MESSAGES[code] ?? MESSAGES.INTERNAL, response.status, envelope?.details);
  }

  return payload as T;
}

/**
 * No form asks for a timezone - the device already knows it. An environment
 * without ICU data returns '' here, and JSON.stringify drops the undefined key,
 * so the request simply omits it and the backend fallback stands.
 *
 * Exported for agentsApi: two copies of this would be two answers.
 */
export const localTimeZone = (): string | undefined => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
};

export const api = {
  signup: (body: {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    organizationName: string;
    /** "Just me" also makes the owner an agent; "I have a team" does not. */
    teamSize: TeamSize;
  }) =>
    apiFetch<AuthSession>('/auth/signup', {
      method: 'POST',
      body: { ...body, timezone: localTimeZone() },
    }),

  login: (body: { email: string; password: string }) =>
    apiFetch<AuthSession>('/auth/login', { method: 'POST', body }),

  me: () => apiFetch<MeResponse>('/auth/me', { auth: true }),

  /** Real user input happened. The only thing that keeps a session alive. */
  heartbeat: () => apiFetch<null>('/auth/heartbeat', { method: 'POST', auth: true }),

  /** Revokes the session server-side; the token stops working everywhere. */
  logout: () => apiFetch<null>('/auth/logout', { method: 'POST', auth: true }),
};
