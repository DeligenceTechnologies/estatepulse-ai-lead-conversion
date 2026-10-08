import React, { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { messageFor } from '../../lib/api';
import { AuthLayout, Field, FormError, MIN_PASSWORD_LENGTH, PasswordField, SubmitButton } from './AuthLayout';

export const SignupPage: React.FC = () => {
  const { status, signup } = useAuth();
  const navigate = useNavigate();

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (status === 'authed') return <Navigate to="/" replace />;

  // Only flagged once the user has typed in the confirm box.
  const mismatch = confirmPassword.length > 0 && confirmPassword !== password;

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await signup({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        organizationName: organizationName.trim(),
        email: email.trim(),
        phone: phone.trim(),
        password,
      });
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
      subtitle="Sets up your account and your organization. You become its owner."
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
            required
            maxLength={100}
          />
          <Field
            label="Last name"
            name="lastName"
            value={lastName}
            autoComplete="family-name"
            onChange={setLastName}
            disabled={busy}
            required
            maxLength={100}
          />
        </div>
        <Field
          label="Organization name"
          name="organizationName"
          value={organizationName}
          autoComplete="organization"
          onChange={setOrganizationName}
          disabled={busy}
          required
          maxLength={255}
        />
        <Field
          label="Email"
          name="email"
          type="email"
          value={email}
          autoComplete="email"
          onChange={setEmail}
          disabled={busy}
          required
          maxLength={255}
        />
        <Field
          label="Phone"
          name="phone"
          type="tel"
          value={phone}
          autoComplete="tel"
          onChange={setPhone}
          disabled={busy}
          required
          maxLength={50}
          placeholder="+91 98765 43210"
        />
        <PasswordField
          label="Password"
          name="password"
          value={password}
          autoComplete="new-password"
          onChange={setPassword}
          disabled={busy}
          required
          minLength={MIN_PASSWORD_LENGTH}
          maxLength={128}
          hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
        />
        <PasswordField
          label="Confirm password"
          name="confirmPassword"
          value={confirmPassword}
          autoComplete="new-password"
          onChange={setConfirmPassword}
          disabled={busy}
          required
          maxLength={128}
          error={mismatch ? 'Passwords do not match.' : null}
        />
        <SubmitButton busy={busy} disabled={mismatch}>
          Create account
        </SubmitButton>
      </form>
    </AuthLayout>
  );
};
