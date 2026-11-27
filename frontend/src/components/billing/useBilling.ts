import { useCallback, useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { messageFor } from '../../lib/api';
import { confirmToast } from '../../lib/toast';
import { formatDate } from '../../lib/datetime';
import {
  billingApi,
  planName,
  startCheckout,
  type BillingInterval,
  type PaidPlanKey,
  type PlanAction,
  type PlanInfo,
  type PlansResponse,
  type SubscriptionInfo,
  type UsageInfo,
} from '../../utils/billingApi';

const STRIPE_URL = /^https:\/\/([a-z0-9-]+\.)*stripe\.com\//;

/** The plan catalog, the organization's subscription and usage, loaded together. */
export function useBillingData() {
  const [catalog, setCatalog] = useState<PlansResponse | null>(null);
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [plans, sub, use] = await Promise.all([billingApi.plans(), billingApi.subscription(), billingApi.usage()]);
      setCatalog(plans);
      setSubscription(sub);
      setUsage(use);
      setError(null);
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { catalog, subscription, usage, loading, error, reload };
}

/**
 * Every billing action, with the confirmations they need. Each one's result
 * comes from the server; after a change the caller reloads to show Stripe's
 * state rather than assuming it.
 */
export function useBillingActions(opts: { catalog: PlansResponse | null; subscription: SubscriptionInfo | null; reload: () => Promise<void> }) {
  const { catalog, subscription, reload } = opts;
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setBusy(null);
    }
  };

  const select = (plan: PlanInfo, action: PlanAction, interval: BillingInterval) =>
    run(plan.key, async () => {
      const name = planName(catalog?.plans, plan.key);
      if (action.kind === 'checkout') {
        // Leaves the app; the busy state stays on until the browser navigates.
        await startCheckout(plan.key as PaidPlanKey, interval);
        return;
      }
      if (action.kind === 'cancel_to_free') {
        await cancel();
        return;
      }
      if (action.kind === 'upgrade' || action.kind === 'downgrade') {
        const ok = await confirmToast(
          action.kind === 'upgrade'
            ? `Upgrade to ${name} (${interval.toLowerCase()}) now? The difference for the rest of this period is charged today.`
            : `Move to ${name} (${interval.toLowerCase()}) at the end of the current period? You keep your current plan until then.`,
          action.kind === 'upgrade' ? 'Upgrade' : 'Schedule downgrade',
        );
        if (!ok) return;
        const result = await billingApi.changePlan(plan.key as PaidPlanKey, interval);
        if (result.paymentRequired) {
          toast.warn('The upgrade needs your payment confirmed. Your plan changes once it is paid.');
          if (result.invoiceUrl && STRIPE_URL.test(result.invoiceUrl)) window.open(result.invoiceUrl, '_blank', 'noopener');
        } else if (result.change === 'downgrade') {
          toast.success(`${name} starts ${result.effectiveAt ? formatDate(result.effectiveAt) : 'at the end of this period'}.`);
        } else if (result.change === 'kept') {
          toast.success('The scheduled change was canceled. You stay on your current plan.');
        } else {
          toast.success(`You are now on ${name}.`);
        }
        await reload();
      }
    });

  const cancel = async () => {
    const until = subscription?.currentPeriodEnd ? formatDate(subscription.currentPeriodEnd) : 'the end of the period';
    const ok = await confirmToast(`Cancel your subscription? Paid features stay on until ${until}, then you move to Free.`, 'Cancel subscription');
    if (!ok) return;
    await billingApi.cancel(false);
    toast.success(`Canceled. Your plan stays active until ${until}.`);
    await reload();
  };

  return {
    busy,
    select,
    cancel: () => run('cancel', cancel),
    reactivate: () =>
      run('reactivate', async () => {
        await billingApi.reactivate();
        toast.success('Your subscription will renew as usual.');
        await reload();
      }),
    openPortal: () =>
      run('portal', async () => {
        const { url } = await billingApi.portal();
        if (!STRIPE_URL.test(url)) throw new Error('Unexpected billing portal address');
        window.location.assign(url);
      }),
  };
}
