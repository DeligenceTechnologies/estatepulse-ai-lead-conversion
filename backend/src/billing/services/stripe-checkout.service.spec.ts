import { beforeEach, describe, expect, it } from 'vitest';
import { ValidationPipe } from '@nestjs/common';
import type { AuditService } from '@/audit/audit.service';
import { SelectPlanDto } from '../dto/billing.dto';
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
  type FakeRepo,
  type FakeStripe,
} from '../billing-fakes.test';
import { BillingConfig } from '../billing.config';
import { StripeCheckoutService } from './stripe-checkout.service';
import { StripePriceService } from './stripe-price.service';
import { SubscriptionSyncService } from './subscription-sync.service';

function setup(repo: FakeRepo = fakeRepo(), config: BillingConfig = makeConfig()) {
  const stripe = fakeStripe();
  stripe.prices.retrieve.mockImplementation(async (id: string) =>
    id === PRICES.PRO_YEARLY ? stripePrice(id, 2_999_900, 'year') : stripePrice(id, 299_900, 'month'),
  );
  const service = stripeServiceWith(stripe, config);
  const audit = fakeAudit() as unknown as AuditService;
  const prices = new StripePriceService(config, service);
  const sync = new SubscriptionSyncService(asRepo(repo), config, service, audit);
  const checkout = new StripeCheckoutService(config, service, prices, asRepo(repo), sync, audit);
  return { stripe, repo, checkout };
}

