import { Injectable, Logger } from '@nestjs/common';
import type { PaymentStatus, Prisma, SubscriptionStatus } from '@prisma/client';
import type Stripe from 'stripe';
import { AuditService } from '@/audit/audit.service';
import { BillingConfig } from '../billing.config';
import { META, TERMINAL_STATUSES } from '../billing.constants';
import { BillingRepository, type SubscriptionRow } from '../billing.repository';
import { fromUnix, StripeService, stripeId } from './stripe.service';

/** The customer is not one of ours (another app on the same Stripe account). */
export class UnknownCustomerError extends Error {
  constructor(customerId: string | null) {
    super(`No organization is billed as Stripe customer ${customerId ?? '(none)'}`);
    this.name = 'UnknownCustomerError';
  }
}

/** Stripe and our records disagree on whose object this is: never applied. */
export class TenantMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantMismatchError';
  }
}

const STRIPE_STATUSES: readonly SubscriptionStatus[] = [
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'canceled',
  'incomplete',
  'incomplete_expired',
  'paused',
];

export interface SyncResult {
  orgId: string;
  applied: boolean;
  /** Why it was not applied (an older subscription's event, …). */
  skipped?: string;
}

export interface InvoiceSyncResult extends SyncResult {
  /** The invoice's subscription, as Stripe has it now. */
  stripeSubscriptionId: string | null;
}

/**
 * Copies Stripe's state into ours. Callers hand it objects fetched from Stripe
 * (webhook handlers re-read the subscription rather than trusting the event
 * body), so whatever order events arrive in, the row ends at Stripe's current
 * state. It is the only writer of plan and status.
 */
@Injectable()
export class SubscriptionSyncService {
  private readonly logger = new Logger('BillingSync');

  constructor(
    private readonly repo: BillingRepository,
    private readonly config: BillingConfig,
    private readonly stripe: StripeService,
    private readonly audit: AuditService,
  ) {}

  /** Our row for a Stripe customer, cross-checked against the object's metadata. */
  async rowForCustomer(customer: string | { id: string } | null, metadata?: Stripe.Metadata | null): Promise<SubscriptionRow> {
    const customerId = stripeId(customer);
    const row = customerId ? await this.repo.findByCustomerId(customerId) : null;
    if (!row) throw new UnknownCustomerError(customerId);
    const claimedOrg = metadata?.[META.ORGANIZATION_ID];
    if (claimedOrg && claimedOrg !== row.orgId) {
      throw new TenantMismatchError(
        `Stripe object for customer ${customerId} names organization ${claimedOrg}, but that customer belongs to ${row.orgId}`,
      );
    }
    return row;
  }

  /** Re-reads a subscription from Stripe and applies it. */
  async syncSubscriptionById(subscriptionId: string, eventCreatedAt?: Date): Promise<SyncResult> {
    const sub = await this.stripe.call('subscriptions.retrieve', (s) => s.subscriptions.retrieve(subscriptionId));
    return this.applySubscription(sub, eventCreatedAt);
  }

  async applySubscription(sub: Stripe.Subscription, eventCreatedAt?: Date): Promise<SyncResult> {
    const row = await this.rowForCustomer(sub.customer, sub.metadata);
    const status = toStatus(sub.status);

    // Another subscription than the one on file: only adopt it when ours is
    // over and this one is not, so a late event from an old, canceled
    // subscription can never overwrite the current one.
    if (row.stripeSubscriptionId && row.stripeSubscriptionId !== sub.id) {
      const ourIsOver = TERMINAL_STATUSES.includes(row.status);
      const theirsIsOver = TERMINAL_STATUSES.includes(status);
      if (!ourIsOver || theirsIsOver) {
        if (!ourIsOver && !theirsIsOver) {
          this.logger.error(
            `Organization ${row.orgId} has a second live Stripe subscription ${sub.id} besides ${row.stripeSubscriptionId}; it was not applied — review it in the Stripe Dashboard`,
          );
        }
        return { orgId: row.orgId, applied: false, skipped: 'not the current subscription' };
      }
    }

    const item = sub.items.data[0];
    const priceId = item?.price.id ?? null;
    const ref = priceId ? this.config.priceRef(priceId) : undefined;
    if (!ref && !TERMINAL_STATUSES.includes(status)) {
      // Granting or removing access on a Price we cannot place would be a guess.
      throw new Error(`Stripe subscription ${sub.id} is on Price ${priceId ?? '(none)'}, which no plan is configured with`);
    }

    const pendingStillAhead =
      !!sub.schedule && !!row.pendingPlan && !(ref && ref.plan === row.pendingPlan && ref.interval === row.pendingInterval);

    const data: Prisma.SubscriptionUpdateInput = {
      stripeSubscriptionId: sub.id,
      stripePriceId: priceId,
      ...(ref ? { plan: ref.plan, billingInterval: ref.interval } : {}),
      status,
      currentPeriodStart: fromUnix(item?.current_period_start),
      currentPeriodEnd: fromUnix(item?.current_period_end),
      trialStart: fromUnix(sub.trial_start),
      trialEnd: fromUnix(sub.trial_end),
      cancelAtPeriodEnd: sub.cancel_at_period_end || (!!sub.cancel_at && !TERMINAL_STATUSES.includes(status)),
      canceledAt: fromUnix(sub.canceled_at),
      endedAt: fromUnix(sub.ended_at),
      pastDueSince: status === 'past_due' ? (row.status === 'past_due' && row.pastDueSince ? row.pastDueSince : new Date()) : null,
      stripeScheduleId: stripeId(sub.schedule),
      ...(pendingStillAhead ? {} : { pendingPlan: null, pendingInterval: null, pendingChangeAt: null }),
      syncedAt: new Date(),
      ...(eventCreatedAt && (!row.lastStripeEventAt || eventCreatedAt > row.lastStripeEventAt)
        ? { lastStripeEventAt: eventCreatedAt }
        : {}),
    };
    // A subscription now exists: the Checkout that created it is done.
    if (row.stripeSubscriptionId !== sub.id) {
      Object.assign(data, { checkoutSessionId: null, checkoutPlan: null, checkoutInterval: null, checkoutExpiresAt: null });
    }

    await this.repo.update(row.orgId, data);

    const newPlan = ref?.plan ?? row.plan;
    if (row.plan !== newPlan || row.status !== status || row.stripeSubscriptionId !== sub.id) {
      this.logger.log(`Organization ${row.orgId}: ${row.plan}/${row.status} → ${newPlan}/${status} (${sub.id})`);
      this.audit.quietly({
        orgId: row.orgId,
        actorType: 'webhook',
        action: 'billing.subscription_changed',
        entityType: 'subscription',
        entityId: row.id,
        payload: {
          from: { plan: row.plan, status: row.status },
          to: { plan: newPlan, status, interval: ref?.interval ?? null },
          stripeSubscriptionId: sub.id,
        },
      });
    }
    return { orgId: row.orgId, applied: true };
  }

