import { describe, expect, it } from 'vitest';
import type { AuditService } from '@/audit/audit.service';
import {
  asRepo,
  auth,
  fakeAudit,
  fakeRepo,
  fakeStripe,
  makeConfig,
  ORG_A,
  ORG_B,
  PRICES,
  stripePrice,
  stripeServiceWith,
  stripeSubscription,
} from '../billing-fakes.test';
import type { BillingEnv } from '../billing.config';
import { StripePriceService } from './stripe-price.service';
import { SubscriptionService } from './subscription.service';
import { SubscriptionSyncService } from './subscription-sync.service';

const LIVE = { orgId: ORG_A, stripeCustomerId: 'cus_a', stripeSubscriptionId: 'sub_1', stripePriceId: PRICES.PRO_MONTHLY, plan: 'PROFESSIONAL' as const, billingInterval: 'MONTHLY' as const, status: 'active' as const };

function setup(rows: Parameters<typeof fakeRepo>[0] = [LIVE], env: Partial<BillingEnv> = {}) {
  const repo = fakeRepo(rows);
  const stripe = fakeStripe();
  const config = makeConfig(env);
  const service = stripeServiceWith(stripe, config);
  stripe.prices.retrieve.mockImplementation(async (id: string) => {
    if (id === PRICES.PRO_YEARLY) return stripePrice(id, 2_999_900, 'year');
    if (id === PRICES.STARTER_MONTHLY) return stripePrice(id, 99_900, 'month');
    if (id === PRICES.BUSINESS_MONTHLY) return stripePrice(id, 599_900, 'month');
    return stripePrice(id, 299_900, 'month');
  });
  stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscription());
  const audit = fakeAudit();
  const sync = new SubscriptionSyncService(asRepo(repo), config, service, audit as unknown as AuditService);
  const subs = new SubscriptionService(config, service, new StripePriceService(config, service), asRepo(repo), sync, audit as unknown as AuditService);
  return { repo, stripe, subs, audit };
}

