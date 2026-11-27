import { ApiError, apiFetch } from '../lib/api';

/**
 * The backend's /billing API. The browser only ever chooses a plan and an
 * interval: prices shown here are the server's catalog, the amount charged is
 * Stripe's, and a subscription counts as paid only when the server says so
 * (after Stripe's webhook, or the server's own read of Stripe) — never because
 * the success page opened.
 */

export type PlanKey = 'FREE' | 'STARTER' | 'PROFESSIONAL' | 'BUSINESS';
export type PaidPlanKey = Exclude<PlanKey, 'FREE'>;
export type BillingInterval = 'MONTHLY' | 'YEARLY';
export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'unpaid'
  | 'canceled'
  | 'incomplete'
  | 'incomplete_expired'
  | 'paused';

export type AccessReason =
  | 'free_plan'
  | 'paid'
  | 'trial'
  | 'past_due_grace'
  | 'past_due_expired'
  | 'unpaid'
  | 'canceled'
  | 'incomplete'
  | 'paused';

export interface PlanInfo {
  key: PlanKey;
  name: string;
  description: string;
  recommended: boolean;
  /** Minor units (paise) per interval; null for Free. */
  prices: Record<BillingInterval, number> | null;
  /** Whether the server has a Stripe Price for it — false means "not available yet". */
  checkoutAvailable: Record<BillingInterval, boolean>;
  features: string[];
  limits: { maxMembers: number };
}

export interface PlansResponse {
  currency: string;
  mode: 'test' | 'live';
  checkoutConfigured: boolean;
  features: { key: string; label: string }[];
  plans: PlanInfo[];
}

export interface SubscriptionInfo {
  /** The plan whose features apply now. */
  plan: PlanKey;
  subscribedPlan: PlanKey;
  accessReason: AccessReason;
  graceEndsAt: string | null;
  status: SubscriptionStatus | null;
  hasSubscription: boolean;
  hasBillingAccount: boolean;
  billingInterval: BillingInterval | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  renewsAt: string | null;
  trialEnd: string | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
  endedAt: string | null;
  pendingChange: { plan: PlanKey; interval: BillingInterval | null; effectiveAt: string | null } | null;
  checkoutPending: boolean;
  features: string[];
  limits: { maxMembers: number };
  enforced: boolean;
  mode: 'test' | 'live';
  immediateCancelAllowed: boolean;
  lastSyncedAt: string | null;
}

export interface UsageInfo {
  plan: PlanKey;
  enforced: boolean;
  members: { used: number; limit: number; atLimit: boolean; overLimit: boolean };
  features: string[];
  upgradeRecommendation: { plan: PlanKey; reason: string } | null;
}

export interface InvoiceRow {
  id: string;
  stripeInvoiceId: string;
  number: string | null;
  amountDue: number;
  amountPaid: number;
  currency: string;
  status: string;
  invoiceUrl: string | null;
  invoicePdf: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  dueDate: string | null;
  paidAt: string | null;
  issuedAt: string;
}

export interface InvoicePage {
  data: InvoiceRow[];
  meta: { page: number; limit: number; count: number; total: number; totalPages: number; hasNextPage: boolean; hasPrevPage: boolean };
}

export interface PlanChangeResult {
  change: 'upgrade' | 'downgrade' | 'kept';
  effectiveAt: string | null;
  paymentRequired: boolean;
  invoiceUrl: string | null;
}

export type CheckoutState = 'open' | 'complete' | 'expired';

// --- Calls ------------------------------------------------------------------

