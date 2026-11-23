import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowUpRight,
  CreditCard,
  ExternalLink,
  FileDown,
  Loader2,
  Receipt,
  RotateCcw,
  Users,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { messageFor } from '../../lib/api';
import { formatDate } from '../../lib/datetime';
import { Button } from '../common/Button';
import { Panel } from '../common/Panel';
import { Pagination } from '../common/Pagination';
import {
  billingApi,
  formatMoney,
  planName,
  statusMeta,
  type InvoicePage,
  type PlanInfo,
  type PlansResponse,
  type SubscriptionInfo,
  type UsageInfo,
} from '../../utils/billingApi';
import { useBillingActions, useBillingData } from './useBilling';

const TONES = {
  good: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  warn: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  bad: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  neutral: 'bg-slate-800 text-slate-300 border-slate-700',
} as const;

const date = (value: string | null): string => (value ? formatDate(value) : '—');

export const StatusBadge: React.FC<{ subscription: SubscriptionInfo | null }> = ({ subscription }) => {
  const meta = statusMeta(subscription);
  return (
    <span data-testid="subscription-status" className={`text-2xs font-semibold px-2 py-0.5 rounded-full border ${TONES[meta.tone]}`}>
      {meta.label}
    </span>
  );
};

/** Current plan, status, interval, dates and what is about to change. */
export const SubscriptionSummary: React.FC<{
  subscription: SubscriptionInfo;
  catalog: PlansResponse | null;
  actions?: React.ReactNode;
}> = ({ subscription: sub, catalog, actions }) => {
  const meta = statusMeta(sub);
  const plan: PlanInfo | undefined = catalog?.plans.find((p) => p.key === sub.subscribedPlan);
  const price = plan?.prices && sub.billingInterval ? formatMoney(plan.prices[sub.billingInterval], catalog!.currency) : null;

  return (
    <Panel title="Subscription" icon={<CreditCard className="w-4 h-4" />} aside={<StatusBadge subscription={sub} />}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-xl font-bold text-white" data-testid="current-plan">{planName(catalog?.plans, sub.plan)}</span>
        {sub.hasSubscription && price && (
          <span className="text-xs text-slate-400">
            {price} / {sub.billingInterval === 'YEARLY' ? 'year' : 'month'}
          </span>
        )}
      </div>
      <p className="text-xs text-slate-400">{meta.description}</p>

      {sub.accessReason === 'past_due_grace' && sub.graceEndsAt && (
        <Notice tone="warn">Paid features stay on until {date(sub.graceEndsAt)} while the payment is retried.</Notice>
      )}
      {sub.plan !== sub.subscribedPlan && sub.status && sub.status !== 'canceled' && sub.status !== 'incomplete_expired' && (
        <Notice tone="bad">
          Your {planName(catalog?.plans, sub.subscribedPlan)} features are paused until the payment is completed.
        </Notice>
      )}
      {sub.pendingChange && (
        <Notice tone="neutral">
          Changes to {planName(catalog?.plans, sub.pendingChange.plan)}
          {sub.pendingChange.interval ? ` (${sub.pendingChange.interval.toLowerCase()})` : ''} on {date(sub.pendingChange.effectiveAt)}.
        </Notice>
      )}

      {sub.hasSubscription && (
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <Fact label="Billing">{sub.billingInterval === 'YEARLY' ? 'Yearly' : 'Monthly'}</Fact>
          <Fact label="Current period">
            {date(sub.currentPeriodStart)} – {date(sub.currentPeriodEnd)}
          </Fact>
          <Fact label={sub.cancelAtPeriodEnd ? 'Ends on' : 'Next billing date'}>{date(sub.currentPeriodEnd)}</Fact>
          {sub.trialEnd ? <Fact label="Trial ends">{date(sub.trialEnd)}</Fact> : <Fact label="Renews">{sub.renewsAt ? 'Automatically' : 'No'}</Fact>}
        </dl>
      )}
      {!sub.hasSubscription && sub.endedAt && <p className="text-xs text-slate-500">Previous subscription ended {date(sub.endedAt)}.</p>}

      {actions && <div className="flex flex-wrap gap-2 pt-1">{actions}</div>}
    </Panel>
  );
};

const Fact: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-3">
    <dt className="text-2xs text-slate-500">{label}</dt>
    <dd className="text-slate-200 font-medium mt-0.5">{children}</dd>
  </div>
);