const code = (e: unknown) => (e as { getResponse(): { error: { code: string } } }).getResponse().error.code;
async function rejection(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

describe('cancel', () => {
  it('cancels at the period end by default and keeps the plan until then', async () => {
    const { subs, stripe, repo } = setup();
    stripe.subscriptions.update.mockResolvedValue(stripeSubscription({ cancel_at_period_end: true }));
    const result = await subs.cancel(auth(), false);
    expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_1', { cancel_at_period_end: true });
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(result.cancelAtPeriodEnd).toBe(true);
    expect(repo.subs[0]).toMatchObject({ plan: 'PROFESSIONAL', status: 'active', cancelAtPeriodEnd: true });
  });

  it('refuses an immediate cancel unless the server allows it', async () => {
    const { subs, stripe } = setup();
    expect(code(await rejection(subs.cancel(auth(), true)))).toBe('IMMEDIATE_CANCEL_DISABLED');
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
  });

  it('cancels at once when allowed, and keeps the history', async () => {
    const { subs, stripe, repo } = setup([LIVE], { BILLING_ALLOW_IMMEDIATE_CANCEL: true });
    stripe.subscriptions.cancel.mockResolvedValue(stripeSubscription({ status: 'canceled' }));
    await subs.cancel(auth(), true);
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith('sub_1', { prorate: false, invoice_now: false });
    expect(repo.subs[0]).toMatchObject({ status: 'canceled', stripeSubscriptionId: 'sub_1', stripeCustomerId: 'cus_a' });
  });

  it('has nothing to cancel without a live subscription, and never touches another organization', async () => {
    const { subs, stripe } = setup([LIVE, { orgId: ORG_B, id: 'row-b' }]);
    expect(code(await rejection(subs.cancel(auth(ORG_B), false)))).toBe('NO_ACTIVE_SUBSCRIPTION');
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });
});

describe('reactivate', () => {
  it('undoes a scheduled cancellation', async () => {
    const { subs, stripe, repo } = setup([{ ...LIVE, cancelAtPeriodEnd: true }]);
    stripe.subscriptions.update.mockResolvedValue(stripeSubscription());
    await subs.reactivate(auth());
    expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_1', { cancel_at_period_end: false, cancel_at: '' });
    expect(repo.subs[0].cancelAtPeriodEnd).toBe(false);
  });

  it('refuses when nothing is set to cancel', async () => {
    const { subs } = setup();
    expect(code(await rejection(subs.reactivate(auth())))).toBe('SUBSCRIPTION_NOT_CANCELING');
  });
});

describe('changePlan', () => {
  it('upgrades now, prorated, and only once the payment succeeds', async () => {
    const { subs, stripe, repo } = setup([{ ...LIVE, plan: 'STARTER', stripePriceId: PRICES.STARTER_MONTHLY }]);
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ price: PRICES.STARTER_MONTHLY }));
    stripe.subscriptions.update.mockResolvedValue(stripeSubscription({ price: PRICES.BUSINESS_MONTHLY }));

    const result = await subs.changePlan(auth(), 'BUSINESS', 'MONTHLY');

    const [id, params] = stripe.subscriptions.update.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(id).toBe('sub_1');
    expect(params).toMatchObject({
      items: [{ id: 'si_1', price: PRICES.BUSINESS_MONTHLY, quantity: 1 }],
      proration_behavior: 'always_invoice',
      payment_behavior: 'pending_if_incomplete',
    });
    expect(result).toMatchObject({ change: 'upgrade', paymentRequired: false });
    expect(repo.subs[0].plan).toBe('BUSINESS');
  });

  it('keeps the old plan when the upgrade’s payment needs the customer', async () => {
    const { subs, stripe, repo } = setup([{ ...LIVE, plan: 'STARTER', stripePriceId: PRICES.STARTER_MONTHLY }]);
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ price: PRICES.STARTER_MONTHLY }));
    // pending_if_incomplete: Stripe leaves the item on the old price until the invoice is paid.
    stripe.subscriptions.update.mockResolvedValue({
      ...stripeSubscription({ price: PRICES.STARTER_MONTHLY, pending_update: { subscription_items: [] } }),
      latest_invoice: { hosted_invoice_url: 'https://invoice.stripe.com/i/pay-me' },
    });
    const result = await subs.changePlan(auth(), 'BUSINESS', 'MONTHLY');
    expect(result).toEqual({ change: 'upgrade', effectiveAt: null, paymentRequired: true, invoiceUrl: 'https://invoice.stripe.com/i/pay-me' });
    expect(repo.subs[0].plan).toBe('STARTER');
  });

  it('books a downgrade for the period end with a schedule, and changes nothing now', async () => {
    const { subs, stripe, repo } = setup();
    const result = await subs.changePlan(auth(), 'STARTER', 'MONTHLY');

    expect(stripe.subscriptionSchedules.create.mock.calls[0][0]).toEqual({ from_subscription: 'sub_1' });
    const [, update] = stripe.subscriptionSchedules.update.mock.calls[0] as unknown as [string, { phases: Array<Record<string, any>>; end_behavior: string }];
    expect(update.end_behavior).toBe('release');
    expect(update.phases[0].items).toEqual([{ price: PRICES.PRO_MONTHLY, quantity: 1 }]);
    expect(update.phases[1]).toMatchObject({ items: [{ price: PRICES.STARTER_MONTHLY, quantity: 1 }], proration_behavior: 'none' });
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(result.change).toBe('downgrade');
    expect(repo.subs[0]).toMatchObject({ plan: 'PROFESSIONAL', pendingPlan: 'STARTER', pendingInterval: 'MONTHLY', stripeScheduleId: 'sub_sched_1' });
  });

  it('choosing the current plan again drops a booked downgrade', async () => {
    const { subs, stripe, repo } = setup([{ ...LIVE, pendingPlan: 'STARTER', pendingInterval: 'MONTHLY', stripeScheduleId: 'sub_sched_1' }]);
    const result = await subs.changePlan(auth(), 'PROFESSIONAL', 'MONTHLY');
    expect(result.change).toBe('kept');
    expect(stripe.subscriptionSchedules.release).toHaveBeenCalledWith('sub_sched_1');
    expect(repo.subs[0]).toMatchObject({ pendingPlan: null, stripeScheduleId: null });
  });

  it('refuses the plan already on, and plan changes while a payment is failing', async () => {
    expect(code(await rejection(setup().subs.changePlan(auth(), 'PROFESSIONAL', 'MONTHLY')))).toBe('ALREADY_ON_PLAN');
    const pastDue = setup([{ ...LIVE, status: 'past_due' }]);
    expect(code(await rejection(pastDue.subs.changePlan(auth(), 'BUSINESS', 'MONTHLY')))).toBe('SUBSCRIPTION_PAYMENT_ISSUE');
    expect(pastDue.stripe.subscriptions.update).not.toHaveBeenCalled();
  });
});
