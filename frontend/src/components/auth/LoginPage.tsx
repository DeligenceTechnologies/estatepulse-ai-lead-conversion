import React, { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { messageFor } from '../../lib/api';
import { AuthLayout, Field, FormError, SubmitButton } from './AuthLayout';

interface FromState {
  from?: { pathname?: string };
}

export const LoginPage: React.FC = () => {
  const { status, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Land back on whatever the guard interrupted.
  const target = (location.state as FromState | null)?.from?.pathname ?? '/';

  if (status === 'authed') return <Navigate to={target} replace />;

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email, password);
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
        />
        <Field
          label="Password"
          name="password"
          type="password"
          value={password}
          autoComplete="current-password"
          onChange={setPassword}
          disabled={busy}
        />
        <SubmitButton busy={busy}>Sign in</SubmitButton>
      </form>
    </AuthLayout>
  );
};
