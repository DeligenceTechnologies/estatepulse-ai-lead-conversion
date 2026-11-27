import { BillingInterval, SubscriptionStatus } from '@prisma/client';

/** Error codes returned to the client in `{ error: { code } }`. Values are part of the API contract. */
export enum BillingErrorCode {
  NOT_CONFIGURED = 'BILLING_NOT_CONFIGURED',
  PRICE_MISMATCH = 'BILLING_PRICE_MISMATCH',
  PROVIDER_ERROR = 'BILLING_PROVIDER_ERROR',
  PAYMENT_FAILED = 'PAYMENT_FAILED',
  INVALID_PLAN = 'BILLING_INVALID_PLAN',
  SUBSCRIPTION_EXISTS = 'SUBSCRIPTION_EXISTS',
  SUBSCRIPTION_PENDING = 'SUBSCRIPTION_PENDING',
  NO_SUBSCRIPTION = 'NO_ACTIVE_SUBSCRIPTION',
  NO_BILLING_ACCOUNT = 'NO_BILLING_ACCOUNT',
  ALREADY_ON_PLAN = 'ALREADY_ON_PLAN',
  PAYMENT_ISSUE = 'SUBSCRIPTION_PAYMENT_ISSUE',
  IMMEDIATE_CANCEL_DISABLED = 'IMMEDIATE_CANCEL_DISABLED',
  NOT_CANCELING = 'SUBSCRIPTION_NOT_CANCELING',
  PLAN_UPGRADE_REQUIRED = 'PLAN_UPGRADE_REQUIRED',
  PLAN_LIMIT_REACHED = 'PLAN_LIMIT_REACHED',
}

/** Keys we write into Stripe object metadata. */
export enum StripeMetadataKey {
  ORGANIZATION_ID = 'organizationId',
  SUBSCRIPTION_ROW_ID = 'subscriptionRowId',
  PLAN = 'plan',
  INTERVAL = 'interval',
}

export enum StripeMode {
  TEST = 'test',
  LIVE = 'live',
}

/** Stripe webhook event types the billing module acts on. */
export enum StripeEventType {
  CHECKOUT_SESSION_COMPLETED = 'checkout.session.completed',
  CHECKOUT_SESSION_ASYNC_PAYMENT_SUCCEEDED = 'checkout.session.async_payment_succeeded',
  CHECKOUT_SESSION_EXPIRED = 'checkout.session.expired',
  SUBSCRIPTION_CREATED = 'customer.subscription.created',
  SUBSCRIPTION_UPDATED = 'customer.subscription.updated',
  SUBSCRIPTION_DELETED = 'customer.subscription.deleted',
  SUBSCRIPTION_PAUSED = 'customer.subscription.paused',
  SUBSCRIPTION_RESUMED = 'customer.subscription.resumed',
  SUBSCRIPTION_PENDING_UPDATE_APPLIED = 'customer.subscription.pending_update_applied',
  SUBSCRIPTION_PENDING_UPDATE_EXPIRED = 'customer.subscription.pending_update_expired',
  SUBSCRIPTION_TRIAL_WILL_END = 'customer.subscription.trial_will_end',
  INVOICE_PAID = 'invoice.paid',
  INVOICE_PAYMENT_SUCCEEDED = 'invoice.payment_succeeded',
  INVOICE_PAYMENT_FAILED = 'invoice.payment_failed',
  INVOICE_FINALIZED = 'invoice.finalized',
  INVOICE_PAYMENT_ACTION_REQUIRED = 'invoice.payment_action_required',
  INVOICE_VOIDED = 'invoice.voided',
  INVOICE_MARKED_UNCOLLECTIBLE = 'invoice.marked_uncollectible',
}

/** Audit-log actions written by the billing module. */
export enum BillingAuditAction {
  CHECKOUT_STARTED = 'billing.checkout_started',
  PORTAL_OPENED = 'billing.portal_opened',
  PLAN_UPGRADED = 'billing.plan_upgraded',
  PLAN_DOWNGRADE_SCHEDULED = 'billing.plan_downgrade_scheduled',
  PLAN_DOWNGRADE_CANCELED = 'billing.plan_downgrade_canceled',
  CANCELED_IMMEDIATELY = 'billing.canceled_immediately',
  CANCEL_SCHEDULED = 'billing.cancel_scheduled',
  REACTIVATED = 'billing.reactivated',
  SUBSCRIPTION_CHANGED = 'billing.subscription_changed',
  PAYMENT_SUCCEEDED = 'billing.payment_succeeded',
  PAYMENT_FAILED = 'billing.payment_failed',
}

export const BILLING_AUDIT_ENTITY = 'subscription';

/** Stripe invoice statuses (stored as text on Invoice.status). */
export enum InvoiceStatus {
  DRAFT = 'draft',
  OPEN = 'open',
  PAID = 'paid',
  UNCOLLECTIBLE = 'uncollectible',
  VOID = 'void',
}

/** Subscription is over; a new checkout may start. */
export const TERMINAL_STATUSES: readonly SubscriptionStatus[] = [SubscriptionStatus.canceled, SubscriptionStatus.incomplete_expired];
export const PAID_ACCESS_STATUSES: readonly SubscriptionStatus[] = [SubscriptionStatus.active, SubscriptionStatus.trialing];

export const isTerminal = (status: SubscriptionStatus): boolean => TERMINAL_STATUSES.includes(status);

/** Our interval → Stripe's `recurring.interval`. */
export const STRIPE_RECURRING_INTERVAL: Readonly<Record<BillingInterval, 'month' | 'year'>> = {
  [BillingInterval.MONTHLY]: 'month',
  [BillingInterval.YEARLY]: 'year',
};

/** A webhook event stuck in `processing` this long is treated as crashed. */
export const STALE_PROCESSING_MS = 5 * 60_000;
export const MAX_EVENT_ATTEMPTS = 10;
