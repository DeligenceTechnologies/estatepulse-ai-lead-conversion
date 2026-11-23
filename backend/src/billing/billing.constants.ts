import type { SubscriptionStatus } from '@prisma/client';

/** Error codes the frontend branches on (`{ error: { code } }`). */
export const BILLING_ERRORS = {
  NOT_CONFIGURED: 'BILLING_NOT_CONFIGURED',
  PRICE_MISMATCH: 'BILLING_PRICE_MISMATCH',
  PROVIDER_ERROR: 'BILLING_PROVIDER_ERROR',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  INVALID_PLAN: 'BILLING_INVALID_PLAN',
  SUBSCRIPTION_EXISTS: 'SUBSCRIPTION_EXISTS',
  SUBSCRIPTION_PENDING: 'SUBSCRIPTION_PENDING',
  NO_SUBSCRIPTION: 'NO_ACTIVE_SUBSCRIPTION',
  NO_BILLING_ACCOUNT: 'NO_BILLING_ACCOUNT',
  ALREADY_ON_PLAN: 'ALREADY_ON_PLAN',
  PAYMENT_ISSUE: 'SUBSCRIPTION_PAYMENT_ISSUE',
  IMMEDIATE_CANCEL_DISABLED: 'IMMEDIATE_CANCEL_DISABLED',
  NOT_CANCELING: 'SUBSCRIPTION_NOT_CANCELING',
  PLAN_UPGRADE_REQUIRED: 'PLAN_UPGRADE_REQUIRED',
  PLAN_LIMIT_REACHED: 'PLAN_LIMIT_REACHED',
} as const;

/** A subscription in one of these is over: a new checkout may start. */
export const TERMINAL_STATUSES: readonly SubscriptionStatus[] = ['canceled', 'incomplete_expired'];

/** Stripe statuses that keep paid features (past_due only within the grace period). */
export const PAID_ACCESS_STATUSES: readonly SubscriptionStatus[] = ['active', 'trialing'];

/** Metadata keys put on Stripe objects; read back to cross-check webhooks. */
export const META = {
  ORGANIZATION_ID: 'organizationId',
  SUBSCRIPTION_ROW_ID: 'subscriptionRowId',
  PLAN: 'plan',
  INTERVAL: 'interval',
} as const;

/** A claimed webhook event still `processing` after this long is assumed crashed. */
export const STALE_PROCESSING_MS = 5 * 60_000;
/** Retries the reconciler makes before leaving an event for a human. */
export const MAX_EVENT_ATTEMPTS = 10;