export const billingApi = {
  plans: () => apiFetch<PlansResponse>('/billing/plans'),
  subscription: () => apiFetch<SubscriptionInfo>('/billing/subscription', { auth: true }),
  usage: () => apiFetch<UsageInfo>('/billing/usage', { auth: true }),
  invoices: (page = 1, limit = 10) => apiFetch<InvoicePage>(`/billing/invoices?page=${page}&limit=${limit}`, { auth: true }),
  checkout: (plan: PaidPlanKey, interval: BillingInterval) =>
    apiFetch<{ url: string; sessionId: string; reused: boolean }>('/billing/checkout', { method: 'POST', body: { plan, interval }, auth: true }),
  checkoutStatus: (sessionId: string) =>
    apiFetch<{ status: CheckoutState; paymentStatus: string }>(`/billing/checkout/${encodeURIComponent(sessionId)}`, { auth: true }),
  portal: () => apiFetch<{ url: string }>('/billing/portal', { method: 'POST', auth: true }),
  changePlan: (plan: PaidPlanKey, interval: BillingInterval) =>
    apiFetch<PlanChangeResult>('/billing/change-plan', { method: 'POST', body: { plan, interval }, auth: true }),
  cancel: (immediately = false) =>
    apiFetch<{ cancelAtPeriodEnd: boolean; endsAt: string | null }>('/billing/cancel', { method: 'POST', body: { immediately }, auth: true }),
  reactivate: () => apiFetch<{ reactivated: true }>('/billing/reactivate', { method: 'POST', auth: true }),
};

// --- Pure helpers (tested in billingApi.spec.ts) -----------------------------

export const PLAN_ORDER: readonly PlanKey[] = ['FREE', 'STARTER', 'PROFESSIONAL', 'BUSINESS'];

