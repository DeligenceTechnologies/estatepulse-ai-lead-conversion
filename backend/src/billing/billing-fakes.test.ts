/**
 * Shared stand-ins for the billing specs: an in-memory BillingRepository and a
 * Stripe client whose every call is a vi.fn. No database, no network, and no
 * real payment — a spec states the Stripe answers it needs.
 *
 * Named *.test.ts so it is neither a suite (vitest runs *.spec.ts) nor shipped
 * (tsconfig.build.json excludes it).
 */
import { vi } from 'vitest';
import Stripe from 'stripe';
import type { Subscription } from '@prisma/client';
import { BillingConfig, type BillingEnv } from './billing.config';
import type { BillingRepository } from './billing.repository';
import { StripeService } from './services/stripe.service';

export const ORG_A = '00000000-0000-7000-8000-00000000000a';
export const ORG_B = '00000000-0000-7000-8000-00000000000b';
export const USER_A = '00000000-0000-7000-8000-0000000000a1';

export const PRICES = {
  STARTER_MONTHLY: 'price_starter_m',
  PRO_MONTHLY: 'price_pro_m',
  PRO_YEARLY: 'price_pro_y',
  BUSINESS_MONTHLY: 'price_business_m',
};

export const WEBHOOK_SECRET = 'whsec_test_secret';

export function makeConfig(over: Partial<BillingEnv> = {}): BillingConfig {
  return new BillingConfig({
    APP_URL: 'http://localhost:3000',
    STRIPE_MODE: 'test',
    STRIPE_SECRET_KEY: 'sk_test_fake',
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STRIPE_STARTER_MONTHLY_PRICE_ID: PRICES.STARTER_MONTHLY,
    STRIPE_PROFESSIONAL_MONTHLY_PRICE_ID: PRICES.PRO_MONTHLY,
    STRIPE_PROFESSIONAL_YEARLY_PRICE_ID: PRICES.PRO_YEARLY,
    STRIPE_BUSINESS_MONTHLY_PRICE_ID: PRICES.BUSINESS_MONTHLY,
    ...over,
  });
}

export const auth = (organizationId = ORG_A, userId = USER_A) => ({
  organizationId,
  userId,
  sessionId: 'sess-1',
  roleIds: [],
  permissions: ['billing.read', 'billing.manage'],
});

/** A Stripe Price object as prices.retrieve returns it. */
export function stripePrice(id: string, amount: number, interval: 'month' | 'year', over: Record<string, unknown> = {}) {
  return {
    id,
    object: 'price',
    active: true,
    type: 'recurring',
    currency: 'inr',
    unit_amount: amount,
    livemode: false,
    recurring: { interval, interval_count: 1 },
    ...over,
  };
}

const NOW = () => Math.floor(Date.now() / 1000);

/** A Stripe Subscription as subscriptions.retrieve returns it. */
export function stripeSubscription(over: {
  id?: string;
  customer?: string;
  status?: string;
  price?: string;
  metadata?: Record<string, string>;
  cancel_at_period_end?: boolean;
  schedule?: string | null;
  pending_update?: unknown;
  periodStart?: number;
  periodEnd?: number;
} = {}) {
  const periodStart = over.periodStart ?? NOW() - 86_400;
  const periodEnd = over.periodEnd ?? NOW() + 29 * 86_400;
  return {
    id: over.id ?? 'sub_1',
    object: 'subscription',
    customer: over.customer ?? 'cus_a',
    status: over.status ?? 'active',
    metadata: over.metadata ?? { organizationId: ORG_A },
    cancel_at_period_end: over.cancel_at_period_end ?? false,
    cancel_at: null,
    canceled_at: null,
    ended_at: null,
    trial_start: null,
    trial_end: null,
    schedule: over.schedule ?? null,
    pending_update: over.pending_update ?? null,
    latest_invoice: null,
    items: {
      data: [
        {
          id: 'si_1',
          quantity: 1,
          price: { id: over.price ?? PRICES.PRO_MONTHLY },
          current_period_start: periodStart,
          current_period_end: periodEnd,
        },
      ],
    },
  } as unknown as Stripe.Subscription;
}

