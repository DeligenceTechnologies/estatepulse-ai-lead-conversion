import type { ConfigService } from '@nestjs/config';
import type { BillingInterval, SubscriptionPlan } from '@prisma/client';
import { StripeMode } from './billing.constants';
import { INTERVALS, PAID_PLANS } from './billing-plans';

export interface PriceRef {
  plan: SubscriptionPlan;
  interval: BillingInterval;
}

type Getter = (key: string) => unknown;

const str = (get: Getter, key: string): string | undefined => {
  const value = get(key);
  return typeof value === 'string' && value !== '' ? value : undefined;
};
const bool = (get: Getter, key: string, fallback: boolean): boolean => {
  const value = get(key);
  return typeof value === 'boolean' ? value : fallback;
};
const num = (get: Getter, key: string, fallback: number): number => {
  const value = get(key);
  if (typeof value === 'number') return value;
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(+value) ? +value : fallback;
};

/** Billing settings, read once at boot (validated in common/config/env.validation.ts). */
export class BillingConfig {
  readonly mode: StripeMode;
  readonly currency: string;
  readonly trialDays: number;
  readonly pastDueGraceDays: number;
  readonly enforcementEnabled: boolean;
  readonly allowImmediateCancel: boolean;
  readonly reconcileEnabled: boolean;
  readonly automaticTax: boolean;
  readonly allowPromotionCodes: boolean;
  readonly portalConfigurationId?: string;
  readonly successUrl?: string;
  readonly cancelUrl?: string;
  readonly portalReturnUrl?: string;

  private readonly secretKey?: string;
  private readonly webhookSecret?: string;
  private readonly priceIds = new Map<string, string>();
  private readonly priceRefs = new Map<string, PriceRef>();

  constructor(get: Getter) {
    this.mode = str(get, 'STRIPE_MODE') === StripeMode.LIVE ? StripeMode.LIVE : StripeMode.TEST;
    this.currency = (str(get, 'BILLING_CURRENCY') ?? 'inr').toLowerCase();
    this.trialDays = num(get, 'BILLING_TRIAL_DAYS', 0);
    this.pastDueGraceDays = num(get, 'BILLING_PAST_DUE_GRACE_DAYS', 7);
    this.enforcementEnabled = bool(get, 'BILLING_ENFORCEMENT_ENABLED', false);
    this.allowImmediateCancel = bool(get, 'BILLING_ALLOW_IMMEDIATE_CANCEL', false);
    this.reconcileEnabled = bool(get, 'BILLING_RECONCILE_ENABLED', true);
    this.automaticTax = bool(get, 'STRIPE_AUTOMATIC_TAX', false);
    this.allowPromotionCodes = bool(get, 'STRIPE_ALLOW_PROMOTION_CODES', false);
    this.portalConfigurationId = str(get, 'STRIPE_PORTAL_CONFIGURATION_ID');
    this.secretKey = str(get, 'STRIPE_SECRET_KEY');
    this.webhookSecret = str(get, 'STRIPE_WEBHOOK_SECRET');

    const appUrl = str(get, 'APP_URL')?.replace(/\/+$/, '');
    this.successUrl = str(get, 'BILLING_SUCCESS_URL') ?? (appUrl && `${appUrl}/billing/success`);
    this.cancelUrl = str(get, 'BILLING_CANCEL_URL') ?? (appUrl && `${appUrl}/billing/cancel`);
    this.portalReturnUrl = str(get, 'BILLING_PORTAL_RETURN_URL') ?? (appUrl && `${appUrl}/settings?tab=billing`);

    for (const plan of PAID_PLANS) {
      for (const interval of INTERVALS) {
        const id = str(get, `STRIPE_${plan}_${interval}_PRICE_ID`);
        if (!id) continue;
        if (this.priceRefs.has(id)) {
          throw new Error(`Billing config: Stripe Price ${id} is configured for more than one plan/interval`);
        }
        this.priceIds.set(`${plan}:${interval}`, id);
        this.priceRefs.set(id, { plan, interval });
      }
    }
  }

  static fromConfigService(config: ConfigService): BillingConfig {
    return new BillingConfig((key) => config.get(key));
  }

  get stripeConfigured(): boolean {
    return !!this.secretKey;
  }

  get webhookConfigured(): boolean {
    return !!this.secretKey && !!this.webhookSecret;
  }

  stripeSecretKey(): string | undefined {
    return this.secretKey;
  }

  stripeWebhookSecret(): string | undefined {
    return this.webhookSecret;
  }

  priceIdFor(plan: SubscriptionPlan, interval: BillingInterval): string | undefined {
    return this.priceIds.get(`${plan}:${interval}`);
  }

  priceRef(priceId: string): PriceRef | undefined {
    return this.priceRefs.get(priceId);
  }

  checkoutAvailable(plan: SubscriptionPlan, interval: BillingInterval): boolean {
    return this.stripeConfigured && !!this.successUrl && !!this.cancelUrl && !!this.priceIdFor(plan, interval);
  }
}
