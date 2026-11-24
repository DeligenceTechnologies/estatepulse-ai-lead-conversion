import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ActorType, SubscriptionStatus, type BillingInterval, type SubscriptionPlan } from '@prisma/client';
import type Stripe from 'stripe';
import { AuditService } from '@/audit/audit.service';
import type { AuthContext } from '@/auth/auth.types';
import { AppError } from '@/common/errors/app-error';
import { BillingConfig } from '../billing.config';
import {
  BILLING_AUDIT_ENTITY,
  BillingAuditAction,
  BillingErrorCode,
  isTerminal,
  StripeMetadataKey,
} from '../billing.constants';
import { BillingRepository, type SubscriptionRow } from '../billing.repository';
import { StripePriceService } from './stripe-price.service';
import { digest, StripeService, stripeId } from './stripe.service';
import { SubscriptionSyncService } from './subscription-sync.service';

/** Reuse an open session only if it has at least this long left. */
const REUSE_MIN_REMAINING_MS = 2 * 60_000;

export interface CheckoutResult {
  url: string;
  sessionId: string;
  reused: boolean;
}

/** Mirrors Stripe's Checkout Session `status`. */
export enum CheckoutStatus {
  OPEN = 'open',
  COMPLETE = 'complete',
  EXPIRED = 'expired',
}

const subscriptionExists = () =>
  new AppError(BillingErrorCode.SUBSCRIPTION_EXISTS, 'Your organization already has a subscription. Change plans from Billing instead.', undefined, HttpStatus.CONFLICT);
const sessionNotFound = () => new AppError('NOT_FOUND', 'Checkout session not found.');

