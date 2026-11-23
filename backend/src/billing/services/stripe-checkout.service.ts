import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { BillingInterval, SubscriptionPlan } from '@prisma/client';
import type Stripe from 'stripe';
import { AuditService } from '@/audit/audit.service';
import type { AuthContext } from '@/auth/auth.types';
import { AppError } from '@/common/errors/app-error';
import { BillingConfig } from '../billing.config';
import { BILLING_ERRORS, META, TERMINAL_STATUSES } from '../billing.constants';
import { BillingRepository, type SubscriptionRow } from '../billing.repository';
import { StripePriceService } from './stripe-price.service';
import { StripeService, stripeId } from './stripe.service';
import { SubscriptionSyncService } from './subscription-sync.service';

/** A remembered session is reused only while it has at least this long left. */
const REUSE_MIN_REMAINING_MS = 2 * 60_000;

export interface CheckoutResult {
  url: string;
  sessionId: string;
  /** An open session from an earlier click was handed back instead of a new one. */
  reused: boolean;
}

export type CheckoutStatus = 'open' | 'complete' | 'expired';

/**
 * Starting a paid subscription with Stripe Checkout.
 *
 * Only the plan and interval come from the browser. The organization is the
 * session's, the Price is the server's own config (checked against Stripe),
 * and the amount is whatever that Price says. Paying does not activate
 * anything here: the subscription is granted when Stripe's webhook (or a
 * server-side read of the session from Stripe) confirms it.
 */
@Injectable()
export class StripeCheckoutService {
  private readonly logger = new Logger('BillingCheckout');

  constructor(
    private readonly config: BillingConfig,
    private readonly stripe: StripeService,
    private readonly prices: StripePriceService,
    private readonly repo: BillingRepository,
    private readonly sync: SubscriptionSyncService,
    private readonly audit: AuditService,
  ) {}

