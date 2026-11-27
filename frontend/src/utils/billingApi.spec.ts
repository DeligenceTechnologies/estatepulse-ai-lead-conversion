import { describe, expect, it, vi } from 'vitest';
import { ApiError, messageFor } from '../lib/api';
import {
  confirmedPaid,
  formatMoney,
  isPlanRestriction,
  planAction,
  pollUntil,
  startCheckout,
  statusMeta,
  yearlySavingsPercent,
  type SubscriptionInfo,
} from './billingApi';

const available = { MONTHLY: true, YEARLY: true };
const sub = (over: Partial<SubscriptionInfo> = {}) =>
  ({ plan: 'FREE', hasSubscription: false, billingInterval: null, cancelAtPeriodEnd: false, status: null, accessReason: 'free_plan', graceEndsAt: null, ...over }) as SubscriptionInfo;

describe('formatMoney', () => {
  it('shows paise as rupees, Indian grouping, no decimals for whole rupees', () => {
    expect(formatMoney(299_900, 'inr')).toBe('₹2,999');
    expect(formatMoney(2_999_900, 'inr')).toBe('₹29,999');
    expect(formatMoney(0, 'inr')).toBe('₹0');
    expect(formatMoney(12_345, 'inr')).toBe('₹123.45');
  });
});

describe('yearlySavingsPercent', () => {
  it('compares a year against twelve months', () => {
    expect(yearlySavingsPercent({ MONTHLY: 99_900, YEARLY: 999_900 })).toBe(17);
    expect(yearlySavingsPercent(null)).toBe(0);
  });
});

describe('planAction (what a plan card’s button does)', () => {
  it('subscribes through checkout when there is no subscription', () => {
    expect(planAction({ key: 'PROFESSIONAL', checkoutAvailable: available }, 'MONTHLY', sub())).toEqual({ kind: 'checkout', label: 'Subscribe' });
    expect(planAction({ key: 'FREE', checkoutAvailable: available }, 'MONTHLY', sub()).kind).toBe('current');
  });

  it('marks the current plan and interval, and upgrades or downgrades from it', () => {
    const pro = sub({ plan: 'PROFESSIONAL', hasSubscription: true, billingInterval: 'MONTHLY', status: 'active' });
    expect(planAction({ key: 'PROFESSIONAL', checkoutAvailable: available }, 'MONTHLY', pro).kind).toBe('current');
    expect(planAction({ key: 'PROFESSIONAL', checkoutAvailable: available }, 'YEARLY', pro).kind).toBe('upgrade');
    expect(planAction({ key: 'BUSINESS', checkoutAvailable: available }, 'MONTHLY', pro).kind).toBe('upgrade');
    expect(planAction({ key: 'STARTER', checkoutAvailable: available }, 'MONTHLY', pro).kind).toBe('downgrade');
    expect(planAction({ key: 'FREE', checkoutAvailable: available }, 'MONTHLY', pro).kind).toBe('cancel_to_free');
  });

  it('is unavailable when the server has no Stripe Price for it', () => {
    expect(planAction({ key: 'BUSINESS', checkoutAvailable: { MONTHLY: true, YEARLY: false } }, 'YEARLY', sub())).toEqual({
      kind: 'unavailable',
      label: 'Not available yet',
    });
  });
});

describe('confirmedPaid (the success page’s test)', () => {
  it('needs a live paid subscription from the server', () => {
    expect(confirmedPaid(sub({ plan: 'PROFESSIONAL', hasSubscription: true, status: 'active' }))).toBe(true);
    expect(confirmedPaid(sub({ plan: 'PROFESSIONAL', hasSubscription: true, status: 'trialing' }))).toBe(true);
  });

  it('is not fooled by an incomplete first payment or a still-free plan', () => {
    expect(confirmedPaid(sub({ plan: 'FREE', hasSubscription: true, status: 'incomplete' }))).toBe(false);
    expect(confirmedPaid(sub())).toBe(false);
    expect(confirmedPaid(null)).toBe(false);
  });
});

describe('statusMeta', () => {
  it('describes each lifecycle state', () => {
    expect(statusMeta(sub()).label).toBe('Free');
    expect(statusMeta(sub({ status: 'active' }))).toMatchObject({ label: 'Active', tone: 'good' });
    expect(statusMeta(sub({ status: 'active', cancelAtPeriodEnd: true })).label).toBe('Cancels at period end');
    expect(statusMeta(sub({ status: 'past_due', accessReason: 'past_due_grace' })).tone).toBe('warn');
    expect(statusMeta(sub({ status: 'past_due', accessReason: 'past_due_expired' })).tone).toBe('bad');
    expect(statusMeta(sub({ status: 'incomplete' })).label).toBe('Payment pending');
    expect(statusMeta(sub({ status: 'canceled' })).label).toBe('Canceled');
  });
});

describe('pollUntil', () => {
  it('stops as soon as the value is confirmed', async () => {
    const load = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2).mockResolvedValueOnce(3);
    const result = await pollUntil(load, (v) => v === 2, { attempts: 5, wait: async () => undefined });
    expect(result).toEqual({ value: 2, settled: true });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('reports "not settled" (still processing) after the last attempt, surviving failed polls', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue('pending');
    const result = await pollUntil(load, (v) => v === 'paid', { attempts: 3, wait: async () => undefined });
    expect(result).toEqual({ value: 'pending', settled: false });
  });
});

describe('startCheckout (the Subscribe button)', () => {
  it('posts only plan and interval, then goes to Stripe’s page', async () => {
    const checkout = vi.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/cs_test_1', sessionId: 'cs_test_1', reused: false });
    const redirect = vi.fn();
    await startCheckout('PROFESSIONAL', 'YEARLY', { checkout, redirect });
    expect(checkout).toHaveBeenCalledWith('PROFESSIONAL', 'YEARLY');
    expect(redirect).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_test_1');
  });

  it('refuses to send the browser anywhere but Stripe', async () => {
    const checkout = vi.fn().mockResolvedValue({ url: 'https://evil.example/stripe.com/', sessionId: 'x', reused: false });
    const redirect = vi.fn();
    await expect(startCheckout('STARTER', 'MONTHLY', { checkout, redirect })).rejects.toThrow();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('surfaces the server’s "not configured" error instead of redirecting', async () => {
    const checkout = vi.fn().mockRejectedValue(new ApiError('BILLING_NOT_CONFIGURED', 'Checkout for Business (yearly) is not configured yet.', 503));
    const redirect = vi.fn();
    const error = await startCheckout('BUSINESS', 'YEARLY', { checkout, redirect }).catch((e) => e);
    expect(messageFor(error)).toBe('Checkout for Business (yearly) is not configured yet.');
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe('plan restriction errors', () => {
  it('are recognised and keep the server’s wording', () => {
    const err = new ApiError('PLAN_LIMIT_REACHED', 'Your Starter plan allows 3 team members. Upgrade to Professional to add more.', 403);
    expect(isPlanRestriction(err)).toBe(true);
    expect(messageFor(err)).toContain('Upgrade to Professional');
    expect(isPlanRestriction(new ApiError('FORBIDDEN', 'x', 403))).toBe(false);
  });
});