const errorCode = (e: unknown) => (e as { getResponse(): { error: { code: string } } }).getResponse().error.code;
async function rejection(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

describe('POST /billing/checkout', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('creates the customer once and a subscription checkout at the server’s own Price', async () => {
    const result = await ctx.checkout.createCheckout(auth(), 'PROFESSIONAL', 'MONTHLY');

    expect(result).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_test_1', sessionId: 'cs_test_1', reused: false });
    expect(ctx.stripe.customers.create).toHaveBeenCalledTimes(1);
    expect(ctx.stripe.customers.create.mock.calls[0][1]).toEqual({ idempotencyKey: `customer:${ORG_A}` });

    const [params, options] = ctx.stripe.checkout.sessions.create.mock.calls[0] as unknown as [Record<string, any>, { idempotencyKey: string }];
    expect(params.mode).toBe('subscription');
    expect(params.customer).toBe('cus_a');
    expect(params.line_items).toEqual([{ price: PRICES.PRO_MONTHLY, quantity: 1 }]);
    expect(params.client_reference_id).toBe(ORG_A);
    expect(params.metadata).toMatchObject({ organizationId: ORG_A, plan: 'PROFESSIONAL', interval: 'MONTHLY' });
    expect(params.subscription_data.metadata.organizationId).toBe(ORG_A);
    expect(params.success_url).toBe('http://localhost:3000/billing/success?session_id={CHECKOUT_SESSION_ID}');
    expect(options.idempotencyKey).toMatch(/^checkout:/);

    // Nothing is granted by starting a checkout.
    expect(ctx.repo.subs[0]).toMatchObject({ plan: 'FREE', stripeSubscriptionId: null, checkoutSessionId: 'cs_test_1' });
  });

  it('hands the same open session back on a second click instead of opening another', async () => {
    await ctx.checkout.createCheckout(auth(), 'PROFESSIONAL', 'MONTHLY');
    ctx.stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: 'cs_test_1',
      status: 'open',
      url: 'https://checkout.stripe.com/c/pay/cs_test_1',
      expires_at: Math.floor(Date.now() / 1000) + 3000,
    });
    const again = await ctx.checkout.createCheckout(auth(), 'PROFESSIONAL', 'MONTHLY');
    expect(again.reused).toBe(true);
    expect(ctx.stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    expect(ctx.stripe.customers.create).toHaveBeenCalledTimes(1);
  });

  it('expires an open session for another plan before opening the new one', async () => {
    await ctx.checkout.createCheckout(auth(), 'PROFESSIONAL', 'MONTHLY');
    ctx.stripe.checkout.sessions.retrieve.mockResolvedValue({ id: 'cs_test_1', status: 'open', url: 'x', expires_at: Math.floor(Date.now() / 1000) + 3000 });
    ctx.stripe.checkout.sessions.create.mockResolvedValueOnce({ id: 'cs_test_2', url: 'https://checkout.stripe.com/2', expires_at: Math.floor(Date.now() / 1000) + 3600 });
    const next = await ctx.checkout.createCheckout(auth(), 'PROFESSIONAL', 'YEARLY');
    expect(ctx.stripe.checkout.sessions.expire).toHaveBeenCalledWith('cs_test_1');
    expect(next.sessionId).toBe('cs_test_2');
  });

  it('refuses a second subscription while one is live', async () => {
    const repo = fakeRepo([{ orgId: ORG_A, stripeCustomerId: 'cus_a', stripeSubscriptionId: 'sub_1', plan: 'STARTER', status: 'active' }]);
    const { checkout, stripe } = setup(repo);
    expect(errorCode(await rejection(checkout.createCheckout(auth(), 'PROFESSIONAL', 'MONTHLY')))).toBe('SUBSCRIPTION_EXISTS');
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('allows a new checkout once the old subscription is canceled', async () => {
    const repo = fakeRepo([{ orgId: ORG_A, stripeCustomerId: 'cus_a', stripeSubscriptionId: 'sub_old', plan: 'STARTER', status: 'canceled' }]);
    const { checkout, stripe } = setup(repo);
    await checkout.createCheckout(auth(), 'PROFESSIONAL', 'MONTHLY');
    expect(stripe.customers.create).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
  });

  it('says "not configured" for a plan without a Price ID, and never calls Stripe', async () => {
    const error = await rejection(ctx.checkout.createCheckout(auth(), 'BUSINESS', 'YEARLY'));
    expect(errorCode(error)).toBe('BILLING_NOT_CONFIGURED');
    expect((error as { getStatus(): number }).getStatus()).toBe(503);
    expect(ctx.stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('says "not configured" without a Stripe key at all', async () => {
    const config = new BillingConfig({ APP_URL: 'http://localhost:3000', STRIPE_PROFESSIONAL_MONTHLY_PRICE_ID: PRICES.PRO_MONTHLY });
    const repo = fakeRepo();
    const audit = fakeAudit() as unknown as AuditService;
    // No key and no injected client: the real "unconfigured" StripeService.
    const { StripeService } = await import('./stripe.service');
    const service = new StripeService(config);
    const checkout = new StripeCheckoutService(
      config,
      service,
      new StripePriceService(config, service),
      asRepo(repo),
      new SubscriptionSyncService(asRepo(repo), config, service, audit),
      audit,
    );
    expect(errorCode(await rejection(checkout.createCheckout(auth(), 'PROFESSIONAL', 'MONTHLY')))).toBe('BILLING_NOT_CONFIGURED');
    expect(repo.subs).toHaveLength(0);
  });

  it('refuses the free plan', async () => {
    expect(errorCode(await rejection(ctx.checkout.createCheckout(auth(), 'FREE', 'MONTHLY')))).toBe('BILLING_INVALID_PLAN');
  });

  it('pauses checkout when the Stripe Price does not match the price shown', async () => {
    ctx.stripe.prices.retrieve.mockResolvedValue(stripePrice(PRICES.PRO_MONTHLY, 100, 'month'));
    expect(errorCode(await rejection(ctx.checkout.createCheckout(auth(), 'PROFESSIONAL', 'MONTHLY')))).toBe('BILLING_PRICE_MISMATCH');
    ctx.stripe.prices.retrieve.mockResolvedValue(stripePrice(PRICES.PRO_MONTHLY, 299_900, 'month', { currency: 'usd' }));
    expect(errorCode(await rejection(ctx.checkout.createCheckout(auth(), 'PROFESSIONAL', 'MONTHLY')))).toBe('BILLING_PRICE_MISMATCH');
    expect(ctx.stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('accepts only a plan and an interval from the browser', async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const meta = { type: 'body' as const, metatype: SelectPlanDto };
    await expect(pipe.transform({ plan: 'PROFESSIONAL', interval: 'MONTHLY' }, meta)).resolves.toBeInstanceOf(SelectPlanDto);
    await expect(pipe.transform({ plan: 'PROFESSIONAL', interval: 'MONTHLY', amount: 1 }, meta)).rejects.toThrow();
    await expect(pipe.transform({ plan: 'PROFESSIONAL', interval: 'MONTHLY', organizationId: ORG_B }, meta)).rejects.toThrow();
    await expect(pipe.transform({ plan: 'PROFESSIONAL', interval: 'MONTHLY', priceId: 'price_cheap' }, meta)).rejects.toThrow();
    await expect(pipe.transform({ plan: 'ENTERPRISE', interval: 'MONTHLY' }, meta)).rejects.toThrow();
    await expect(pipe.transform({ plan: 'FREE', interval: 'MONTHLY' }, meta)).rejects.toThrow();
    await expect(pipe.transform({ plan: 'STARTER', interval: 'WEEKLY' }, meta)).rejects.toThrow();
  });
});

describe('GET /billing/checkout/:sessionId', () => {
  it('syncs a completed session’s subscription from Stripe', async () => {
    const repo = fakeRepo([{ orgId: ORG_A, stripeCustomerId: 'cus_a', checkoutSessionId: 'cs_test_1' }]);
    const { checkout, stripe } = setup(repo);
    stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: 'cs_test_1',
      status: 'complete',
      payment_status: 'paid',
      customer: 'cus_a',
      subscription: 'sub_1',
      metadata: { organizationId: ORG_A },
    });
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscription());

    await expect(checkout.checkoutStatus(auth(), 'cs_test_1')).resolves.toEqual({ status: 'complete', paymentStatus: 'paid' });
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_1');
    expect(repo.subs[0]).toMatchObject({ plan: 'PROFESSIONAL', status: 'active', stripeSubscriptionId: 'sub_1', checkoutSessionId: null });
  });

  it('answers 404 for another organization’s session, and changes nothing', async () => {
    const repo = fakeRepo([
      { orgId: ORG_A, stripeCustomerId: 'cus_a' },
      { orgId: ORG_B, id: 'row-b', stripeCustomerId: 'cus_b' },
    ]);
    const { checkout, stripe } = setup(repo);
    // Organization B's paid session, asked about by organization A.
    stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: 'cs_test_b',
      status: 'complete',
      customer: 'cus_b',
      subscription: 'sub_b',
      metadata: { organizationId: ORG_B },
    });
    expect(errorCode(await rejection(checkout.checkoutStatus(auth(ORG_A), 'cs_test_b')))).toBe('NOT_FOUND');
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(repo.subs.find((s) => s.orgId === ORG_A)).toMatchObject({ plan: 'FREE', stripeSubscriptionId: null });
  });
});
