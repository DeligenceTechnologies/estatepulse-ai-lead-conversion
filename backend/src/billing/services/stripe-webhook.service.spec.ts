import { beforeEach, describe, expect, it } from 'vitest';
import type { AuditService } from '@/audit/audit.service';
import {
  asRepo,
  fakeAudit,
  fakeRepo,
  fakeStripe,
  makeConfig,
  ORG_A,
  ORG_B,
  PRICES,
  signedDelivery,
  stripeInvoice,
  stripeServiceWith,
  stripeSubscription,
  type FakeRepo,
  type FakeStripe,
} from '../billing-fakes.test';
import { StripeWebhookService } from './stripe-webhook.service';
import { SubscriptionSyncService } from './subscription-sync.service';

/**
 * The webhook, from signed bytes to stored state. Stripe answers are stubbed;
 * signatures are real (the SDK's own HMAC), so a forged delivery is exactly
 * what Stripe's verification would reject.
 */
function setup(repo: FakeRepo) {
  const stripe = fakeStripe();
  const config = makeConfig();
  const service = stripeServiceWith(stripe, config);
  const audit = fakeAudit();
  const sync = new SubscriptionSyncService(asRepo(repo), config, service, audit as unknown as AuditService);
  const webhooks = new StripeWebhookService(config, service, asRepo(repo), sync);
  const deliver = (event: Record<string, unknown>) => {
    const { rawBody, signature } = signedDelivery(stripe, event);
    return webhooks.receive(rawBody, signature);
  };
  return { stripe, repo, webhooks, deliver, audit };
}

const subscriptionEvent = (id: string, type: string, sub: Record<string, unknown>, created = Math.floor(Date.now() / 1000)) => ({
  id,
  type,
  created,
  data: { object: { object: 'subscription', ...sub } },
});

const invoiceEvent = (id: string, type: string, invoice: Record<string, unknown> = {}) => ({
  id,
  type,
  data: { object: { object: 'invoice', id: 'in_1', customer: 'cus_a', ...invoice } },
});