export function stripeInvoice(over: {
  id?: string;
  customer?: string;
  status?: string;
  amount_due?: number;
  amount_paid?: number;
  subscription?: string;
  paid_at?: number | null;
  intentStatus?: string;
  failure?: string;
} = {}) {
  return {
    id: over.id ?? 'in_1',
    object: 'invoice',
    customer: over.customer ?? 'cus_a',
    status: over.status ?? 'open',
    number: 'EP-0001',
    amount_due: over.amount_due ?? 299_900,
    amount_paid: over.amount_paid ?? 0,
    currency: 'inr',
    hosted_invoice_url: 'https://invoice.stripe.com/i/test',
    invoice_pdf: 'https://pay.stripe.com/invoice/test/pdf',
    period_start: NOW() - 86_400,
    period_end: NOW(),
    due_date: null,
    created: NOW(),
    status_transitions: { paid_at: over.paid_at ?? null },
    parent: { type: 'subscription_details', subscription_details: { subscription: over.subscription ?? 'sub_1', metadata: { organizationId: ORG_A } } },
    payments: {
      data: [
        {
          is_default: true,
          payment: {
            type: 'payment_intent',
            payment_intent: {
              id: 'pi_1',
              status: over.intentStatus ?? 'requires_payment_method',
              payment_method_types: ['card'],
              last_payment_error: over.failure ? { message: over.failure } : null,
            },
          },
        },
      ],
    },
  } as unknown as Stripe.Invoice;
}

