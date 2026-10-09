import React, { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, User, Users } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { messageFor, type OrganizationType } from '../../lib/api';
import { AuthLayout, Field, FormError, MIN_PASSWORD_LENGTH, PasswordField, SubmitButton } from './AuthLayout';

const ACCOUNT_TYPES: {
  value: OrganizationType;
  title: string;
  description: string;
  roles: string;
  icon: React.ReactNode;
}[] = [
  {
    value: 'individual',
    title: 'Just me',
    description: 'I work my own leads. I run the business and take the calls myself.',
    roles: 'You get the Owner and Agent roles, and can switch between the two views.',
    icon: <User className="w-5 h-5" />,
  },
  {
    value: 'team',
    title: 'I have a team',
    description: 'I manage agents who work the leads. I add them after signing up.',
    roles: 'You get the Owner role. Add your team from the Team Members page.',
    icon: <Users className="w-5 h-5" />,
  },
];

export const SignupPage: React.FC = () => {
  const { status, signup } = useAuth();
  const navigate = useNavigate();

  /** Step 1 picks this; step 2 is the account form. */
  const [organizationType, setOrganizationType] = useState<OrganizationType | null>(null);
  const [step, setStep] = useState<1 | 2>(1);
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
    if (!organizationType) {
      setStep(1);
      return;
    }
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
        organizationType,
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

  const chosen = ACCOUNT_TYPES.find((t) => t.value === organizationType);

  return (
    <AuthLayout
      title={step === 1 ? 'How will you use EstatePulse?' : 'Create your workspace'}
      subtitle={
        step === 1
          ? 'This decides the roles your account starts with. You can add agents later either way.'
          : 'Sets up your account and your organization. You become its owner.'
      }
      footer={
        <>
            Already have an account?{' '}
            <Link to="/login" className="text-emerald-400 hover:text-emerald-300 font-medium">
              Sign in
            </Link>
        </>
      }
    >
      <StepIndicator step={step} />

      {step === 1 ? (
        <div className="space-y-3">
          <div role="radiogroup" aria-label="Account type" className="space-y-3">
            {ACCOUNT_TYPES.map((type) => {
              const selected = organizationType === type.value;
              return (
                <button
                  key={type.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setOrganizationType(type.value)}
                  className={`w-full text-left flex items-start gap-3 p-4 rounded-xl border transition-colors cursor-pointer ${
                    selected
                      ? 'border-emerald-500 bg-emerald-500/10 ring-1 ring-emerald-500/40'
                      : 'border-slate-800 bg-slate-950/40 hover:border-slate-700'
                  }`}
                >
                  <div
                    className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${
                      selected ? 'bg-emerald-600 text-on-accent' : 'bg-slate-800 text-slate-300'
                    }`}
                  >
                    {type.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-slate-100">{type.title}</div>
                    <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">{type.description}</p>
                    <p className={`text-xs mt-2 leading-relaxed ${selected ? 'text-emerald-300' : 'text-slate-500'}`}>
                      {type.roles}
                    </p>
                  </div>
                  <span
                    className={`w-5 h-5 rounded-full border flex items-center justify-center shrink-0 mt-0.5 ${
                      selected ? 'bg-emerald-600 border-emerald-500 text-on-accent' : 'border-slate-600'
                    }`}
                  >
                    {selected && <Check className="w-3 h-3" strokeWidth={3} />}
                  </span>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => setStep(2)}
            disabled={!organizationType}
            className="w-full px-4 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 disabled:hover:bg-emerald-600 text-on-accent text-sm font-semibold transition-colors cursor-pointer disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
          >
            Continue
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <>
        {chosen && (
          <div className="mb-4 flex items-center gap-2.5 px-3 py-2 rounded-lg bg-slate-950/50 border border-slate-800">
            <span className="text-emerald-400">{chosen.icon}</span>
            <span className="text-xs text-slate-300 flex-1">
              <span className="font-semibold text-slate-100">{chosen.title}</span>
              {organizationType === 'individual' ? ' · Owner + Agent' : ' · Owner'}
            </span>
            <button
              type="button"
              onClick={() => setStep(1)}
              disabled={busy}
              className="text-xs font-semibold text-emerald-400 hover:text-emerald-300 cursor-pointer disabled:cursor-not-allowed"
            >
              Change
            </button>
          </div>
        )}
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
            label={organizationType === 'individual' ? 'Business name' : 'Organization name'}
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
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setStep(1)}
              disabled={busy}
              aria-label="Back"
              className="px-3 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div className="flex-1">
              <SubmitButton busy={busy} disabled={mismatch}>
                Create account
              </SubmitButton>
            </div>
          </div>
        </form>
        </>
      )}
    </AuthLayout>
  );
};

const StepIndicator: React.FC<{ step: 1 | 2 }> = ({ step }) => (
  <ol className="flex items-center gap-2 mb-5 text-2xs font-semibold uppercase tracking-wider">
    {(['Account type', 'Your details'] as const).map((label, i) => {
      const n = i + 1;
      const done = step > n;
      const active = step === n;
      return (
        <React.Fragment key={label}>
          {i > 0 && <span className={`flex-1 h-px ${step > 1 ? 'bg-emerald-600' : 'bg-slate-800'}`} />}
          <li className={`flex items-center gap-1.5 ${active || done ? 'text-emerald-300' : 'text-slate-500'}`}>
            <span
              className={`w-5 h-5 rounded-full flex items-center justify-center text-2xs ${
                done
                  ? 'bg-emerald-600 text-on-accent'
                  : active
                    ? 'border border-emerald-500 text-emerald-300'
                    : 'border border-slate-700'
              }`}
            >
              {done ? <Check className="w-3 h-3" strokeWidth={3} /> : n}
            </span>
            {label}
          </li>
        </React.Fragment>
      );
    })}
  </ol>
);
