import React, { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { messageFor } from '../../lib/api';
import { AuthLayout, Field, FormError, SubmitButton } from './AuthLayout';

export const SignupPage: React.FC = () => {
  const { status, signup } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (status === 'authed') return <Navigate to="/" replace />;

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signup({ email, password, firstName, lastName, organizationName });
      navigate('/', { replace: true });
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title="Create your workspace"
      subtitle="Sets up your account and your brokerage. You become its owner."
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="text-emerald-400 hover:text-emerald-300 font-medium">
            Sign in
          </Link>
        </>
      }
    >
      <FormError message={error} />
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="First name"
            name="firstName"
            value={firstName}
            autoComplete="given-name"
            onChange={setFirstName}
            disabled={busy}
          />
          <Field
            label="Last name"
            name="lastName"
            value={lastName}
            autoComplete="family-name"
            onChange={setLastName}
            disabled={busy}
          />
        </div>
        <Field
          label="Brokerage name"
          name="organizationName"
          value={organizationName}
          autoComplete="organization"
          onChange={setOrganizationName}
          disabled={busy}
        />
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
          autoComplete="new-password"
          onChange={setPassword}
          disabled={busy}
          hint="At least 12 characters."
        />
        <SubmitButton busy={busy}>Create account</SubmitButton>
      </form>
    </AuthLayout>
  );
};
