import React, { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { consumeSessionEndReason, messageFor, type SessionEndReason } from '../../lib/api';
import { AuthLayout, Checkbox, Field, FormError, FormNotice, PasswordField, SubmitButton } from './AuthLayout';

interface FromState {
  from?: { pathname?: string };
}

const END_REASON_NOTICES: Record<SessionEndReason, string> = {
  expired: 'Your session has expired. Please sign in again.',
  idle: 'You were signed out after 30 minutes of inactivity.',
  security: 'For your security you were signed out on all devices. Please sign in again.',
  password_changed: 'Your password was changed. Sign in with your new password.',
  signed_out_everywhere: 'You have been signed out on all devices.',
};

export const LoginPage: React.FC = () => {
  const { status, login, restoreError, retryRestore } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [keepSignIn, setKeepSignIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Read once: the reason belongs to this visit of the page, not to the next.
  const [notice] = useState(() => {
    const reason = consumeSessionEndReason();
    return reason ? END_REASON_NOTICES[reason] : null;
  });

  // Land back on whatever the guard interrupted.
  const target = (location.state as FromState | null)?.from?.pathname ?? '/';

  if (status === 'authed') return <Navigate to={target} replace />;

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email.trim(), password, keepSignIn);
      navigate(target, { replace: true });
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title="Sign in"
      subtitle="Access your lead conversion workspace."
      footer={
        <>
          No account yet?{' '}
          <Link to="/signup" className="text-emerald-400 hover:text-emerald-300 font-medium">
            Create one
          </Link>
        </>
      }
    >
      {restoreError && (
        <div role="alert" className="mb-4 px-3 py-2.5 rounded-lg bg-amber-950/40 border border-amber-900/60 text-sm text-amber-200">
          {restoreError}{' '}
          <button type="button" onClick={retryRestore} className="underline font-medium cursor-pointer">
            Retry
          </button>
        </div>
      )}
      {!error && <FormNotice message={notice} />}
      <FormError message={error} />
      <form onSubmit={onSubmit} className="space-y-4">
        <Field
          label="Email"
          name="email"
          type="email"
          value={email}
          autoComplete="email"
          onChange={setEmail}
          disabled={busy}
          required
        />
        <PasswordField
          label="Password"
          name="password"
          value={password}
          autoComplete="current-password"
          onChange={setPassword}
          disabled={busy}
          required
        />
        <Checkbox
          label="Keep me signed in"
          hint="Stay signed in on this device for 30 days. Don't use on a shared computer."
          checked={keepSignIn}
          onChange={setKeepSignIn}
          disabled={busy}
        />
        <SubmitButton busy={busy}>Sign in</SubmitButton>
      </form>
    </AuthLayout>
  );
};