  async createCheckout(auth: AuthContext, plan: SubscriptionPlan, interval: BillingInterval): Promise<CheckoutResult> {
    const priceId = this.prices.priceIdFor(plan, interval);
    if (!this.config.successUrl || !this.config.cancelUrl) {
      throw new AppError(BILLING_ERRORS.NOT_CONFIGURED, 'Checkout return URLs are not configured (set APP_URL or BILLING_SUCCESS_URL / BILLING_CANCEL_URL).', undefined, 503);
    }

    const row = await this.repo.ensure(auth.organizationId);
    this.assertNoLiveSubscription(row);

    const reusable = await this.reusableSession(row, plan, interval);
    if (reusable) return reusable;

    await this.prices.verifiedPriceId(plan, interval);
    const customerId = await this.ensureCustomer(row, auth);
    await this.assertNoLiveSubscriptionInStripe(auth.organizationId, customerId);
    const firstSubscription = !row.stripeSubscriptionId && !(await this.repo.hasBillingHistory(auth.organizationId));

    const metadata = {
      [META.ORGANIZATION_ID]: auth.organizationId,
      [META.SUBSCRIPTION_ROW_ID]: row.id,
      [META.PLAN]: plan,
      [META.INTERVAL]: interval,
    };
    const params: Stripe.Checkout.SessionCreateParams = {
      mode: 'subscription',
      customer: customerId,
      client_reference_id: auth.organizationId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${this.config.successUrl}${this.config.successUrl.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: this.config.cancelUrl,
      metadata,
      subscription_data: {
        metadata,
        ...(firstSubscription && this.config.trialDays > 0 ? { trial_period_days: this.config.trialDays } : {}),
      },
      ...(this.config.allowPromotionCodes ? { allow_promotion_codes: true } : {}),
      ...(this.config.automaticTax
        ? { automatic_tax: { enabled: true }, customer_update: { address: 'auto' as const, name: 'auto' as const } }
        : {}),
    };

    // Two clicks at once share one key, so Stripe hands both the same session.
    // The previous session id is part of it, so after one expires the next
    // request gets a fresh session rather than a replay of the expired one.
    // The row and customer are too: the params carry both, and a key reused
    // with different params is refused by Stripe (an idempotency error).
    const idempotencyKey = `checkout:${digest(`${auth.organizationId}:${row.id}:${customerId}:${plan}:${interval}:${row.checkoutSessionId ?? 'none'}`)}`;
    const session = await this.stripe.call('checkout.sessions.create', (s) => s.checkout.sessions.create(params, { idempotencyKey }));
    if (!session.url) {
      throw new AppError(BILLING_ERRORS.PROVIDER_ERROR, 'The payment provider did not return a checkout page.', undefined, 502);
    }

    await this.repo.setCheckout(auth.organizationId, {
      sessionId: session.id,
      plan,
      interval,
      expiresAt: new Date(session.expires_at * 1000),
    });
    await this.audit.record({
      orgId: auth.organizationId,
      actorType: 'user',
      actorId: auth.userId,
      action: 'billing.checkout_started',
      entityType: 'subscription',
      entityId: row.id,
      payload: { plan, interval, checkoutSessionId: session.id },
    });
    return { url: session.url, sessionId: session.id, reused: false };
  }

  /**
   * Where a Checkout Session stands, read from Stripe — never from the URL the
   * browser came back with. A completed session's subscription is synced on
   * the spot, so the success page does not depend on the webhook's timing.
   */
  async checkoutStatus(auth: AuthContext, sessionId: string): Promise<{ status: CheckoutStatus; paymentStatus: string }> {
    const row = await this.repo.findByOrg(auth.organizationId);
    if (!row?.stripeCustomerId) throw new AppError('NOT_FOUND', 'Checkout session not found.');

    const session = await this.stripe.call('checkout.sessions.retrieve', (s) => s.checkout.sessions.retrieve(sessionId));
    // Someone else's session id gets the same answer as one that does not exist.
    if (stripeId(session.customer) !== row.stripeCustomerId || session.metadata?.[META.ORGANIZATION_ID] !== auth.organizationId) {
      throw new AppError('NOT_FOUND', 'Checkout session not found.');
    }

    const subscriptionId = stripeId(session.subscription);
    if (session.status === 'complete' && subscriptionId) {
      await this.sync.syncSubscriptionById(subscriptionId);
    }
    if (session.status !== 'open') await this.repo.clearCheckout(auth.organizationId, session.id);
    return { status: (session.status ?? 'open') as CheckoutStatus, paymentStatus: session.payment_status };
  }

  /** The Stripe customer for the organization, created once. */
  async ensureCustomer(row: SubscriptionRow, auth: AuthContext): Promise<string> {
    if (row.stripeCustomerId) return row.stripeCustomerId;
    const [org, email] = await Promise.all([
      this.repo.organization(auth.organizationId),
      this.repo.userEmail(auth.organizationId, auth.userId),
    ]);
    const customer = await this.stripe.call('customers.create', (s) =>
      s.customers.create(
        {
          name: org?.name ?? undefined,
          email: email ?? undefined,
          metadata: { [META.ORGANIZATION_ID]: auth.organizationId },
        },
        // Concurrent first checkouts create one customer, not two.
        { idempotencyKey: `customer:${auth.organizationId}` },
      ),
    );
    const stored = await this.repo.setCustomerIfMissing(auth.organizationId, customer.id);
    if (stored.stripeCustomerId !== customer.id) {
      this.logger.warn(`Organization ${auth.organizationId} already had customer ${stored.stripeCustomerId}; ${customer.id} is unused`);
    }
    return stored.stripeCustomerId!;
  }

  private assertNoLiveSubscription(row: SubscriptionRow): void {
    if (!row.stripeSubscriptionId || TERMINAL_STATUSES.includes(row.status)) return;
    if (row.status === 'incomplete') {
      throw new AppError(
        BILLING_ERRORS.SUBSCRIPTION_PENDING,
        'A payment for your subscription is still being confirmed. Complete it from Manage billing, or wait for it to expire.',
        undefined,
        409,
      );
    }
    throw new AppError(
      BILLING_ERRORS.SUBSCRIPTION_EXISTS,
      'Your organization already has a subscription. Change plans from Billing instead.',
      undefined,
      409,
    );
  }

  /**
   * Stripe's own answer to "does this customer already pay for a plan?". Our
   * row can lag behind Stripe (a webhook not delivered yet, or the row reset),
   * and a second Checkout would then start a second subscription. A live one
   * found here is adopted into the row before the request is refused.
   */
  private async assertNoLiveSubscriptionInStripe(orgId: string, customerId: string): Promise<void> {
    const list = await this.stripe.call('subscriptions.list', (s) => s.subscriptions.list({ customer: customerId, status: 'all', limit: 20 }));
    const live = list.data.find((sub) => !TERMINAL_STATUSES.includes(sub.status as SubscriptionRow['status']));
    if (!live) return;
    this.logger.warn(`Organization ${orgId}: Stripe already has subscription ${live.id} (${live.status}); syncing it instead of starting a new checkout`);
    await this.sync.syncSubscriptionById(live.id);
    const row = await this.repo.findByOrg(orgId);
    if (row) this.assertNoLiveSubscription(row);
    throw new AppError(
      BILLING_ERRORS.SUBSCRIPTION_EXISTS,
      'Your organization already has a subscription. Change plans from Billing instead.',
      undefined,
      409,
    );
  }

  /**
   * The session from an earlier click, if it is still open for the same plan.
   * One for a different plan is expired first, so there are never two payable
   * checkouts (two subscriptions) for one organization.
   */
  private async reusableSession(row: SubscriptionRow, plan: SubscriptionPlan, interval: BillingInterval): Promise<CheckoutResult | null> {
    if (!row.checkoutSessionId) return null;
    const sessionId = row.checkoutSessionId;
    const session = await this.stripe.call('checkout.sessions.retrieve', (s) => s.checkout.sessions.retrieve(sessionId));

    if (session.status === 'complete') {
      throw new AppError(
        BILLING_ERRORS.SUBSCRIPTION_PENDING,
        'Your payment went through and is being confirmed. This takes a few seconds.',
        undefined,
        409,
      );
    }
    if (session.status === 'open') {
      const samePlan = row.checkoutPlan === plan && row.checkoutInterval === interval;
      const timeLeft = session.expires_at * 1000 - Date.now();
      if (samePlan && session.url && timeLeft > REUSE_MIN_REMAINING_MS) {
        return { url: session.url, sessionId: session.id, reused: true };
      }
      await this.stripe.call('checkout.sessions.expire', (s) => s.checkout.sessions.expire(sessionId));
    }
    await this.repo.clearCheckout(row.orgId, sessionId);
    return null;
  }
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 40);
