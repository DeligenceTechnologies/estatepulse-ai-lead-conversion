/**
 * The single place the backend's error envelope is decoded.
 *
 * Auth DTOs are declared here rather than imported from a shared package: they
 * are three small shapes, and the backend's real source of truth is its
 * generated Prisma types, which must not leak into the browser bundle.
 */

const BASE = import.meta.env.VITE_API_URL ?? '';

const TOKEN_KEY = 'ep_auth_token';

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_CREDENTIALS'
  | 'UNAUTHENTICATED'
  | 'TOKEN_EXPIRED'
  | 'EMAIL_TAKEN'
  | 'NO_ORGANIZATION'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'INTERNAL'
  | 'NETWORK';

/** Verbatim from organization_members.role_check. */
export type Role = 'owner' | 'admin' | 'team_lead' | 'manager' | 'agent' | 'viewer';

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
}

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
  NOT_FOUND: 'That page or resource does not exist.',
  RATE_LIMITED: 'Too many attempts. Please wait a minute and try again.',
  INTERNAL: 'Something went wrong on our end. Please try again.',
  NETWORK: 'Cannot reach the server. Check that the API is running.',
};

/**
 * Prefers the server's per-field message when there is exactly one, since
 * "Password must be at least 12 characters" beats a generic form-level error.
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
};

export const clearToken = (): void => {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* nothing to clear */
  }
};

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
    if (code === 'TOKEN_EXPIRED') clearToken();

    throw new ApiError(code, envelope?.message ?? MESSAGES[code] ?? MESSAGES.INTERNAL, response.status, envelope?.details);
  }

  return payload as T;
}

export const api = {
  signup: (body: {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    organizationName: string;
  }) => apiFetch<AuthSession>('/auth/signup', { method: 'POST', body }),

  login: (body: { email: string; password: string }) =>
    apiFetch<AuthSession>('/auth/login', { method: 'POST', body }),

  me: () => apiFetch<MeResponse>('/auth/me', { auth: true }),
};
