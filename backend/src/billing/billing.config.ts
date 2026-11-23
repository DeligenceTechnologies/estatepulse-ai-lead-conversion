import type { ConfigService } from '@nestjs/config';
import type { BillingInterval, SubscriptionPlan } from '@prisma/client';
import { INTERVALS, PAID_PLANS } from './billing-plans';

export type StripeMode = 'test' | 'live';

/** The env keys billing reads; validated in common/config/env.validation.ts. */
export interface BillingEnv {
  APP_URL?: string;
  STRIPE_MODE: StripeMode;
  STRIPE_SECRET_KEY?: string;
  STRIPE_PUBLISHABLE_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PORTAL_CONFIGURATION_ID?: string;
  STRIPE_AUTOMATIC_TAX: boolean;
  STRIPE_ALLOW_PROMOTION_CODES: boolean;
  STRIPE_STARTER_MONTHLY_PRICE_ID?: string;
  STRIPE_STARTER_YEARLY_PRICE_ID?: string;
  STRIPE_PROFESSIONAL_MONTHLY_PRICE_ID?: string;
  STRIPE_PROFESSIONAL_YEARLY_PRICE_ID?: string;
  STRIPE_BUSINESS_MONTHLY_PRICE_ID?: string;
  STRIPE_BUSINESS_YEARLY_PRICE_ID?: string;
  BILLING_CURRENCY: string;
  BILLING_SUCCESS_URL?: string;
  BILLING_CANCEL_URL?: string;
  BILLING_PORTAL_RETURN_URL?: string;
  BILLING_TRIAL_DAYS: number;
  BILLING_PAST_DUE_GRACE_DAYS: number;
  BILLING_ENFORCEMENT_ENABLED: boolean;
  BILLING_ALLOW_IMMEDIATE_CANCEL: boolean;
  BILLING_RECONCILE_ENABLED: boolean;
}

const ENV_KEYS: readonly (keyof BillingEnv)[] = [
  'APP_URL',
  'STRIPE_MODE',
  'STRIPE_SECRET_KEY',
  'STRIPE_PUBLISHABLE_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PORTAL_CONFIGURATION_ID',
  'STRIPE_AUTOMATIC_TAX',
  'STRIPE_ALLOW_PROMOTION_CODES',
  'STRIPE_STARTER_MONTHLY_PRICE_ID',
  'STRIPE_STARTER_YEARLY_PRICE_ID',
  'STRIPE_PROFESSIONAL_MONTHLY_PRICE_ID',
  'STRIPE_PROFESSIONAL_YEARLY_PRICE_ID',
  'STRIPE_BUSINESS_MONTHLY_PRICE_ID',
  'STRIPE_BUSINESS_YEARLY_PRICE_ID',
  'BILLING_CURRENCY',
  'BILLING_SUCCESS_URL',
  'BILLING_CANCEL_URL',
  'BILLING_PORTAL_RETURN_URL',
  'BILLING_TRIAL_DAYS',
  'BILLING_PAST_DUE_GRACE_DAYS',
  'BILLING_ENFORCEMENT_ENABLED',
  'BILLING_ALLOW_IMMEDIATE_CANCEL',
  'BILLING_RECONCILE_ENABLED',
];

export interface PriceRef {
  plan: SubscriptionPlan;
  interval: BillingInterval;
}

const DEFAULTS: Pick<
  BillingEnv,
  | 'STRIPE_MODE'
  | 'STRIPE_AUTOMATIC_TAX'
  | 'STRIPE_ALLOW_PROMOTION_CODES'
  | 'BILLING_CURRENCY'
  | 'BILLING_TRIAL_DAYS'
  | 'BILLING_PAST_DUE_GRACE_DAYS'
  | 'BILLING_ENFORCEMENT_ENABLED'
  | 'BILLING_ALLOW_IMMEDIATE_CANCEL'
  | 'BILLING_RECONCILE_ENABLED'
> = {
  STRIPE_MODE: 'test',
  STRIPE_AUTOMATIC_TAX: false,
  STRIPE_ALLOW_PROMOTION_CODES: false,
  BILLING_CURRENCY: 'inr',
  BILLING_TRIAL_DAYS: 0,
  BILLING_PAST_DUE_GRACE_DAYS: 7,
  BILLING_ENFORCEMENT_ENABLED: false,
  BILLING_ALLOW_IMMEDIATE_CANCEL: false,
  BILLING_RECONCILE_ENABLED: true,
};