const Notice: React.FC<{ tone: keyof typeof TONES; children: React.ReactNode }> = ({ tone, children }) => (
  <div className={`rounded-xl border p-3 text-xs flex items-start gap-2 ${TONES[tone]}`}>
    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden />
    <span>{children}</span>
  </div>
);

/** Members used against the plan's limit, and the plan's features. */
export const UsagePanel: React.FC<{ usage: UsageInfo; catalog: PlansResponse | null; onUpgrade?: () => void }> = ({ usage, catalog, onUpgrade }) => {
  const { used, limit, atLimit, overLimit } = usage.members;
  const percent = Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
  const bar = overLimit ? 'bg-rose-500' : atLimit ? 'bg-amber-500' : 'bg-emerald-500';
  const label = (key: string) => catalog?.features.find((f) => f.key === key)?.label ?? key;

  return (
    <Panel title="Usage & limits" icon={<Users className="w-4 h-4" />} aside={!usage.enforced ? 'Limits not enforced yet' : undefined}>
      <div>
        <div className="flex justify-between text-xs mb-1.5">
          <span className="text-slate-300">Team members</span>
          <span className="text-slate-200 tabular-nums" data-testid="member-usage">
            {used} of {limit}
          </span>
        </div>
        <div className="h-2 rounded-full bg-slate-800 overflow-hidden" role="progressbar" aria-valuenow={used} aria-valuemin={0} aria-valuemax={limit} aria-label="Team members used">
          <div className={`h-full ${bar}`} style={{ width: `${percent}%` }} />
        </div>
      </div>

      {usage.upgradeRecommendation && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs flex flex-wrap items-center justify-between gap-2" data-testid="upgrade-recommendation">
          <span className="text-emerald-200">
            {usage.upgradeRecommendation.reason} {planName(catalog?.plans, usage.upgradeRecommendation.plan)} fits your team.
          </span>
          {onUpgrade && (
            <Button size="sm" iconRight={<ArrowUpRight />} onClick={onUpgrade}>
              See plans
            </Button>
          )}
        </div>
      )}

      <div>
        <p className="text-2xs text-slate-500 mb-1.5">Included in {planName(catalog?.plans, usage.plan)}</p>
        <ul className="flex flex-wrap gap-1.5">
          {usage.features.map((f) => (
            <li key={f} className="text-2xs px-2 py-1 rounded-lg bg-slate-800 text-slate-300 border border-slate-700">
              {label(f)}
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
};

const INVOICE_TONE: Record<string, keyof typeof TONES> = { paid: 'good', open: 'warn', uncollectible: 'bad', void: 'neutral', draft: 'neutral' };

/** The billing history: number, date, amount, status, PDF and hosted page. */
export const InvoiceTable: React.FC<{ page: InvoicePage | null; loading: boolean; error: string | null }> = ({ page, loading, error }) => {
  if (error) return <p role="alert" className="text-xs text-rose-300">{error}</p>;
  if (loading && !page) {
    return (
      <p className="text-xs text-slate-400 flex items-center gap-2" role="status">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading invoices…
      </p>
    );
  }
  if (!page?.data.length) return <p className="text-xs text-slate-500">No invoices yet.</p>;
  return (
    <div className="overflow-x-auto -mx-1">
      <table className="w-full text-xs min-w-[34rem]">
        <thead>
          <tr className="text-left text-slate-500 border-b border-slate-800">
            <th className="font-semibold p-2">Invoice</th>
            <th className="font-semibold p-2">Date</th>
            <th className="font-semibold p-2 text-right">Amount</th>
            <th className="font-semibold p-2">Currency</th>
            <th className="font-semibold p-2">Status</th>
            <th className="font-semibold p-2 text-right">
              <span className="sr-only">Links</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {page.data.map((inv) => (
            <tr key={inv.id} className="border-b border-slate-800/60 last:border-0">
              <td className="p-2 text-slate-200 font-mono">{inv.number ?? '—'}</td>
              <td className="p-2 text-slate-300">{date(inv.issuedAt)}</td>
              <td className="p-2 text-right text-slate-200 tabular-nums">{formatMoney(inv.status === 'paid' ? inv.amountPaid : inv.amountDue, inv.currency)}</td>
              <td className="p-2 text-slate-400 uppercase">{inv.currency}</td>
              <td className="p-2">
                <span className={`text-2xs font-semibold px-2 py-0.5 rounded-full border capitalize ${TONES[INVOICE_TONE[inv.status] ?? 'neutral']}`}>{inv.status}</span>
              </td>
              <td className="p-2">
                <div className="flex justify-end gap-3">
                  {inv.invoicePdf && (
                    <a href={inv.invoicePdf} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-brand-400 hover:underline">
                      <FileDown className="w-3.5 h-3.5" /> PDF
                    </a>
                  )}
                  {inv.invoiceUrl && (
                    <a href={inv.invoiceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-brand-400 hover:underline">
                      <ExternalLink className="w-3.5 h-3.5" /> View
                    </a>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

/** Settings → Billing. */
export const BillingSettings: React.FC = () => {
  const navigate = useNavigate();
  const { can } = useAuth();
  const canManage = can('billing.manage');
  const { catalog, subscription, usage, loading, error, reload } = useBillingData();
  const actions = useBillingActions({ catalog, subscription, reload });

  const [invoices, setInvoices] = useState<InvoicePage | null>(null);
  const [invoicePage, setInvoicePage] = useState(1);
  const [invoiceSize, setInvoiceSize] = useState(10);
  const [invoicesLoading, setInvoicesLoading] = useState(true);
  const [invoicesError, setInvoicesError] = useState<string | null>(null);

  const loadInvoices = useCallback(async () => {
    setInvoicesLoading(true);
    try {
      setInvoices(await billingApi.invoices(invoicePage, invoiceSize));
      setInvoicesError(null);
    } catch (e) {
      setInvoicesError(messageFor(e));
    } finally {
      setInvoicesLoading(false);
    }
  }, [invoicePage, invoiceSize]);

  useEffect(() => {
    void loadInvoices();
  }, [loadInvoices]);

  if (loading && !subscription) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-400 py-10" role="status">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading billing…
      </div>
    );
  }
  if (error && !subscription) {
    return (
      <div role="alert" className="bg-rose-500/10 border border-rose-500/30 rounded-2xl p-5 text-sm text-rose-200 space-y-3">
        <p>{error}</p>
        <Button variant="secondary" size="sm" icon={<RotateCcw />} onClick={() => void reload()}>
          Try again
        </Button>
      </div>
    );
  }
  if (!subscription) return null;

  const toPlans = () => navigate('/pricing');
  const manageButtons = canManage ? (
    <>
      <Button size="sm" icon={<ArrowUpRight />} onClick={toPlans}>
        {subscription.hasSubscription ? 'Change plan' : 'Choose a plan'}
      </Button>
      {subscription.hasBillingAccount && (
        <Button variant="outline" size="sm" icon={<CreditCard />} loading={actions.busy === 'portal'} onClick={() => void actions.openPortal()}>
          Manage payment method
        </Button>
      )}
      {subscription.hasSubscription && subscription.cancelAtPeriodEnd && (
        <Button variant="secondary" size="sm" loading={actions.busy === 'reactivate'} onClick={() => void actions.reactivate()}>
          Keep my subscription
        </Button>
      )}
      {subscription.hasSubscription && !subscription.cancelAtPeriodEnd && (
        <Button variant="danger-soft" size="sm" loading={actions.busy === 'cancel'} onClick={() => void actions.cancel()}>
          Cancel subscription
        </Button>
      )}
    </>
  ) : undefined;

  return (
    <div className="grid grid-cols-1 gap-5">
      <SubscriptionSummary subscription={subscription} catalog={catalog} actions={manageButtons} />
      {usage && <UsagePanel usage={usage} catalog={catalog} onUpgrade={canManage ? toPlans : undefined} />}
      <Panel title="Payment history" icon={<Receipt className="w-4 h-4" />}>
        <InvoiceTable page={invoices} loading={invoicesLoading} error={invoicesError} />
        {invoices && invoices.meta.total > invoices.meta.limit && (
          <Pagination
            meta={invoices.meta}
            onPageChange={setInvoicePage}
            onPageSizeChange={(size) => {
              setInvoiceSize(size);
              setInvoicePage(1);
            }}
            itemLabel="invoices"
            disabled={invoicesLoading}
          />
        )}
      </Panel>
    </div>
  );
};
