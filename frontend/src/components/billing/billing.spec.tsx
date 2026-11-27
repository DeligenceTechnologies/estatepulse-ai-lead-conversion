import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PricingPlans } from './PricingPlans';
import { InvoiceTable, SubscriptionSummary, UsagePanel } from './BillingSettings';
import type { InvoicePage, PlansResponse, SubscriptionInfo, UsageInfo } from '../../utils/billingApi';

/**
 * Rendering checks for the billing screens, as static HTML (react-dom/server):
 * what each state shows, which buttons exist and what they would do.
 */

const ALL = { MONTHLY: true, YEARLY: true };
const CATALOG: PlansResponse = {
  currency: 'inr',
  mode: 'test',
  checkoutConfigured: true,
  features: [
    { key: 'lead_management', label: 'Lead management' },
    { key: 'lead_automation', label: 'Lead automation (follow-up sequences)' },
    { key: 'priority_support', label: 'Priority support' },
  ],
  plans: [
    { key: 'FREE', name: 'Free', description: '', recommended: false, prices: null, checkoutAvailable: { MONTHLY: false, YEARLY: false }, features: ['lead_management'], limits: { maxMembers: 1 } },
    { key: 'STARTER', name: 'Starter', description: '', recommended: false, prices: { MONTHLY: 99_900, YEARLY: 999_900 }, checkoutAvailable: ALL, features: ['lead_management'], limits: { maxMembers: 3 } },
    { key: 'PROFESSIONAL', name: 'Professional', description: '', recommended: true, prices: { MONTHLY: 299_900, YEARLY: 2_999_900 }, checkoutAvailable: ALL, features: ['lead_management', 'lead_automation'], limits: { maxMembers: 10 } },
    { key: 'BUSINESS', name: 'Business', description: '', recommended: false, prices: { MONTHLY: 599_900, YEARLY: 5_999_900 }, checkoutAvailable: { MONTHLY: true, YEARLY: false }, features: ['lead_management', 'lead_automation', 'priority_support'], limits: { maxMembers: 25 } },
  ],
};

const SUB: SubscriptionInfo = {
  plan: 'FREE',
  subscribedPlan: 'FREE',
  accessReason: 'free_plan',
  graceEndsAt: null,
  status: null,
  hasSubscription: false,
  hasBillingAccount: false,
  billingInterval: null,
  currentPeriodStart: null,
  currentPeriodEnd: null,
  renewsAt: null,
  trialEnd: null,
  cancelAtPeriodEnd: false,
  canceledAt: null,
  endedAt: null,
  pendingChange: null,
  checkoutPending: false,
  features: ['lead_management'],
  limits: { maxMembers: 1 },
  enforced: true,
  mode: 'test',
  immediateCancelAllowed: false,
  lastSyncedAt: null,
};

const render = (el: React.ReactElement) => renderToStaticMarkup(el);
const noop = () => undefined;
/** The button on one plan's card. */
const cardButton = (html: string, plan: string) => {
  const card = html.split(`data-plan="${plan}"`)[1].split('</section>')[0];
  return { action: /data-action="([a-z_]+)"/.exec(card)?.[1], disabled: /<button[^>]*disabled=""/.test(card), text: card };
};

describe('Pricing page', () => {
  const pricing = (over: Partial<React.ComponentProps<typeof PricingPlans>> = {}) =>
    render(<PricingPlans catalog={CATALOG} subscription={SUB} interval="MONTHLY" onIntervalChange={noop} onSelect={noop} {...over} />);

  it('shows all four plans with their prices, the recommended badge and the comparison', () => {
    const html = pricing();
    for (const name of ['Free', 'Starter', 'Professional', 'Business']) expect(html).toContain(`aria-label="${name} plan"`);
    expect(html).toContain('₹2,999');
    expect(html).toContain('₹999');
    expect(cardButton(html, 'PROFESSIONAL').text).toContain('Recommended');
    expect(html).toContain('Feature comparison');
    expect(html).toContain('Priority support');
  });

  it('switches every price with the yearly toggle', () => {
    const html = pricing({ interval: 'YEARLY' });
    expect(html).toContain('₹29,999');
    expect(html).toContain('/ year');
    expect(html).toMatch(/aria-checked="true"[^>]*>Yearly/);
  });

  it('offers Subscribe on paid plans to a free organization, and marks Free as current', () => {
    const html = pricing();
    expect(cardButton(html, 'PROFESSIONAL')).toMatchObject({ action: 'checkout', disabled: false });
    expect(cardButton(html, 'FREE')).toMatchObject({ action: 'current', disabled: true });
    expect(cardButton(html, 'FREE').text).toContain('Your plan');
  });

  it('shows the current plan and upgrade/downgrade buttons for a subscriber', () => {
    const html = pricing({ subscription: { ...SUB, plan: 'PROFESSIONAL', subscribedPlan: 'PROFESSIONAL', hasSubscription: true, status: 'active', billingInterval: 'MONTHLY' } });
    expect(cardButton(html, 'PROFESSIONAL')).toMatchObject({ action: 'current', disabled: true });
    expect(cardButton(html, 'PROFESSIONAL').text).toContain('Your plan');
    expect(cardButton(html, 'BUSINESS').action).toBe('upgrade');
    expect(cardButton(html, 'STARTER').action).toBe('downgrade');
    expect(cardButton(html, 'FREE').action).toBe('cancel_to_free');
  });

  it('disables a plan the server cannot sell yet, and warns when checkout is off entirely', () => {
    expect(cardButton(pricing({ interval: 'YEARLY' }), 'BUSINESS')).toMatchObject({ action: 'unavailable', disabled: true });
    expect(pricing({ catalog: { ...CATALOG, checkoutConfigured: false } })).toContain('data-testid="checkout-not-configured"');
  });

  it('shows a spinner on the plan being bought and locks the others', () => {
    const html = pricing({ busyPlan: 'PROFESSIONAL' });
    expect(cardButton(html, 'PROFESSIONAL').text).toContain('aria-busy="true"');
    expect(cardButton(html, 'STARTER').disabled).toBe(true);
  });

  it('renders loading and error states', () => {
    expect(pricing({ catalog: null, loading: true })).toContain('Loading plans');
    const error = pricing({ catalog: null, error: 'Cannot reach the server.', onRetry: noop });
    expect(error).toContain('role="alert"');
    expect(error).toContain('Try again');
  });

  it('hides every buy button from a read-only viewer', () => {
    expect(pricing({ canManage: false })).not.toContain('data-action=');
  });
});