/**
 * Starts Stripe Checkout. Only plan+interval come from the client; the Price is server config.
 * Access is granted only after Stripe confirms (webhook or server-side session read).
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
    const orgId = auth.organizationId;
    const priceId = this.prices.priceIdFor(plan, interval);
    const { successUrl, cancelUrl } = this.config;
    if (!successUrl || !cancelUrl) {
      throw new AppError(
        BillingErrorCode.NOT_CONFIGURED,
        'Checkout return URLs are not configured (set APP_URL or BILLING_SUCCESS_URL / BILLING_CANCEL_URL).',
        undefined,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const row = await this.repo.ensure(orgId);
    this.assertNoLiveSubscription(row);

    const reusable = await this.reusableSession(row, plan, interval);
    if (reusable) return reusable;

    await this.prices.verifiedPriceId(plan, interval);
    const customerId = await this.ensureCustomer(row, auth);
    await this.assertNoLiveSubscriptionInStripe(orgId, customerId);
    const firstSubscription = !row.stripeSubscriptionId && !(await this.repo.hasBillingHistory(orgId));

    const metadata = { [StripeMetadataKey.ORGANIZATION_ID]: orgId, [StripeMetadataKey.SUBSCRIPTION_ROW_ID]: row.id, [StripeMetadataKey.PLAN]: plan, [StripeMetadataKey.INTERVAL]: interval };
    const params: Stripe.Checkout.SessionCreateParams = {
      mode: 'subscription',
      customer: customerId,
      client_reference_id: orgId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${successUrl}${successUrl.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl,
      metadata,
      subscription_data: {
        metadata,
        ...(firstSubscription && this.config.trialDays > 0 && { trial_period_days: this.config.trialDays }),
      },
      ...(this.config.allowPromotionCodes && { allow_promotion_codes: true }),
      ...(this.config.automaticTax && { automatic_tax: { enabled: true }, customer_update: { address: 'auto' as const, name: 'auto' as const } }),
    };

    // Concurrent clicks share a key (→ same session); the previous session id makes a fresh one after expiry.
    const idempotencyKey = `checkout:${digest(`${orgId}:${row.id}:${customerId}:${plan}:${interval}:${row.checkoutSessionId ?? 'none'}`)}`;
    const session = await this.stripe.call('checkout.sessions.create', (s) => s.checkout.sessions.create(params, { idempotencyKey }));
    if (!session.url) {
      throw new AppError(BillingErrorCode.PROVIDER_ERROR, 'The payment provider did not return a checkout page.', undefined, HttpStatus.BAD_GATEWAY);
    }

    await this.repo.setCheckout(orgId, { sessionId: session.id, plan, interval, expiresAt: new Date(session.expires_at * 1000) });
    await this.audit.record({
      orgId,
      actorType: ActorType.user,
      actorId: auth.userId,
      action: BillingAuditAction.CHECKOUT_STARTED,
      entityType: BILLING_AUDIT_ENTITY,
      entityId: row.id,
      payload: { plan, interval, checkoutSessionId: session.id },
    });
    return { url: session.url, sessionId: session.id, reused: false };
  }

  /** Session state read from Stripe; a completed one is synced immediately. */
  async checkoutStatus(auth: AuthContext, sessionId: string): Promise<{ status: CheckoutStatus; paymentStatus: string }> {
    const orgId = auth.organizationId;
    const row = await this.repo.findByOrg(orgId);
    if (!row?.stripeCustomerId) throw sessionNotFound();

    const session = await this.stripe.call('checkout.sessions.retrieve', (s) => s.checkout.sessions.retrieve(sessionId));
    if (stripeId(session.customer) !== row.stripeCustomerId || session.metadata?.[StripeMetadataKey.ORGANIZATION_ID] !== orgId) {
      throw sessionNotFound();
    }

    const subscriptionId = stripeId(session.subscription);
    if (session.status === CheckoutStatus.COMPLETE && subscriptionId) await this.sync.syncSubscriptionById(subscriptionId);
    if (session.status !== CheckoutStatus.OPEN) await this.repo.clearCheckout(orgId, session.id);
    return { status: (session.status ?? CheckoutStatus.OPEN) as CheckoutStatus, paymentStatus: session.payment_status };
  }

  async ensureCustomer(row: SubscriptionRow, auth: AuthContext): Promise<string> {
    if (row.stripeCustomerId) return row.stripeCustomerId;
    const orgId = auth.organizationId;
    const [org, email] = await Promise.all([this.repo.organization(orgId), this.repo.userEmail(orgId, auth.userId)]);
    const customer = await this.stripe.call('customers.create', (s) =>
      s.customers.create(
        { name: org?.name ?? undefined, email: email ?? undefined, metadata: { [StripeMetadataKey.ORGANIZATION_ID]: orgId } },
        { idempotencyKey: `customer:${orgId}` },
      ),
    );
    const stored = await this.repo.setCustomerIfMissing(orgId, customer.id);
    if (stored.stripeCustomerId !== customer.id) {
      this.logger.warn(`Organization ${orgId} already had customer ${stored.stripeCustomerId}; ${customer.id} is unused`);
    }
    return stored.stripeCustomerId!;
  }

  private assertNoLiveSubscription(row: SubscriptionRow): void {
    if (!row.stripeSubscriptionId || isTerminal(row.status)) return;
    if (row.status === SubscriptionStatus.incomplete) {
      throw new AppError(
        BillingErrorCode.SUBSCRIPTION_PENDING,
        'A payment for your subscription is still being confirmed. Complete it from Manage billing, or wait for it to expire.',
        undefined,
        HttpStatus.CONFLICT,
      );
    }
    throw subscriptionExists();
  }

  /** Our row can lag Stripe; adopt any live subscription Stripe has and refuse a second checkout. */
  private async assertNoLiveSubscriptionInStripe(orgId: string, customerId: string): Promise<void> {
    const list = await this.stripe.call('subscriptions.list', (s) => s.subscriptions.list({ customer: customerId, status: 'all', limit: 20 }));
    const live = list.data.find((sub) => !isTerminal(sub.status as SubscriptionStatus));
    if (!live) return;
    this.logger.warn(`Organization ${orgId}: Stripe already has subscription ${live.id} (${live.status}); syncing instead`);
    await this.sync.syncSubscriptionById(live.id);
    const row = await this.repo.findByOrg(orgId);
    if (row) this.assertNoLiveSubscription(row);
    throw subscriptionExists();
  }

  /** Reuses an open session for the same plan; expires one for a different plan so only one is payable. */
  private async reusableSession(row: SubscriptionRow, plan: SubscriptionPlan, interval: BillingInterval): Promise<CheckoutResult | null> {
    const sessionId = row.checkoutSessionId;
    if (!sessionId) return null;
    const session = await this.stripe.call('checkout.sessions.retrieve', (s) => s.checkout.sessions.retrieve(sessionId));

    if (session.status === CheckoutStatus.COMPLETE) {
      throw new AppError(
        BillingErrorCode.SUBSCRIPTION_PENDING,
        'Your payment went through and is being confirmed. This takes a few seconds.',
        undefined,
        HttpStatus.CONFLICT,
      );
    }
    if (session.status === CheckoutStatus.OPEN) {
      const samePlan = row.checkoutPlan === plan && row.checkoutInterval === interval;
      if (samePlan && session.url && session.expires_at * 1000 - Date.now() > REUSE_MIN_REMAINING_MS) {
        return { url: session.url, sessionId: session.id, reused: true };
      }
      await this.stripe.call('checkout.sessions.expire', (s) => s.checkout.sessions.expire(sessionId));
    }
    await this.repo.clearCheckout(row.orgId, sessionId);
    return null;
  }
}