/** ₹2,999 — minor units to a display string. Whole rupees drop the decimals. */
export function formatMoney(minor: number, currency: string): string {
  const major = minor / 100;
  const code = currency.toUpperCase();
  try {
    return new Intl.NumberFormat(code === 'INR' ? 'en-IN' : undefined, {
      style: 'currency',
      currency: code,
      minimumFractionDigits: Number.isInteger(major) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(major);
  } catch {
    return `${code} ${major.toFixed(2)}`;
  }
}

/** Yearly price against twelve monthly ones, as a whole percentage (0 when none). */
export function yearlySavingsPercent(prices: Record<BillingInterval, number> | null): number {
  if (!prices || prices.MONTHLY <= 0) return 0;
  return Math.max(0, Math.round((1 - prices.YEARLY / (prices.MONTHLY * 12)) * 100));
}

export type PlanAction =
  | { kind: 'current'; label: string }
  | { kind: 'checkout'; label: string }
  | { kind: 'upgrade'; label: string }
  | { kind: 'downgrade'; label: string }
  | { kind: 'cancel_to_free'; label: string }
  | { kind: 'unavailable'; label: string };

/**
 * What a plan card's button does for this organization:
 *  - no live subscription → Subscribe (Stripe Checkout)
 *  - live subscription    → Upgrade now / Downgrade at period end (change-plan)
 *  - the Free card        → Cancel (ends at period end) when subscribed
 */
export function planAction(
  target: Pick<PlanInfo, 'key' | 'checkoutAvailable'>,
  interval: BillingInterval,
  sub: Pick<SubscriptionInfo, 'plan' | 'hasSubscription' | 'billingInterval' | 'cancelAtPeriodEnd'> | null,
): PlanAction {
  const current = sub?.plan ?? 'FREE';
  const subscribed = !!sub?.hasSubscription;

  if (target.key === 'FREE') {
    if (!subscribed) return { kind: 'current', label: 'Current plan' };
    return sub!.cancelAtPeriodEnd ? { kind: 'current', label: 'From period end' } : { kind: 'cancel_to_free', label: 'Downgrade to Free' };
  }
  if (subscribed && current === target.key && sub!.billingInterval === interval) {
    return { kind: 'current', label: 'Current plan' };
  }
  if (!target.checkoutAvailable[interval]) return { kind: 'unavailable', label: 'Not available yet' };
  if (!subscribed) return { kind: 'checkout', label: current === target.key ? 'Resubscribe' : 'Subscribe' };

  const rank = PLAN_ORDER.indexOf(target.key) - PLAN_ORDER.indexOf(current);
  const up = rank > 0 || (rank === 0 && interval === 'YEARLY');
  return up ? { kind: 'upgrade', label: 'Upgrade' } : { kind: 'downgrade', label: 'Downgrade' };
}

export interface StatusMeta {
  label: string;
  tone: 'good' | 'warn' | 'bad' | 'neutral';
  description: string;
}

export function statusMeta(sub: Pick<SubscriptionInfo, 'status' | 'accessReason' | 'cancelAtPeriodEnd' | 'graceEndsAt'> | null): StatusMeta {
  if (!sub?.status) return { label: 'Free', tone: 'neutral', description: 'You are on the free plan.' };
  switch (sub.status) {
    case 'active':
      return sub.cancelAtPeriodEnd
        ? { label: 'Cancels at period end', tone: 'warn', description: 'Your plan stays on until the end of the period you paid for.' }
        : { label: 'Active', tone: 'good', description: 'Your subscription is active.' };
    case 'trialing':
      return { label: 'Trial', tone: 'good', description: 'You are on a free trial.' };
    case 'past_due':
      return sub.accessReason === 'past_due_grace'
        ? { label: 'Payment failed', tone: 'warn', description: 'Your last payment failed. Update your payment method to keep your plan.' }
        : { label: 'Payment failed', tone: 'bad', description: 'Your last payment failed and paid features are paused until it is paid.' };
    case 'unpaid':
      return { label: 'Unpaid', tone: 'bad', description: 'Payments failed repeatedly. Paid features are paused.' };
    case 'incomplete':
      return { label: 'Payment pending', tone: 'warn', description: 'The first payment has not completed yet. Paid features unlock once it does.' };
    case 'incomplete_expired':
      return { label: 'Expired', tone: 'neutral', description: 'The first payment was never completed.' };
    case 'paused':
      return { label: 'Paused', tone: 'warn', description: 'Your subscription is paused.' };
    case 'canceled':
      return { label: 'Canceled', tone: 'neutral', description: 'Your subscription has ended. You are on the free plan.' };
  }
}

export const planName = (plans: PlanInfo[] | undefined, key: PlanKey): string =>
  plans?.find((p) => p.key === key)?.name ?? key.charAt(0) + key.slice(1).toLowerCase();

/** Errors the backend raises for plan limits (403 PLAN_*); the UI turns them into an upgrade prompt. */
export const isPlanRestriction = (err: unknown): boolean =>
  err instanceof ApiError && (err.code === 'PLAN_LIMIT_REACHED' || err.code === 'PLAN_UPGRADE_REQUIRED');

/**
 * The success page's answer: has the server confirmed a paid subscription?
 * Only a live subscription on a paid plan counts — not the checkout's
 * `session_id` in the URL, and not an incomplete first payment.
 */
export function confirmedPaid(sub: Pick<SubscriptionInfo, 'hasSubscription' | 'plan' | 'status'> | null): boolean {
  return !!sub && sub.hasSubscription && sub.plan !== 'FREE' && (sub.status === 'active' || sub.status === 'trialing');
}

/**
 * Polls until `done` says yes, or gives up after `attempts`. Resolves with
 * the last value, so the caller can show "still processing" if it never settled.
 */
export async function pollUntil<T>(
  load: () => Promise<T>,
  done: (value: T) => boolean,
  { attempts = 15, intervalMs = 2000, wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) } = {},
): Promise<{ value: T | null; settled: boolean }> {
  let last: T | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      last = await load();
      if (done(last)) return { value: last, settled: true };
    } catch {
      /* a failed poll is retried like an unsettled one */
    }
    if (i < attempts - 1) await wait(intervalMs);
  }
  return { value: last, settled: false };
}

/** Sends the browser to Stripe; split out so a test can see where it would go. */
export async function startCheckout(
  plan: PaidPlanKey,
  interval: BillingInterval,
  deps: { checkout?: typeof billingApi.checkout; redirect?: (url: string) => void } = {},
): Promise<string> {
  const { url } = await (deps.checkout ?? billingApi.checkout)(plan, interval);
  // Only ever Stripe's own hosted page.
  if (!/^https:\/\/([a-z0-9-]+\.)*stripe\.com\//.test(url)) throw new Error('Unexpected checkout address');
  (deps.redirect ?? ((u) => window.location.assign(u)))(url);
  return url;
}
