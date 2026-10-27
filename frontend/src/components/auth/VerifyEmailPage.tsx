import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { messageFor } from '../../lib/api';
import { AuthLayout, FormError } from './AuthLayout';

/**
 * Where the verification email lands. The token is read once and dropped from
 * the address bar; a successful check signs the owner in and opens the app.
 */
export const VerifyEmailPage: React.FC = () => {
  const { verifyEmail } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [token] = useState(() => params.get('token') ?? '');
  const [error, setError] = useState<string | null>(null);
  // The link is single use: StrictMode's second effect run must not spend it again.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    navigate('/verify-email', { replace: true });
    if (!token) {
      setError('This verification link is incomplete. Open it again from the email.');
      return;
    }
    verifyEmail(token)
      .then(() => navigate('/', { replace: true }))
      .catch((err) => setError(messageFor(err)));
    // Runs once: the token is captured on first render and the URL is then cleared.
  }, []);

  if (!error) {
    return (
      <AuthLayout title="Confirming your email" subtitle="This takes a moment." footer={null}>
        <div className="flex justify-center py-6" aria-busy="true">
          <Loader2 className="w-6 h-6 text-emerald-400 animate-spin" />
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Link not valid"
      subtitle="This confirmation link cannot be used."
      footer={
        <Link to="/login" className="text-emerald-400 hover:text-emerald-300 font-medium">
          Back to sign in
        </Link>
      }
    >
      <FormError message={error} />
      <p className="text-sm text-slate-400">
        Links work once and expire after 24 hours. If you already confirmed, just sign in.{' '}
        <Link to="/check-email" className="text-emerald-400 hover:text-emerald-300 font-medium">
          Send a new link
        </Link>
      </p>
    </AuthLayout>
  );
};
