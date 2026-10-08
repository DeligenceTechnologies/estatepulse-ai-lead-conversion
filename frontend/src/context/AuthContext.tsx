import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ApiError,
  SESSION_ENDED_EVENT,
  api,
  clearToken,
  getToken,
  isKeepSignedIn,
  refreshAccessToken,
  rememberSession,
  restorableSession,
  setToken,
  type AuthOrganization,
  type AuthRole,
  type AuthSessionResponse,
  type AuthUser,
  type ChangePasswordInput,
  type MeResponse,
  type RegisterInput,
  type Role,
} from '../lib/api';
import { startIdleWatch } from '../lib/idle';

type AuthStatus = 'loading' | 'authed' | 'anon';

interface AuthContextType {
  status: AuthStatus;
  user: AuthUser | null;
  organization: AuthOrganization | null;
  /** Which shell to show: the system (Owner) role gets the owner app. */
  role: Role | null;
  /** The role as named by the organization, e.g. "Owner", "Agent", "Team Lead". */
  roleName: string | null;
  roleDetails: AuthRole | null;
  /** Effective permission keys, e.g. "user.create". */
  permissions: string[];
  /** UI courtesy only — the server enforces every permission itself. */
  can: (permission: string) => boolean;
  /** The current backend has no agent profiles; kept for the views that read it. */
  agentProfileId: string | null;
  /** Set when a session restore fails for a reason worth retrying (network). */
  restoreError: string | null;
  /**
   * True only between an explicit logout and the next login/signup. Lets
   * RequireAuth skip recording `from` so a deliberate sign-out starts the
   * next session on the dashboard. Idle timeouts and expired sessions never
   * set this, so signing back in still returns to the interrupted page.
   */
  explicitLogout: boolean;
  login: (email: string, password: string, keepSignIn: boolean) => Promise<void>;
  signup: (input: RegisterInput) => Promise<void>;
  /** Re-reads /auth/me, e.g. after the user's role or profile changed. */
  refreshSession: () => Promise<void>;
  logout: () => void;
  /** Signs out on every device. */
  logoutAll: () => Promise<void>;
  /** Changes the password; the server then ends every session, this one included. */
  changePassword: (input: ChangePasswordInput) => Promise<void>;
  retryRestore: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  /**
   * Computed synchronously on the very first render. With no stored session
   * there is nothing to restore, so the answer is 'anon' immediately — no
   * fetch, no spinner, and no flash of the login page for a user who is signed
   * in. A session the idle deadline has already outlived is not restorable.
   */
  const [status, setStatus] = useState<AuthStatus>(() => (restorableSession() ? 'loading' : 'anon'));
  const [me, setMe] = useState<MeResponse | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreNonce, setRestoreNonce] = useState(0);
  const [explicitLogout, setExplicitLogout] = useState(false);
  const navigate = useNavigate();

  const applySession = (data: MeResponse): void => {
    setMe(data);
    setRestoreError(null);
    setStatus('authed');
  };

  const reset = (): void => {
    setMe(null);
    setStatus('anon');
  };

  useEffect(() => {
    if (!restorableSession()) {
      reset();
      return;
    }

    let cancelled = false;
    setStatus('loading');

    // A reload has no access token in memory: the refresh cookie buys one.
    refreshAccessToken()
      .then(() => api.me())
      .then((data) => {
        if (!cancelled) applySession(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;

        // A network failure is not proof the session is bad — keep it, surface
        // a retry, and do not strand the user on a spinner.
        if (err instanceof ApiError && err.code === 'NETWORK') {
          setRestoreError('Cannot reach the server.');
          reset();
          return;
        }

        // Anything else (expired, revoked, account switched off) means this
        // session is finished. The refresh has usually dropped it already.
        clearToken();
        setRestoreError(null);
        reset();
      });

    return () => {
      cancelled = true;
    };
  }, [restoreNonce]);

  /**
   * Any fetch wrapper that sees a rejected session (endSessionIfUnauthenticated),
   * a failed background refresh, or a sign-out in another tab ends the session
   * here too, so the shell never keeps rendering as 'authed' on a dead session.
   */
  useEffect(() => {
    const onSessionEnded = (): void => reset();
    window.addEventListener(SESSION_ENDED_EVENT, onSessionEnded);
    return () => window.removeEventListener(SESSION_ENDED_EVENT, onSessionEnded);
  }, []);

  /**
   * login/register answer the tokens and the bare user; the organization, role
   * and permissions come from /auth/me, which is also what a reload reads, so
   * there is one source for "who is signed in".
   */
  const startSession = async (session: AuthSessionResponse, keepSignIn: boolean): Promise<void> => {
    setToken(session.accessToken, session.accessTokenExpiresAt);
    rememberSession(keepSignIn);
    setExplicitLogout(false);
    try {
      applySession(await api.me());
    } catch (err) {
      clearToken();
      throw err;
    }
  };

  const login: AuthContextType['login'] = async (email, password, keepSignIn) => {
    await startSession(await api.login({ email, password, keepSignIn }), keepSignIn);
  };

  const signup: AuthContextType['signup'] = async (input) => {
    await startSession(await api.register(input), false);
  };

  const refreshSession: AuthContextType['refreshSession'] = async () => {
    applySession(await api.me());
  };

  const endSession = useCallback((reason: Parameters<typeof clearToken>[0] = null): void => {
    // Revoke server-side with the token captured now, before clearToken drops
    // it. Best effort: if the call fails the session still expires on its own.
    const token = getToken();
    if (token) api.logout(token).catch(() => {});
    clearToken(reason);
    setRestoreError(null);
    reset();
  }, []);

  /**
   * The Sign out button. Goes to /login directly so RequireAuth never records
   * the current page as `from`: a deliberate sign-out starts the next session
   * on the dashboard. An idle timeout or an expired session still goes through
   * RequireAuth, so signing back in returns to the page that was interrupted.
   */
  const logout = (): void => {
    endSession();
    setExplicitLogout(true);
    navigate('/login', { replace: true });
  };

  const logoutAll: AuthContextType['logoutAll'] = async () => {
    await api.logoutAll();
    clearToken('signed_out_everywhere');
    reset();
    setExplicitLogout(true);
    navigate('/login', { replace: true });
  };

  const changePassword: AuthContextType['changePassword'] = async (input) => {
    await api.changePassword(input);
    // The server has already revoked every session; only local state is left.
    clearToken('password_changed');
    reset();
    setExplicitLogout(true);
    navigate('/login', { replace: true });
  };

  /**
   * Idle timeout: 30 minutes without input ends a session, unless the user
   * chose "keep me signed in" at login. Signing in flips status to 'authed'
   * and starts a fresh watch; signing out tears it down.
   */
  useEffect(
    () => (isKeepSignedIn() ? undefined : startIdleWatch(status, () => endSession('idle'))),
    [status, endSession],
  );

  const retryRestore = (): void => setRestoreNonce((n) => n + 1);

  const permissions = me?.permissions ?? [];

  return (
    <AuthContext.Provider
      value={{
        status,
        user: me,
        organization: me?.organization ?? null,
        role: me ? (me.role.isSystem ? 'owner' : 'agent') : null,
        roleName: me?.role.name ?? null,
        roleDetails: me?.role ?? null,
        permissions,
        can: (permission) => permissions.includes(permission),
        agentProfileId: null,
        restoreError,
        explicitLogout,
        login,
        signup,
        refreshSession,
        logout,
        logoutAll,
        changePassword,
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

/** "Ada Lovelace", or the email when the name is empty. */
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