  /** Re-reads an invoice (with its payment) and stores it. */
  async syncInvoiceById(invoiceId: string, eventType: string): Promise<InvoiceSyncResult> {
    const invoice = await this.stripe.call('invoices.retrieve', (s) =>
      s.invoices.retrieve(invoiceId, { expand: ['payments.data.payment.payment_intent'] }),
    );
    return this.applyInvoice(invoice, eventType);
  }

  async applyInvoice(invoice: Stripe.Invoice, eventType: string): Promise<InvoiceSyncResult> {
    const subscriptionDetails = invoice.parent?.subscription_details ?? null;
    const row = await this.rowForCustomer(invoice.customer, subscriptionDetails?.metadata);
    const stripeSubscriptionId = stripeId(subscriptionDetails?.subscription);
    const subscriptionRowId = stripeSubscriptionId && stripeSubscriptionId === row.stripeSubscriptionId ? row.id : null;
    const paidAt = fromUnix(invoice.status_transitions?.paid_at);

    await this.repo.upsertInvoice(invoice.id, {
      orgId: row.orgId,
      subscriptionId: subscriptionRowId,
      number: invoice.number,
      amountDue: invoice.amount_due,
      amountPaid: invoice.amount_paid,
      currency: invoice.currency,
      status: invoice.status ?? 'draft',
      invoiceUrl: invoice.hosted_invoice_url ?? null,
      invoicePdf: invoice.invoice_pdf ?? null,
      periodStart: fromUnix(invoice.period_start),
      periodEnd: fromUnix(invoice.period_end),
      dueDate: fromUnix(invoice.due_date),
      paidAt,
      issuedAt: fromUnix(invoice.created) ?? new Date(),
    });

    if (invoice.amount_due > 0 && invoice.status !== 'draft') {
      await this.recordPayment(row, invoice, eventType, subscriptionRowId, paidAt);
    }
    return { orgId: row.orgId, applied: true, stripeSubscriptionId };
  }

  private async recordPayment(
    row: SubscriptionRow,
    invoice: Stripe.Invoice,
    eventType: string,
    subscriptionRowId: string | null,
    paidAt: Date | null,
  ): Promise<void> {
    const payment = invoice.payments?.data.find((p) => p.is_default) ?? invoice.payments?.data[0];
    const intent = payment?.payment.payment_intent;
    const intentObj = intent && typeof intent !== 'string' ? intent : null;

    let status: PaymentStatus;
    if (invoice.status === 'paid') status = 'succeeded';
    else if (eventType === 'invoice.payment_failed') status = 'failed';
    else if (eventType === 'invoice.payment_action_required' || intentObj?.status === 'requires_action') status = 'requires_action';
    else status = 'pending';

    const existing = await this.repo.findPayment(invoice.id);
    // A success is final: a late failure event for an invoice that was then paid changes nothing.
    if (existing?.status === 'succeeded' && status !== 'succeeded') return;

    await this.repo.upsertPayment(invoice.id, {
      orgId: row.orgId,
      subscriptionId: subscriptionRowId,
      stripePaymentIntentId: stripeId(intent) ?? existing?.stripePaymentIntentId ?? null,
      amount: invoice.amount_due,
      currency: invoice.currency,
      status,
      paymentMethod: intentObj?.payment_method_types?.[0] ?? existing?.paymentMethod ?? null,
      failureReason: status === 'failed' ? (intentObj?.last_payment_error?.message ?? 'The payment was declined.').slice(0, 500) : null,
      paidAt: status === 'succeeded' ? (paidAt ?? new Date()) : null,
    });

    if (existing?.status !== status && (status === 'succeeded' || status === 'failed')) {
      this.audit.quietly({
        orgId: row.orgId,
        actorType: 'webhook',
        action: status === 'succeeded' ? 'billing.payment_succeeded' : 'billing.payment_failed',
        entityType: 'subscription',
        entityId: row.id,
        payload: { stripeInvoiceId: invoice.id, amount: invoice.amount_due, currency: invoice.currency },
      });
    }
  }
}

function toStatus(status: Stripe.Subscription.Status): SubscriptionStatus {
  if ((STRIPE_STATUSES as readonly string[]).includes(status)) return status as SubscriptionStatus;
  // A status this code predates: treat it as no paid access until mapped.
  return 'incomplete';
}
