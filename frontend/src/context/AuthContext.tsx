import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  ApiError,
  SESSION_ENDED_EVENT,
  api,
  clearToken,
  getToken,
  setToken,
  type AuthOrganization,
  type AuthUser,
  type MeResponse,
  type Role,
} from '../lib/api';
import { startIdleWatch } from '../lib/idle';

type AuthStatus = 'loading' | 'authed' | 'anon';

interface AuthContextType {
  status: AuthStatus;
  user: AuthUser | null;
  organization: AuthOrganization | null;
  role: Role | null;
  agentProfileId: string | null;
  /** Set when a session restore fails for a reason worth retrying (network). */
  restoreError: string | null;
  login: (email: string, password: string) => Promise<void>;
  signup: (input: {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    organizationName: string;
  }) => Promise<void>;
  logout: () => void;
  retryRestore: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  /**
   * Computed synchronously on the very first render. With no token there is
   * nothing to restore, so the answer is 'anon' immediately — no fetch, no
   * spinner, and no flash of the login page for a user who is signed in.
   */
  const [status, setStatus] = useState<AuthStatus>(() => (getToken() ? 'loading' : 'anon'));
  const [user, setUser] = useState<AuthUser | null>(null);
  const [organization, setOrganization] = useState<AuthOrganization | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [agentProfileId, setAgentProfileId] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreNonce, setRestoreNonce] = useState(0);

  const applySession = (data: MeResponse): void => {
    setUser(data.user);
    setOrganization(data.organization);
    setRole(data.role);
    setAgentProfileId(data.agentProfileId);
    setRestoreError(null);
    setStatus('authed');
  };

  const reset = (): void => {
    setUser(null);
    setOrganization(null);
    setRole(null);
    setAgentProfileId(null);
    setStatus('anon');
  };

  useEffect(() => {
    if (!getToken()) {
      reset();
      return;
    }

    let cancelled = false;
    setStatus('loading');

    api
      .me()
      .then((data) => {
        if (!cancelled) applySession(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;

        // A network failure is not proof the token is bad — keep it, surface a
        // retry, and do not strand the user on a spinner.
        if (err instanceof ApiError && err.code === 'NETWORK') {
          setRestoreError('Cannot reach the server.');
          reset();
          return;
        }

        // Anything else (expired, revoked, user suspended) means this token is
        // no longer usable.
        clearToken();
        setRestoreError(null);
        reset();
      });

    return () => {
      cancelled = true;
    };
  }, [restoreNonce]);

  /**
   * Any fetch wrapper that drops a rejected token (endSessionIfUnauthenticated)
   * ends the session here too. Without this the token is gone from localStorage
   * but the shell keeps rendering as 'authed' until the next reload, which is
   * the state a 24-hour expiry now puts users in daily rather than weekly.
   *
   * Mount-once: the handler only calls setState setters, which are stable.
   */
  useEffect(() => {
    const onSessionEnded = (): void => reset();
    window.addEventListener(SESSION_ENDED_EVENT, onSessionEnded);
    return () => window.removeEventListener(SESSION_ENDED_EVENT, onSessionEnded);
  }, []);

  /**
   * signup and login return {token, user, organization, role} — agentProfileId
   * is a /me field only, so it stays null until the next session restore.
   * Nothing in this slice reads it; refetching purely to fill it in would be a
   * second round trip for an unused value.
   */
  const login: AuthContextType['login'] = async (email, password) => {
    const session = await api.login({ email, password });
    setToken(session.token);
    applySession({ ...session, agentProfileId: null });
  };

  const signup: AuthContextType['signup'] = async (input) => {
    const session = await api.signup(input);
    setToken(session.token);
    applySession({ ...session, agentProfileId: null });
  };

  const logout = (): void => {
    // Revoke server-side first: apiFetch reads the token synchronously, before
    // the clearToken below removes it. Best-effort - if the call fails the
    // session still dies on its own idle timeout.
    if (getToken()) api.logout().catch(() => {});
    clearToken();
    setRestoreError(null);
    reset();
  };

  /**
   * Idle timeout. Signing in flips status to 'authed' and starts a fresh
   * 30-minute watch; logging out (or an idle logout itself) flips it back and
   * the cleanup clears the timer and the listeners. Activity is reported to the
   * backend as a heartbeat, which is what keeps the server-side session alive.
   * A 401 on it ends the session through apiFetch like any other call.
   */
  useEffect(
    () => startIdleWatch(status, logout, () => void api.heartbeat().catch(() => {})),
    [status],
  );

  const retryRestore = (): void => setRestoreNonce((n) => n + 1);

  return (
    <AuthContext.Provider
      value={{
        status,
        user,
        organization,
        role,
        agentProfileId,
        restoreError,
        login,
        signup,
        logout,
        retryRestore,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

/** "Ada Lovelace", or the email when the name columns are null. */
export const displayName = (user: AuthUser | null): string => {
  if (!user) return '';
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return name.length > 0 ? name : user.email;
};

/** "AL", or the first two characters of the email. */
export const initialsFor = (user: AuthUser | null): string => {
  if (!user) return '';
  const first = user.firstName?.trim()?.[0] ?? '';
  const last = user.lastName?.trim()?.[0] ?? '';
  const initials = (first + last).toUpperCase();
  return initials.length > 0 ? initials : user.email.slice(0, 2).toUpperCase();
};

const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  agent: 'Agent',
};

export const roleLabel = (role: Role | null): string => (role ? ROLE_LABELS[role] ?? role : '');
