import React, { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { messageFor, type TeamSize } from '../../lib/api';
import { AuthLayout, Field, FormError, SubmitButton } from './AuthLayout';

const TEAM_SIZES: { id: TeamSize; label: string; hint: string }[] = [
  { id: 'solo', label: 'Just me', hint: 'I take my own leads and appointments' },
  { id: 'team', label: 'I have a team', hint: 'I will add agents to take leads' },
];

export const SignupPage: React.FC = () => {
  const { status, signup } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  // No default: whether the owner takes leads themselves decides where hot leads
  // go from the first minute, so it is asked, not assumed.
  const [teamSize, setTeamSize] = useState<TeamSize | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (status === 'authed') return <Navigate to="/" replace />;

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!teamSize) {
      setError('Tell us who will handle your leads.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await signup({ email, password, firstName, lastName, organizationName, teamSize });
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
          label="Organization name"
          name="organizationName"
          value={organizationName}
          autoComplete="organization"
          onChange={setOrganizationName}
          disabled={busy}
        />
        <fieldset disabled={busy} className="disabled:opacity-50">
          <legend className="block text-xs font-medium text-slate-300 mb-1.5">
            Who will handle your leads?
          </legend>
          <div className="grid grid-cols-2 gap-3" role="radiogroup">
            {TEAM_SIZES.map((opt) => {
              const selected = teamSize === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setTeamSize(opt.id)}
                  className={`text-left px-3 py-2.5 rounded-lg border transition-colors cursor-pointer ${
                    selected
                      ? 'bg-emerald-600/15 border-emerald-600 ring-1 ring-emerald-600/40'
                      : 'bg-slate-950 border-slate-800 hover:border-slate-700'
                  }`}
                >
                  <span className="block text-sm font-semibold text-slate-100">{opt.label}</span>
                  <span className="block text-xs text-slate-500 mt-0.5">{opt.hint}</span>
                </button>
              );
            })}
          </div>
          <span className="block text-xs text-slate-500 mt-1">
            You can change this later on the Agent Team page.
          </span>
        </fieldset>
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
          hint="At least 8 characters."
        />
        <SubmitButton busy={busy}>Create account</SubmitButton>
      </form>
    </AuthLayout>
  );
};
