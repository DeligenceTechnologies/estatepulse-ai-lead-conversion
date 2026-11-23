import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Clock, Loader2, XCircle } from 'lucide-react';
import { AuthLayout } from '../auth/AuthLayout';
import { Button } from '../common/Button';
import { billingApi, confirmedPaid, planName, pollUntil, type SubscriptionInfo } from '../../utils/billingApi';

type Phase = 'confirming' | 'confirmed' | 'pending' | 'failed';

/**
 * Where Stripe Checkout sends the customer back.
 *
 * The `session_id` in the URL proves nothing: it is only used to ask the
 * server, which asks Stripe. The page shows "confirming" until the server
 * reports a paid subscription (from Stripe's webhook, or its own read of the
 * session), and "still processing" if that takes longer than a minute —
 * never "paid" on the strength of the redirect alone.
 */
export const BillingSuccessPage: React.FC = () => {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const sessionId = params.get('session_id');
  const [phase, setPhase] = useState<Phase>('confirming');
  const [sub, setSub] = useState<SubscriptionInfo | null>(null);
  const [planLabel, setPlanLabel] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      const plans = await billingApi.plans().catch(() => null);
      const result = await pollUntil(
        async () => {
          // Lets the server sync from Stripe even before the webhook lands.
          if (sessionId && /^cs_(test|live)_\w+$/.test(sessionId)) await billingApi.checkoutStatus(sessionId).catch(() => null);
          return billingApi.subscription();
        },
        confirmedPaid,
        { attempts: 20, intervalMs: 3000 },
      );
      setSub(result.value);
      if (result.value) setPlanLabel(planName(plans?.plans, result.value.plan));
      setPhase(result.settled ? 'confirmed' : result.value ? 'pending' : 'failed');
    })();
  }, [sessionId]);

  const content: Record<Phase, { icon: React.ReactNode; title: string; body: string }> = {
    confirming: {
      icon: <Loader2 className="w-6 h-6 text-emerald-400 animate-spin" />,
      title: 'Confirming your payment…',
      body: 'We are waiting for Stripe to confirm the payment. This usually takes a few seconds.',
    },
    confirmed: {
      icon: <CheckCircle2 className="w-6 h-6 text-emerald-400" />,
      title: `You’re on ${planLabel ?? 'your new plan'}`,
      body: 'Your payment is confirmed and your plan’s features are now available.',
    },
    pending: {
      icon: <Clock className="w-6 h-6 text-amber-400" />,
      title: 'Payment still processing',
      body:
        sub?.status === 'incomplete'
          ? 'Your bank has not confirmed the payment yet. Your plan unlocks as soon as it does — check back from Billing settings.'
          : 'We have not received Stripe’s confirmation yet. Your plan unlocks automatically once it arrives; you do not need to pay again.',
    },
    failed: {
      icon: <XCircle className="w-6 h-6 text-rose-400" />,
      title: 'Could not check your payment',
      body: 'We could not reach the server to confirm your payment. If you were charged, your plan unlocks automatically. Please check Billing settings shortly.',
    },
  };
  const { icon, title, body } = content[phase];

  return (
    <AuthLayout title="Billing" subtitle="Subscription checkout" footer={null}>
      <div className="text-center space-y-3" role="status" aria-live="polite" data-phase={phase}>
        <div className="flex justify-center">{icon}</div>
        <h2 className="text-base font-bold text-white">{title}</h2>
        <p className="text-sm text-slate-400">{body}</p>
        <div className="flex justify-center gap-2 pt-2">
          <Button onClick={() => navigate('/settings?tab=billing')} disabled={phase === 'confirming'}>
            Go to billing
          </Button>
          <Button variant="secondary" onClick={() => navigate('/dashboard')}>
            Dashboard
          </Button>
        </div>
      </div>
    </AuthLayout>
  );
};

/** Stripe's cancel URL: the customer backed out; nothing was charged or changed. */
export const BillingCancelPage: React.FC = () => {
  const navigate = useNavigate();
  return (
    <AuthLayout title="Billing" subtitle="Subscription checkout" footer={null}>
      <div className="text-center space-y-3">
        <div className="flex justify-center">
          <XCircle className="w-6 h-6 text-slate-400" />
        </div>
        <h2 className="text-base font-bold text-white">Checkout canceled</h2>
        <p className="text-sm text-slate-400">No payment was taken and your plan has not changed.</p>
        <div className="flex justify-center gap-2 pt-2">
          <Button onClick={() => navigate('/pricing')}>Back to plans</Button>
          <Button variant="secondary" onClick={() => navigate('/dashboard')}>
            Dashboard
          </Button>
        </div>
      </div>
    </AuthLayout>
  );
};
