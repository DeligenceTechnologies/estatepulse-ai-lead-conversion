import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { MailCheck } from 'lucide-react';
import { toast } from 'react-toastify';
import { api, messageFor } from '../../lib/api';
import { AuthLayout, Field, FormError, SubmitButton } from './AuthLayout';

export interface CheckEmailState {
  email?: string;
  /** signup: just registered. login: tried to sign in before confirming. */
  from?: 'signup' | 'login';
}

/** Matches the server's per-account cooldown, so the button never offers a resend it would drop. */
const RESEND_COOLDOWN_SECONDS = 60;

/**
 * "Confirm your email": after sign-up, after a sign-in refused for an
 * unconfirmed address, or reached directly to ask for a new link. The server
 * answers a resend the same for every address.
 */
export const CheckEmailPage: React.FC = () => {
  const state = (useLocation().state as CheckEmailState | null) ?? {};
  const [email, setEmail] = useState(state.email ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A link went out at sign-up, so the first resend waits out the cooldown too.
  const [cooldown, setCooldown] = useState(state.from === 'signup' ? RESEND_COOLDOWN_SECONDS : 0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const resend = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.resendVerification(email.trim());
      toast.success('If that email is waiting to be confirmed, a new link is on its way.');
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  };

  const known = Boolean(state.email);
  const title = state.from === 'login' ? 'Confirm your email first' : 'Check your email';

  return (
    <AuthLayout
      title={title}
      subtitle="One more step to activate your account."
      footer={
        <Link to="/login" className="text-emerald-400 hover:text-emerald-300 font-medium">
          Back to sign in
        </Link>
      }
    >
      <div className="flex items-start gap-3 text-sm text-slate-300 mb-5">
        <MailCheck className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
        <div className="space-y-2">
          {known ? (
            <p>
              We sent a confirmation link to <span className="font-medium text-slate-100">{state.email}</span>. Open it
              to activate your account and sign in.
            </p>
          ) : (
            <p>Enter the email you signed up with and we will send a new confirmation link.</p>
          )}
          <p className="text-slate-400">The link expires in 24 hours. Not there? Check your spam folder.</p>
        </div>
      </div>

      <FormError message={error} />
      <form onSubmit={resend} className="space-y-4">
        {!known && (
          <Field
            label="Email"
            name="email"
            type="email"
            value={email}
            autoComplete="email"
            onChange={setEmail}
            disabled={busy}
            maxLength={255}
            required
          />
        )}
        <SubmitButton busy={busy} disabled={cooldown > 0 || !email.trim()}>
          {cooldown > 0 ? `Resend link in ${cooldown}s` : 'Resend confirmation link'}
        </SubmitButton>
      </form>
    </AuthLayout>
  );
};
