import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { MailCheck } from 'lucide-react';
import { api, messageFor } from '../../lib/api';
import { AuthLayout, Field, FormError, SubmitButton } from './AuthLayout';

/**
 * Asks for a reset link. The server answers the same for every address, so
 * this page never says whether an account exists either.
 */
export const ForgotPasswordPage: React.FC = () => {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const address = email.trim();
      await api.forgotPassword(address);
      setSentTo(address);
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  };

  const footer = (
    <>
      Remembered it?{' '}
      <Link to="/login" className="text-emerald-400 hover:text-emerald-300 font-medium">
        Back to sign in
      </Link>
    </>
  );

  if (sentTo) {
    return (
      <AuthLayout title="Check your email" subtitle="A reset link is on its way." footer={footer}>
        <div className="flex items-start gap-3 text-sm text-slate-300">
          <MailCheck className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
          <div className="space-y-3">
            <p>
              If an account exists for <span className="font-medium text-slate-100">{sentTo}</span>, we have sent it a
              link to reset the password. The link works once and expires in 30 minutes.
            </p>
            <p className="text-slate-400">Not there after a few minutes? Check your spam folder, or try again.</p>
            <button
              type="button"
              onClick={() => setSentTo(null)}
              className="text-emerald-400 hover:text-emerald-300 font-medium cursor-pointer"
            >
              Send another link
            </button>
          </div>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Forgot your password?"
      subtitle="Enter your account email and we will send you a link to choose a new one."
      footer={footer}
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
          maxLength={255}
          required
        />
        <SubmitButton busy={busy}>Send reset link</SubmitButton>
      </form>
    </AuthLayout>
  );
};