const trimSlash = (url: string): string => url.replace(/\/+$/, '');

/**
 * Billing's view of the environment. Plain data, built once at boot — the
 * secret key is handed only to StripeService and never leaves this object
 * otherwise (nothing here is serialised into a response).
 */
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
  readonly publishableKey?: string;
  readonly successUrl?: string;
  readonly cancelUrl?: string;
  readonly portalReturnUrl?: string;

  private readonly secretKey?: string;
  private readonly webhookSecret?: string;
  private readonly priceIds = new Map<string, string>();
  private readonly priceRefs = new Map<string, PriceRef>();

  constructor(env: Partial<BillingEnv>) {
    const e = { ...DEFAULTS, ...stripUndefined(env) };
    this.mode = e.STRIPE_MODE;
    this.currency = e.BILLING_CURRENCY.toLowerCase();
    this.trialDays = e.BILLING_TRIAL_DAYS;
    this.pastDueGraceDays = e.BILLING_PAST_DUE_GRACE_DAYS;
    this.enforcementEnabled = e.BILLING_ENFORCEMENT_ENABLED;
    this.allowImmediateCancel = e.BILLING_ALLOW_IMMEDIATE_CANCEL;
    this.reconcileEnabled = e.BILLING_RECONCILE_ENABLED;
    this.automaticTax = e.STRIPE_AUTOMATIC_TAX;
    this.allowPromotionCodes = e.STRIPE_ALLOW_PROMOTION_CODES;
    this.portalConfigurationId = e.STRIPE_PORTAL_CONFIGURATION_ID || undefined;
    this.publishableKey = e.STRIPE_PUBLISHABLE_KEY || undefined;
    this.secretKey = e.STRIPE_SECRET_KEY || undefined;
    this.webhookSecret = e.STRIPE_WEBHOOK_SECRET || undefined;

    const appUrl = e.APP_URL ? trimSlash(e.APP_URL) : undefined;
    this.successUrl = e.BILLING_SUCCESS_URL || (appUrl && `${appUrl}/billing/success`);
    this.cancelUrl = e.BILLING_CANCEL_URL || (appUrl && `${appUrl}/billing/cancel`);
    this.portalReturnUrl = e.BILLING_PORTAL_RETURN_URL || (appUrl && `${appUrl}/settings?tab=billing`);

    for (const plan of PAID_PLANS) {
      for (const interval of INTERVALS) {
        const id = e[`STRIPE_${plan}_${interval}_PRICE_ID` as keyof BillingEnv] as string | undefined;
        if (!id) continue;
        if (this.priceRefs.has(id)) {
          throw new Error(`Billing config: the Stripe Price ${id} is configured for more than one plan/interval`);
        }
        this.priceIds.set(`${plan}:${interval}`, id);
        this.priceRefs.set(id, { plan, interval });
      }
    }
  }

  static fromConfigService(config: ConfigService): BillingConfig {
    const env: Partial<BillingEnv> = {};
    for (const key of ENV_KEYS) {
      (env as Record<string, unknown>)[key] = config.get(key);
    }
    return new BillingConfig(env);
  }

  /** The secret key is configured; Stripe calls can be made. */
  get stripeConfigured(): boolean {
    return !!this.secretKey;
  }

  get webhookConfigured(): boolean {
    return !!this.secretKey && !!this.webhookSecret;
  }

  /** Only StripeService reads these. */
  stripeSecretKey(): string | undefined {
    return this.secretKey;
  }

  stripeWebhookSecret(): string | undefined {
    return this.webhookSecret;
  }

  priceIdFor(plan: SubscriptionPlan, interval: BillingInterval): string | undefined {
    return this.priceIds.get(`${plan}:${interval}`);
  }

  /** Which plan/interval a Stripe Price is; undefined for one we did not configure. */
  priceRef(priceId: string): PriceRef | undefined {
    return this.priceRefs.get(priceId);
  }

  checkoutAvailable(plan: SubscriptionPlan, interval: BillingInterval): boolean {
    return this.stripeConfigured && !!this.successUrl && !!this.cancelUrl && !!this.priceIdFor(plan, interval);
  }
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== '')) as Partial<T>;
}
