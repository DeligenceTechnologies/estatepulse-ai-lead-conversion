import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, clearToken, messageFor } from '../../lib/api';
import { AuthLayout, FormError, MIN_PASSWORD_LENGTH, PasswordField, SubmitButton } from './AuthLayout';

type LinkState = { kind: 'checking' } | { kind: 'ready' } | { kind: 'invalid'; message: string };

const requestNewLink = (
  <Link to="/forgot-password" className="text-emerald-400 hover:text-emerald-300 font-medium">
    Request a new link
  </Link>
);

/**
 * Where the reset email lands. The token is read once and dropped from the
 * address bar straight away, so it does not stay in history or get shared
 * with a copied URL. The link is checked before the form is shown.
 */
export const ResetPasswordPage: React.FC = () => {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [token] = useState(() => params.get('token') ?? '');
  const [link, setLink] = useState<LinkState>({ kind: 'checking' });

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    navigate('/reset-password', { replace: true });
    if (!token) {
      setLink({ kind: 'invalid', message: 'This password reset link is incomplete. Open it again from the email.' });
      return;
    }
    let active = true;
    api
      .validateResetToken(token)
      .then(() => active && setLink({ kind: 'ready' }))
      .catch((err) => active && setLink({ kind: 'invalid', message: messageFor(err) }));
    return () => {
      active = false;
    };
    // Runs once: the token is captured on first render and the URL is then cleared.
  }, []);

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await api.resetPassword({ token, newPassword: password, confirmPassword: confirm });
      // The server signed this account out everywhere; drop any session this browser still holds.
      // The login page then explains why with its "password changed" notice.
      clearToken('password_changed');
      navigate('/login', { replace: true });
    } catch (err) {
      setError(messageFor(err));
      setBusy(false);
    }
  };

  const footer = (
    <Link to="/login" className="text-emerald-400 hover:text-emerald-300 font-medium">
      Back to sign in
    </Link>
  );

  if (link.kind === 'checking') {
    return (
      <AuthLayout title="Reset your password" subtitle="Checking your link…" footer={footer}>
        <div className="h-24" aria-busy="true" />
      </AuthLayout>
    );
  }

  if (link.kind === 'invalid') {
    return (
      <AuthLayout title="Link not valid" subtitle="This reset link cannot be used." footer={footer}>
        <FormError message={link.message} />
        <p className="text-sm text-slate-400">
          Reset links work once and expire after 30 minutes. {requestNewLink}
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Choose a new password"
      subtitle="You will be signed out on all devices and can sign in with the new password."
      footer={footer}
    >
      <FormError message={error} />
      <form onSubmit={onSubmit} className="space-y-4">
        <PasswordField
          label="New password"
          name="new-password"
          value={password}
          autoComplete="new-password"
          onChange={setPassword}
          disabled={busy}
          minLength={MIN_PASSWORD_LENGTH}
          maxLength={128}
          hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
          required
        />
        <PasswordField
          label="Confirm new password"
          name="confirm-password"
          value={confirm}
          autoComplete="new-password"
          onChange={setConfirm}
          disabled={busy}
          maxLength={128}
          required
        />
        <SubmitButton busy={busy}>Update password</SubmitButton>
      </form>
    </AuthLayout>
  );
};
