import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Settings2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { Button } from '../common/Button';
import { PricingPlans } from '../billing/PricingPlans';
import { useBillingActions, useBillingData } from '../billing/useBilling';
import type { BillingInterval } from '../../utils/billingApi';

/**
 * Plans & Pricing: compare the plans and subscribe, upgrade or downgrade.
 * Subscribing leaves for Stripe Checkout; the plan changes here only once the
 * server has Stripe's confirmation.
 */
export const PricingView: React.FC = () => {
  const navigate = useNavigate();
  const { can } = useAuth();
  const { catalog, subscription, loading, error, reload } = useBillingData();
  const actions = useBillingActions({ catalog, subscription, reload });
  const [interval, setBillingInterval] = useState<BillingInterval>('MONTHLY');

  // Open on the interval the organization already pays by.
  useEffect(() => {
    if (subscription?.billingInterval) setBillingInterval(subscription.billingInterval);
  }, [subscription?.billingInterval]);

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto text-slate-100">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight">Plans & Pricing</h2>
          <p className="text-xs text-slate-400">Pick the plan that fits your team. Change or cancel any time.</p>
        </div>
        <Button variant="outline" size="sm" icon={<Settings2 />} onClick={() => navigate('/settings?tab=billing')}>
          Billing settings
        </Button>
      </div>

      <PricingPlans
        catalog={catalog}
        subscription={subscription}
        interval={interval}
        onIntervalChange={setBillingInterval}
        onSelect={(plan, action) => void actions.select(plan, action, interval)}
        busyPlan={actions.busy}
        loading={loading}
        error={error}
        onRetry={() => void reload()}
        canManage={can('billing.manage')}
      />
    </div>
  );
};