describe('POST /billing/webhook', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup(fakeRepo([{ orgId: ORG_A, stripeCustomerId: 'cus_a', checkoutSessionId: 'cs_test_1' }]));
  });

  it('rejects a missing or forged signature without storing anything', async () => {
    const { webhooks, stripe, repo } = ctx;
    const forged = signedDelivery(stripe, { id: 'evt_forged', type: 'customer.subscription.updated', data: { object: {} } }, 'whsec_wrong');
    await expect(webhooks.receive(forged.rawBody, forged.signature)).resolves.toEqual({ kind: 'invalid_signature' });
    await expect(webhooks.receive(forged.rawBody, undefined)).resolves.toEqual({ kind: 'invalid_signature' });
    expect(repo.events).toHaveLength(0);
    expect(repo.subs[0].plan).toBe('FREE');
  });

  it('activates the plan on checkout.session.completed from Stripe’s current subscription', async () => {
    ctx.stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_1', price: PRICES.PRO_MONTHLY }));
    const result = await ctx.deliver({
      id: 'evt_checkout',
      type: 'checkout.session.completed',
      data: { object: { object: 'checkout.session', id: 'cs_test_1', mode: 'subscription', customer: 'cus_a', subscription: 'sub_1', client_reference_id: ORG_A, metadata: { organizationId: ORG_A } } },
    });
    expect(result).toEqual({ kind: 'processed', eventId: 'evt_checkout' });
    expect(ctx.repo.subs[0]).toMatchObject({
      plan: 'PROFESSIONAL',
      billingInterval: 'MONTHLY',
      status: 'active',
      stripeSubscriptionId: 'sub_1',
      stripePriceId: PRICES.PRO_MONTHLY,
      checkoutSessionId: null,
    });
    expect(ctx.repo.events[0]).toMatchObject({ processingStatus: 'processed', orgId: ORG_A, attempts: 1 });
  });

  it('processes a redelivered event once', async () => {
    ctx.stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscription());
    const event = subscriptionEvent('evt_dup', 'customer.subscription.created', { id: 'sub_1', customer: 'cus_a' });
    await ctx.deliver(event);
    const second = await ctx.deliver(event);
    const third = await ctx.deliver(event);
    expect(second).toEqual({ kind: 'duplicate', eventId: 'evt_dup' });
    expect(third.kind).toBe('duplicate');
    expect(ctx.stripe.subscriptions.retrieve).toHaveBeenCalledTimes(1);
    expect(ctx.repo.events).toHaveLength(1);
  });

  it('applies Stripe’s current state, not the (older) event body, when events arrive out of order', async () => {
    // Stripe now says: canceled. A stale "updated: active" event arrives after the "deleted" one.
    ctx.stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ status: 'canceled' }));
    await ctx.deliver(subscriptionEvent('evt_deleted', 'customer.subscription.deleted', { id: 'sub_1', customer: 'cus_a', status: 'canceled' }, 2000));
    await ctx.deliver(subscriptionEvent('evt_old_update', 'customer.subscription.updated', { id: 'sub_1', customer: 'cus_a', status: 'active' }, 1000));
    expect(ctx.repo.subs[0].status).toBe('canceled');
  });

  it('ignores a late event from an older subscription once a newer one is current', async () => {
    Object.assign(ctx.repo.subs[0], { stripeSubscriptionId: 'sub_new', plan: 'BUSINESS', status: 'active', stripePriceId: PRICES.BUSINESS_MONTHLY });
    ctx.stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_old', status: 'canceled', price: PRICES.STARTER_MONTHLY }));
    const result = await ctx.deliver(subscriptionEvent('evt_old_sub', 'customer.subscription.deleted', { id: 'sub_old', customer: 'cus_a' }));
    expect(result.kind).toBe('ignored');
    expect(ctx.repo.subs[0]).toMatchObject({ stripeSubscriptionId: 'sub_new', plan: 'BUSINESS', status: 'active' });
  });

  it('ignores events for customers that are not ours (200, so Stripe stops)', async () => {
    ctx.stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ customer: 'cus_stranger', metadata: {} }));
    const result = await ctx.deliver(subscriptionEvent('evt_stranger', 'customer.subscription.updated', { id: 'sub_x', customer: 'cus_stranger' }));
    expect(result.kind).toBe('ignored');
    expect(ctx.repo.events[0].processingStatus).toBe('ignored');
  });

  it('never applies a subscription whose metadata names another organization', async () => {
    ctx.stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ customer: 'cus_a', metadata: { organizationId: ORG_B } }));
    const result = await ctx.deliver(subscriptionEvent('evt_cross', 'customer.subscription.updated', { id: 'sub_1', customer: 'cus_a' }));
    expect(result.kind).toBe('failed');
    expect(ctx.repo.subs[0]).toMatchObject({ plan: 'FREE', stripeSubscriptionId: null });
    expect(ctx.repo.events[0].errorMessage).toMatch(/TenantMismatch/);
  });

  it('fails (for a retry) on a Price no plan is configured with, granting nothing', async () => {
    ctx.stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ price: 'price_unknown' }));
    const result = await ctx.deliver(subscriptionEvent('evt_unknown_price', 'customer.subscription.created', { id: 'sub_1', customer: 'cus_a' }));
    expect(result.kind).toBe('failed');
    expect(ctx.repo.subs[0].plan).toBe('FREE');
  });

  it('retries a failed event when Stripe redelivers it', async () => {
    ctx.stripe.subscriptions.retrieve.mockRejectedValueOnce(new Error('database blip')).mockResolvedValueOnce(stripeSubscription());
    const event = subscriptionEvent('evt_retry', 'customer.subscription.created', { id: 'sub_1', customer: 'cus_a' });
    expect((await ctx.deliver(event)).kind).toBe('failed');
    expect(ctx.repo.events[0].processingStatus).toBe('failed');
    expect((await ctx.deliver(event)).kind).toBe('processed');
    expect(ctx.repo.events[0]).toMatchObject({ processingStatus: 'processed', attempts: 2 });
    expect(ctx.repo.subs[0].status).toBe('active');
  });

  it('records a failed renewal and moves the subscription to past_due', async () => {
    Object.assign(ctx.repo.subs[0], { stripeSubscriptionId: 'sub_1', plan: 'PROFESSIONAL', status: 'active', billingInterval: 'MONTHLY' });
    ctx.stripe.invoices.retrieve.mockResolvedValue(stripeInvoice({ status: 'open', failure: 'Your card has insufficient funds.' }));
    ctx.stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ status: 'past_due' }));

    await ctx.deliver(invoiceEvent('evt_failed', 'invoice.payment_failed'));

    expect(ctx.repo.payments.get('in_1')).toMatchObject({
      status: 'failed',
      amount: 299_900,
      currency: 'inr',
      stripePaymentIntentId: 'pi_1',
      failureReason: 'Your card has insufficient funds.',
      paymentMethod: 'card',
    });
    expect(ctx.repo.subs[0]).toMatchObject({ status: 'past_due' });
    expect(ctx.repo.subs[0].pastDueSince).toBeInstanceOf(Date);
    expect(ctx.repo.invoices.get('in_1')).toMatchObject({ orgId: ORG_A, status: 'open', amountDue: 299_900 });
  });

  it('recovers on invoice.paid, and a late failure event does not undo the success', async () => {
    Object.assign(ctx.repo.subs[0], { stripeSubscriptionId: 'sub_1', plan: 'PROFESSIONAL', status: 'past_due', pastDueSince: new Date() });
    const paidAt = Math.floor(Date.now() / 1000);
    ctx.stripe.invoices.retrieve.mockResolvedValue(stripeInvoice({ status: 'paid', amount_paid: 299_900, paid_at: paidAt, intentStatus: 'succeeded' }));
    ctx.stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ status: 'active' }));

    await ctx.deliver(invoiceEvent('evt_paid', 'invoice.paid'));
    expect(ctx.repo.payments.get('in_1')).toMatchObject({ status: 'succeeded' });
    expect(ctx.repo.subs[0]).toMatchObject({ status: 'active', pastDueSince: null });

    // The earlier failure, delivered late. The invoice as Stripe has it now is still paid.
    await ctx.deliver(invoiceEvent('evt_late_failure', 'invoice.payment_failed'));
    expect(ctx.repo.payments.get('in_1')).toMatchObject({ status: 'succeeded' });
  });

  it('keeps one payment per invoice however many invoice events arrive', async () => {
    Object.assign(ctx.repo.subs[0], { stripeSubscriptionId: 'sub_1', plan: 'PROFESSIONAL', status: 'active' });
    ctx.stripe.invoices.retrieve.mockResolvedValue(stripeInvoice({ status: 'paid', amount_paid: 299_900, paid_at: 1, intentStatus: 'succeeded' }));
    ctx.stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscription());
    await ctx.deliver(invoiceEvent('evt_a', 'invoice.finalized'));
    await ctx.deliver(invoiceEvent('evt_b', 'invoice.paid'));
    await ctx.deliver(invoiceEvent('evt_c', 'invoice.payment_succeeded'));
    expect(ctx.repo.payments.size).toBe(1);
    expect(ctx.repo.invoices.size).toBe(1);
  });

  it('ignores test-mode events on a live server', async () => {
    const { stripe } = ctx;
    const live = setup(fakeRepo([{ orgId: ORG_A, stripeCustomerId: 'cus_a' }]));
    const config = makeConfig({ STRIPE_MODE: 'live', STRIPE_SECRET_KEY: 'sk_live_fake' });
    const service = stripeServiceWith(live.stripe, config);
    const sync = new SubscriptionSyncService(asRepo(live.repo), config, service, live.audit as unknown as AuditService);
    const webhooks = new StripeWebhookService(config, service, asRepo(live.repo), sync);
    const { rawBody, signature } = signedDelivery(stripe, subscriptionEvent('evt_test', 'customer.subscription.updated', { id: 'sub_1', customer: 'cus_a' }));
    expect((await webhooks.receive(rawBody, signature)).kind).toBe('ignored');
    expect(live.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });
});