/** Every Stripe method billing calls, mocked; webhooks use the real SDK's crypto. */
export function fakeStripe() {
  const real = new Stripe('sk_test_fake');
  return {
    prices: { retrieve: vi.fn() },
    customers: { create: vi.fn(async (..._args: unknown[]) => ({ id: 'cus_a' })) },
    checkout: {
      sessions: {
        create: vi.fn(async (..._args: unknown[]) => ({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1', expires_at: NOW() + 3600 })),
        retrieve: vi.fn(),
        expire: vi.fn(async (..._args: unknown[]) => ({})),
      },
    },
    subscriptions: { retrieve: vi.fn(), update: vi.fn(), cancel: vi.fn(), list: vi.fn(async (..._args: unknown[]) => ({ data: [] as unknown[] })) },
    subscriptionSchedules: {
      create: vi.fn(async (..._args: unknown[]) => ({ id: 'sub_sched_1' })),
      update: vi.fn(async (..._args: unknown[]) => ({ id: 'sub_sched_1' })),
      retrieve: vi.fn(async (..._args: unknown[]) => ({ id: 'sub_sched_1', status: 'active' })),
      release: vi.fn(async (..._args: unknown[]) => ({})),
    },
    invoices: { retrieve: vi.fn() },
    billingPortal: { sessions: { create: vi.fn(async (..._args: unknown[]) => ({ url: 'https://billing.stripe.com/p/session/test' })) } },
    events: { retrieve: vi.fn() },
    webhooks: real.webhooks,
  };
}

export type FakeStripe = ReturnType<typeof fakeStripe>;

export function stripeServiceWith(stripe: FakeStripe, config = makeConfig()): StripeService {
  return new StripeService(config, stripe as unknown as Stripe);
}

type Row = Subscription;

function newRow(orgId: string, over: Partial<Row> = {}): Row {
  return {
    id: `row-${orgId.slice(-1)}`,
    orgId,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripePriceId: null,
    plan: 'FREE',
    billingInterval: null,
    status: 'active',
    currentPeriodStart: null,
    currentPeriodEnd: null,
    trialStart: null,
    trialEnd: null,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    endedAt: null,
    pastDueSince: null,
    pendingPlan: null,
    pendingInterval: null,
    pendingChangeAt: null,
    stripeScheduleId: null,
    checkoutSessionId: null,
    checkoutPlan: null,
    checkoutInterval: null,
    checkoutExpiresAt: null,
    lastStripeEventAt: null,
    syncedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

interface EventRow {
  id: string;
  stripeEventId: string;
  eventType: string;
  processingStatus: 'pending' | 'processing' | 'processed' | 'failed' | 'ignored';
  attempts: number;
  orgId: string | null;
  errorMessage: string | null;
}

/** The parts of BillingRepository the services use, over plain arrays. */
export function fakeRepo(seed: Partial<Row>[] = []) {
  const subs: Row[] = seed.map((s) => newRow(s.orgId ?? ORG_A, s));
  const invoices = new Map<string, Record<string, unknown>>();
  const payments = new Map<string, Record<string, unknown>>();
  const events: EventRow[] = [];
  const members = new Map<string, number>();

  const find = (orgId: string) => subs.find((s) => s.orgId === orgId) ?? null;
  const repo = {
    subs,
    invoices,
    payments,
    events,
    members,
    findByOrg: vi.fn(async (orgId: string) => find(orgId)),
    ensure: vi.fn(async (orgId: string) => {
      let row = find(orgId);
      if (!row) subs.push((row = newRow(orgId)));
      return row;
    }),
    findByCustomerId: vi.fn(async (customer: string) => subs.find((s) => s.stripeCustomerId === customer) ?? null),
    setCustomerIfMissing: vi.fn(async (orgId: string, customer: string) => {
      const row = find(orgId)!;
      if (!row.stripeCustomerId) row.stripeCustomerId = customer;
      return row;
    }),
    update: vi.fn(async (orgId: string, data: Record<string, unknown>) => {
      const row = find(orgId)!;
      Object.assign(row, data);
      return row;
    }),
    setCheckout: vi.fn(async (orgId: string, c: { sessionId: string; plan: Row['plan']; interval: NonNullable<Row['billingInterval']>; expiresAt: Date }) => {
      Object.assign(find(orgId)!, { checkoutSessionId: c.sessionId, checkoutPlan: c.plan, checkoutInterval: c.interval, checkoutExpiresAt: c.expiresAt });
    }),
    clearCheckout: vi.fn(async (orgId: string, sessionId: string) => {
      const row = find(orgId);
      if (row?.checkoutSessionId === sessionId) {
        Object.assign(row, { checkoutSessionId: null, checkoutPlan: null, checkoutInterval: null, checkoutExpiresAt: null });
      }
    }),
    staleSubscriptions: vi.fn(async () => []),
    organization: vi.fn(async (orgId: string) => ({ id: orgId, name: 'Acme Realty' })),
    userEmail: vi.fn(async () => 'owner@example.test'),
    countActiveMembers: vi.fn(async (orgId: string) => members.get(orgId) ?? 1),
    hasBillingHistory: vi.fn(async (orgId: string) => [...invoices.values()].some((i) => i.orgId === orgId)),
    upsertInvoice: vi.fn(async (id: string, data: Record<string, unknown>) => {
      invoices.set(id, { ...(invoices.get(id) ?? {}), ...data, stripeInvoiceId: id });
    }),
    findPayment: vi.fn(async (id: string) => (payments.get(id) as never) ?? null),
    upsertPayment: vi.fn(async (id: string, data: Record<string, unknown>) => {
      payments.set(id, { ...(payments.get(id) ?? {}), ...data, stripeInvoiceId: id });
    }),
    listInvoices: vi.fn(),
    recordEvent: vi.fn(async (e: { stripeEventId: string; eventType: string }) => {
      const existing = events.find((r) => r.stripeEventId === e.stripeEventId);
      if (existing) return { created: false, row: existing };
      const row: EventRow = { id: `ev-row-${events.length + 1}`, stripeEventId: e.stripeEventId, eventType: e.eventType, processingStatus: 'pending', attempts: 0, orgId: null, errorMessage: null };
      events.push(row);
      return { created: true, row };
    }),
    claimEvent: vi.fn(async (id: string) => {
      const row = events.find((r) => r.id === id)!;
      if (row.processingStatus !== 'pending' && row.processingStatus !== 'failed') return false;
      row.processingStatus = 'processing';
      row.attempts++;
      return true;
    }),
    finishEvent: vi.fn(async (id: string, r: { status: EventRow['processingStatus']; orgId?: string | null; error?: string }) => {
      const row = events.find((e) => e.id === id)!;
      row.processingStatus = r.status;
      if (r.orgId !== undefined) row.orgId = r.orgId;
      row.errorMessage = r.error ?? null;
    }),
    retryableEvents: vi.fn(async () => events.filter((e) => e.processingStatus === 'failed').map((e) => ({ id: e.id, stripeEventId: e.stripeEventId }))),
  };
  return repo;
}

export type FakeRepo = ReturnType<typeof fakeRepo>;
export const asRepo = (repo: FakeRepo) => repo as unknown as BillingRepository;

export const fakeAudit = () => ({ record: vi.fn(async () => undefined), quietly: vi.fn() });

/** A signed webhook delivery, exactly as Stripe would send it. */
export function signedDelivery(stripe: FakeStripe, event: Record<string, unknown>, secret = WEBHOOK_SECRET) {
  const payload = JSON.stringify({ object: 'event', livemode: false, created: NOW(), api_version: '2026-11-18.endive', ...event });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
  return { rawBody: Buffer.from(payload), signature: header };
}
