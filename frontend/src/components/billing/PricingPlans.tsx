import React from 'react';
import { AlertTriangle, Check, Loader2, Minus, RotateCcw, Sparkles } from 'lucide-react';
import { Button } from '../common/Button';
import {
  formatMoney,
  planAction,
  yearlySavingsPercent,
  type BillingInterval,
  type PlanAction,
  type PlanInfo,
  type PlansResponse,
  type SubscriptionInfo,
} from '../../utils/billingApi';

export interface PricingPlansProps {
  catalog: PlansResponse | null;
  subscription: SubscriptionInfo | null;
  interval: BillingInterval;
  onIntervalChange: (interval: BillingInterval) => void;
  onSelect: (plan: PlanInfo, action: PlanAction) => void;
  /** The plan whose button is working (redirecting to Stripe, changing plan). */
  busyPlan?: string | null;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** Read-only viewers (billing.read without billing.manage) see the plans without buttons. */
  canManage?: boolean;
}

/**
 * The plan cards, the monthly/yearly toggle and the full comparison. Purely
 * presentational: every decision about what a button does comes from
 * planAction(), and every click goes to `onSelect`.
 */
export const PricingPlans: React.FC<PricingPlansProps> = ({
  catalog,
  subscription,
  interval,
  onIntervalChange,
  onSelect,
  busyPlan = null,
  loading = false,
  error = null,
  onRetry,
  canManage = true,
}) => {
  if (loading && !catalog) {
    return (
      <div className="flex items-center justify-center gap-2 py-20 text-sm text-slate-400" role="status">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading plans…
      </div>
    );
  }
  if (error && !catalog) {
    return (
      <div role="alert" className="bg-rose-500/10 border border-rose-500/30 rounded-2xl p-6 text-center space-y-3">
        <AlertTriangle className="w-5 h-5 text-rose-400 mx-auto" />
        <p className="text-sm text-rose-200">{error}</p>
        {onRetry && (
          <Button variant="secondary" size="sm" icon={<RotateCcw />} onClick={onRetry}>
            Try again
          </Button>
        )}
      </div>
    );
  }
  if (!catalog) return null;

  const bestSaving = Math.max(...catalog.plans.map((p) => yearlySavingsPercent(p.prices)));

  return (
    <div className="space-y-8">
      {error && (
        <div role="alert" className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 flex items-start gap-2 text-xs">
          <AlertTriangle className="w-3.5 h-3.5 text-rose-400 mt-0.5 shrink-0" />
          <span className="text-rose-200">{error}</span>
        </div>
      )}

      {!catalog.checkoutConfigured && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 text-xs text-amber-200" data-testid="checkout-not-configured">
          Online payment is not set up on this server yet, so paid plans cannot be bought here. You can still compare them.
        </div>
      )}

      <div className="flex justify-center">
        <div role="radiogroup" aria-label="Billing interval" className="inline-flex p-1 rounded-xl bg-slate-900 border border-slate-800">
          {(['MONTHLY', 'YEARLY'] as const).map((value) => {
            const active = value === interval;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onIntervalChange(value)}
                className={`px-4 h-8 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                  active ? 'bg-emerald-500/15 text-emerald-200 border border-emerald-500/30' : 'text-slate-400 border border-transparent hover:text-slate-200'
                }`}
              >
                {value === 'MONTHLY' ? 'Monthly' : 'Yearly'}
                {value === 'YEARLY' && bestSaving > 0 && <span className="ml-1.5 text-2xs text-emerald-400">save up to {bestSaving}%</span>}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {catalog.plans.map((plan) => (
          <PlanCard
            key={plan.key}
            plan={plan}
            currency={catalog.currency}
            interval={interval}
            action={planAction(plan, interval, subscription)}
            isCurrent={(subscription?.plan ?? 'FREE') === plan.key}
            busy={busyPlan === plan.key}
            disabled={!!busyPlan && busyPlan !== plan.key}
            canManage={canManage}
            featureLabel={(key) => catalog.features.find((f) => f.key === key)?.label ?? key}
            onSelect={onSelect}
          />
        ))}
      </div>

      <FeatureComparison catalog={catalog} />

      {catalog.mode === 'test' && (
        <p className="text-center text-2xs text-slate-500">
          Test mode: prices are demo values and no real card is charged. Use Stripe’s test card 4242 4242 4242 4242.
        </p>
      )}
    </div>
  );
};

const PlanCard: React.FC<{
  plan: PlanInfo;
  currency: string;
  interval: BillingInterval;
  action: PlanAction;
  isCurrent: boolean;
  busy: boolean;
  disabled: boolean;
  canManage: boolean;
  featureLabel: (key: string) => string;
  onSelect: (plan: PlanInfo, action: PlanAction) => void;
}> = ({ plan, currency, interval, action, isCurrent, busy, disabled, canManage, featureLabel, onSelect }) => {
  const price = plan.prices ? plan.prices[interval] : 0;
  const saving = interval === 'YEARLY' ? yearlySavingsPercent(plan.prices) : 0;
  const actionable = action.kind !== 'current' && action.kind !== 'unavailable';

  return (
    <section
      aria-label={`${plan.name} plan`}
      data-plan={plan.key}
      className={`relative flex flex-col rounded-2xl border p-5 bg-slate-900/90 shadow-xl ${
        plan.recommended ? 'border-emerald-500/50 ring-1 ring-emerald-500/20' : isCurrent ? 'border-sky-500/40' : 'border-slate-800'
      }`}
    >
      <div className="flex items-center gap-2 min-h-5">
        <h3 className="text-sm font-bold text-white">{plan.name}</h3>
        {plan.recommended && (
          <span className="inline-flex items-center gap-1 text-2xs font-semibold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
            <Sparkles className="w-3 h-3" /> Recommended
          </span>
        )}
        {isCurrent && (
          <span className="text-2xs font-semibold px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-300 border border-sky-500/30" data-testid="current-plan-badge">
            Your plan
          </span>
        )}
      </div>
      <p className="text-xs text-slate-400 mt-1 min-h-8">{plan.description}</p>

      <div className="mt-4">
        <span className="text-2xl font-bold text-white tabular-nums">{formatMoney(price, currency)}</span>
        <span className="text-xs text-slate-500"> / {interval === 'YEARLY' ? 'year' : 'month'}</span>
        {saving > 0 && <p className="text-2xs text-emerald-400 mt-0.5">{saving}% less than monthly</p>}
      </div>

      <p className="text-xs text-slate-300 mt-3">
        Up to <strong className="text-white">{plan.limits.maxMembers}</strong> team member{plan.limits.maxMembers === 1 ? '' : 's'}
      </p>

      <ul className="mt-3 space-y-1.5 text-xs text-slate-300 flex-1">
        {plan.features.map((feature) => (
          <li key={feature} className="flex items-start gap-2">
            <Check className="w-3.5 h-3.5 text-emerald-400 mt-0.5 shrink-0" aria-hidden />
            {featureLabel(feature)}
          </li>
        ))}
      </ul>

      {canManage && (
        <Button
          className="mt-5"
          fullWidth
          variant={actionable && (action.kind === 'checkout' || action.kind === 'upgrade') ? 'primary' : 'outline'}
          disabled={!actionable || disabled}
          loading={busy}
          onClick={() => onSelect(plan, action)}
          data-action={action.kind}
        >
          {action.label}
        </Button>
      )}
    </section>
  );
};

/** Every feature against every plan. */
export const FeatureComparison: React.FC<{ catalog: PlansResponse }> = ({ catalog }) => (
  <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-x-auto">
    <table className="w-full text-xs min-w-[36rem]">
      <caption className="sr-only">Feature comparison</caption>
      <thead>
        <tr className="border-b border-slate-800">
          <th scope="col" className="text-left font-semibold text-slate-400 p-3">Feature</th>
          {catalog.plans.map((p) => (
            <th key={p.key} scope="col" className="font-semibold text-slate-200 p-3 text-center">
              {p.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        <tr className="border-b border-slate-800/60">
          <th scope="row" className="text-left font-normal text-slate-300 p-3">Team members</th>
          {catalog.plans.map((p) => (
            <td key={p.key} className="text-center p-3 text-slate-200 tabular-nums">{p.limits.maxMembers}</td>
          ))}
        </tr>
        {catalog.features.map((feature) => (
          <tr key={feature.key} className="border-b border-slate-800/60 last:border-0">
            <th scope="row" className="text-left font-normal text-slate-300 p-3">{feature.label}</th>
            {catalog.plans.map((p) => (
              <td key={p.key} className="text-center p-3">
                {p.features.includes(feature.key) ? (
                  <Check className="w-4 h-4 text-emerald-400 inline" aria-label="Included" />
                ) : (
                  <Minus className="w-4 h-4 text-slate-600 inline" aria-label="Not included" />
                )}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);
