import { describe, expect, it } from 'vitest';
import { resolveAccess } from './access-policy';
import { BillingConfig } from './billing.config';
import {
  classifyPlanChange,
  FEATURES,
  lowestPlanForMembers,
  lowestPlanWith,
  PLAN_ORDER,
  PLANS,
  planHasFeature,
} from './billing-plans';
import { makeConfig, PRICES } from './billing-fakes.test';

describe('plan catalog', () => {
  it('has the demo prices in paise and the member limits', () => {
    expect(PLANS.STARTER.prices).toEqual({ MONTHLY: 99_900, YEARLY: 999_900 });
    expect(PLANS.PROFESSIONAL.prices).toEqual({ MONTHLY: 299_900, YEARLY: 2_999_900 });
    expect(PLANS.BUSINESS.prices).toEqual({ MONTHLY: 599_900, YEARLY: 5_999_900 });
    expect(PLANS.FREE.prices).toBeNull();
    expect(PLAN_ORDER.map((p) => PLANS[p].limits.maxMembers)).toEqual([1, 3, 10, 25]);
  });

  it('gives every higher plan everything the lower one has', () => {
    for (let i = 1; i < PLAN_ORDER.length; i++) {
      const lower = PLANS[PLAN_ORDER[i - 1]].features;
      expect(PLANS[PLAN_ORDER[i]].features).toEqual(expect.arrayContaining([...lower]));
    }
  });

  it('puts automation and calendar on Professional, priority support on Business', () => {
    expect(planHasFeature('STARTER', FEATURES.LEAD_AUTOMATION)).toBe(false);
    expect(planHasFeature('PROFESSIONAL', FEATURES.LEAD_AUTOMATION)).toBe(true);
    expect(lowestPlanWith(FEATURES.CALENDAR_INTEGRATION)).toBe('PROFESSIONAL');
    expect(lowestPlanWith(FEATURES.PRIORITY_SUPPORT)).toBe('BUSINESS');
    expect(lowestPlanForMembers(4)).toBe('PROFESSIONAL');
    expect(lowestPlanForMembers(26)).toBeNull();
  });
});

describe('classifyPlanChange', () => {
  it('ranks plans before intervals', () => {
    expect(classifyPlanChange({ plan: 'STARTER', interval: 'YEARLY' }, { plan: 'PROFESSIONAL', interval: 'MONTHLY' })).toBe('upgrade');
    expect(classifyPlanChange({ plan: 'BUSINESS', interval: 'MONTHLY' }, { plan: 'STARTER', interval: 'YEARLY' })).toBe('downgrade');
  });

  it('treats monthly → yearly as an upgrade and the reverse as a downgrade', () => {
    expect(classifyPlanChange({ plan: 'PROFESSIONAL', interval: 'MONTHLY' }, { plan: 'PROFESSIONAL', interval: 'YEARLY' })).toBe('upgrade');
    expect(classifyPlanChange({ plan: 'PROFESSIONAL', interval: 'YEARLY' }, { plan: 'PROFESSIONAL', interval: 'MONTHLY' })).toBe('downgrade');
    expect(classifyPlanChange({ plan: 'PROFESSIONAL', interval: 'YEARLY' }, { plan: 'PROFESSIONAL', interval: 'YEARLY' })).toBe('same');
  });
});

describe('BillingConfig', () => {
  it('maps Price IDs both ways and only for configured plans', () => {
    const config = makeConfig();
    expect(config.priceIdFor('PROFESSIONAL', 'MONTHLY')).toBe(PRICES.PRO_MONTHLY);
    expect(config.priceRef(PRICES.PRO_YEARLY)).toEqual({ plan: 'PROFESSIONAL', interval: 'YEARLY' });
    expect(config.priceIdFor('BUSINESS', 'YEARLY')).toBeUndefined();
    expect(config.checkoutAvailable('BUSINESS', 'YEARLY')).toBe(false);
    expect(config.checkoutAvailable('PROFESSIONAL', 'MONTHLY')).toBe(true);
    expect(config.priceRef('price_someone_else')).toBeUndefined();
  });

  it('is unconfigured without a secret key, and derives return URLs from APP_URL', () => {
    const config = new BillingConfig({ APP_URL: 'https://app.example.com/', STRIPE_PROFESSIONAL_MONTHLY_PRICE_ID: 'price_x' });
    expect(config.stripeConfigured).toBe(false);
    expect(config.checkoutAvailable('PROFESSIONAL', 'MONTHLY')).toBe(false);
    expect(config.successUrl).toBe('https://app.example.com/billing/success');
    expect(config.portalReturnUrl).toBe('https://app.example.com/settings?tab=billing');
  });

  it('refuses one Price configured for two plans', () => {
    expect(
      () => new BillingConfig({ STRIPE_STARTER_MONTHLY_PRICE_ID: 'price_dup', STRIPE_BUSINESS_MONTHLY_PRICE_ID: 'price_dup' }),
    ).toThrow(/more than one plan/);
  });
});

describe('resolveAccess (subscription status → paid features)', () => {
  const now = new Date('2026-11-23T12:00:00Z');
  const sub = (status: Parameters<typeof resolveAccess>[0] extends infer S ? S extends { status: infer T } ? T : never : never, pastDueSince: Date | null = null) =>
    ({ plan: 'PROFESSIONAL' as const, status, pastDueSince });

  it('grants the plan while active or trialing', () => {
    expect(resolveAccess(sub('active'), now, 7)).toEqual({ plan: 'PROFESSIONAL', reason: 'paid' });
    expect(resolveAccess(sub('trialing'), now, 7)).toEqual({ plan: 'PROFESSIONAL', reason: 'trial' });
  });

  it('keeps the plan through the past-due grace period, then drops to free', () => {
    const recent = resolveAccess(sub('past_due', new Date('2026-11-20T12:00:00Z')), now, 7);
    expect(recent.plan).toBe('PROFESSIONAL');
    expect(recent.reason).toBe('past_due_grace');
    const old = resolveAccess(sub('past_due', new Date('2026-11-01T12:00:00Z')), now, 7);
    expect(old).toMatchObject({ plan: 'FREE', reason: 'past_due_expired' });
  });

  it('never grants paid features on an incomplete, unpaid, paused or canceled subscription', () => {
    for (const status of ['incomplete', 'incomplete_expired', 'unpaid', 'paused', 'canceled'] as const) {
      expect(resolveAccess(sub(status), now, 7).plan).toBe('FREE');
    }
  });

  it('is free with no subscription at all', () => {
    expect(resolveAccess(null, now, 7)).toEqual({ plan: 'FREE', reason: 'free_plan' });
  });
});