describe('Billing settings', () => {
  it('shows plan, status, interval and dates for an active subscription', () => {
    const html = render(
      <SubscriptionSummary
        catalog={CATALOG}
        subscription={{
          ...SUB,
          plan: 'PROFESSIONAL',
          subscribedPlan: 'PROFESSIONAL',
          hasSubscription: true,
          hasBillingAccount: true,
          status: 'active',
          billingInterval: 'YEARLY',
          currentPeriodStart: '2026-11-01T00:00:00Z',
          currentPeriodEnd: '2027-11-01T00:00:00Z',
          renewsAt: '2027-11-01T00:00:00Z',
        }}
      />,
    );
    expect(html).toContain('data-testid="current-plan">Professional');
    expect(html).toContain('data-testid="subscription-status"');
    expect(html).toContain('Active');
    expect(html).toContain('Yearly');
    expect(html).toContain('₹29,999');
    expect(html).toContain('Next billing date');
    expect(html).toContain('2027');
  });

  it('shows cancellation and a scheduled downgrade', () => {
    const html = render(
      <SubscriptionSummary
        catalog={CATALOG}
        subscription={{
          ...SUB,
          plan: 'BUSINESS',
          subscribedPlan: 'BUSINESS',
          hasSubscription: true,
          status: 'active',
          billingInterval: 'MONTHLY',
          cancelAtPeriodEnd: true,
          currentPeriodEnd: '2026-12-01T00:00:00Z',
          pendingChange: { plan: 'STARTER', interval: 'MONTHLY', effectiveAt: '2026-12-01T00:00:00Z' },
        }}
      />,
    );
    expect(html).toContain('Cancels at period end');
    expect(html).toContain('Ends on');
    expect(html).toContain('Changes to Starter');
  });

  it('shows paid features paused when the payment has not cleared', () => {
    const html = render(
      <SubscriptionSummary catalog={CATALOG} subscription={{ ...SUB, plan: 'FREE', subscribedPlan: 'PROFESSIONAL', hasSubscription: true, status: 'incomplete', accessReason: 'incomplete' }} />,
    );
    expect(html).toContain('data-testid="current-plan">Free');
    expect(html).toContain('Payment pending');
    expect(html).toContain('features are paused');
  });

  it('shows member usage and recommends an upgrade at the limit', () => {
    const usage: UsageInfo = {
      plan: 'STARTER',
      enforced: true,
      members: { used: 3, limit: 3, atLimit: true, overLimit: false },
      features: ['lead_management'],
      upgradeRecommendation: { plan: 'PROFESSIONAL', reason: 'Your plan allows 3 team members.' },
    };
    const html = render(<UsagePanel usage={usage} catalog={CATALOG} onUpgrade={noop} />);
    expect(html).toContain('data-testid="member-usage">3 of 3');
    expect(html).toContain('data-testid="upgrade-recommendation"');
    expect(html).toContain('Professional fits your team');
    expect(html).toContain('See plans');
  });

  it('lists invoices with amount, currency, status and both links', () => {
    const page: InvoicePage = {
      data: [
        {
          id: 'inv-1',
          stripeInvoiceId: 'in_1',
          number: 'EP-0001',
          amountDue: 299_900,
          amountPaid: 299_900,
          currency: 'inr',
          status: 'paid',
          invoiceUrl: 'https://invoice.stripe.com/i/1',
          invoicePdf: 'https://pay.stripe.com/invoice/1/pdf',
          periodStart: null,
          periodEnd: null,
          dueDate: null,
          paidAt: '2026-11-01T00:00:00Z',
          issuedAt: '2026-11-01T00:00:00Z',
        },
      ],
      meta: { page: 1, limit: 10, count: 1, total: 1, totalPages: 1, hasNextPage: false, hasPrevPage: false },
    };
    const html = render(<InvoiceTable page={page} loading={false} error={null} />);
    expect(html).toContain('EP-0001');
    expect(html).toContain('₹2,999');
    expect(html).toContain('inr');
    expect(html).toContain('paid');
    expect(html).toContain('href="https://pay.stripe.com/invoice/1/pdf"');
    expect(html).toContain('href="https://invoice.stripe.com/i/1"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('has empty, loading and error states for invoices', () => {
    expect(render(<InvoiceTable page={null} loading error={null} />)).toContain('Loading invoices');
    expect(render(<InvoiceTable page={{ data: [], meta: { page: 1, limit: 10, count: 0, total: 0, totalPages: 0, hasNextPage: false, hasPrevPage: false } }} loading={false} error={null} />)).toContain('No invoices yet');
    expect(render(<InvoiceTable page={null} loading={false} error="Forbidden" />)).toContain('role="alert"');
  });
});
