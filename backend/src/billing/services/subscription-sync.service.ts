import { Injectable, Logger } from '@nestjs/common';
import { ActorType, PaymentStatus, SubscriptionStatus, type Prisma } from '@prisma/client';
import type Stripe from 'stripe';
import { AuditService } from '@/audit/audit.service';
import { BillingConfig } from '../billing.config';
import {
  BILLING_AUDIT_ENTITY,
  BillingAuditAction,
  InvoiceStatus,
  isTerminal,
  StripeEventType,
  StripeMetadataKey,
} from '../billing.constants';
import { BillingRepository, CLEARED_CHECKOUT, type SubscriptionRow } from '../billing.repository';
import { fromUnix, StripeService, stripeId } from './stripe.service';

/** Customer is not ours (e.g. another app on the same Stripe account). */
export class UnknownCustomerError extends Error {
  override name = 'UnknownCustomerError';
  constructor(customerId: string | null) {
    super(`No organization is billed as Stripe customer ${customerId ?? '(none)'}`);
  }
}

/** Stripe and our records disagree on the owner; never applied. */
export class TenantMismatchError extends Error {
  override name = 'TenantMismatchError';
}

const KNOWN_STATUSES: ReadonlySet<string> = new Set(Object.values(SubscriptionStatus));
/** Unknown future Stripe statuses get no paid access. */
const toStatus = (status: string): SubscriptionStatus => (KNOWN_STATUSES.has(status) ? (status as SubscriptionStatus) : SubscriptionStatus.incomplete);

export interface SyncResult {
  orgId: string;
  applied: boolean;
  skipped?: string;
}

/** Sole writer of plan/status: copies Stripe's current state into our rows. */
@Injectable()
export class SubscriptionSyncService {
  private readonly logger = new Logger('BillingSync');

  constructor(
    private readonly repo: BillingRepository,
    private readonly config: BillingConfig,
    private readonly stripe: StripeService,
    private readonly audit: AuditService,
  ) {}

  async rowForCustomer(customer: string | { id: string } | null, metadata?: Stripe.Metadata | null): Promise<SubscriptionRow> {
    const customerId = stripeId(customer);
    const row = customerId ? await this.repo.findByCustomerId(customerId) : null;
    if (!row) throw new UnknownCustomerError(customerId);
    const claimedOrg = metadata?.[StripeMetadataKey.ORGANIZATION_ID];
    if (claimedOrg && claimedOrg !== row.orgId) {
      throw new TenantMismatchError(`Customer ${customerId} belongs to ${row.orgId}, but the Stripe object names ${claimedOrg}`);
    }
    return row;
  }

  async syncSubscriptionById(subscriptionId: string, eventCreatedAt?: Date): Promise<SyncResult> {
    const sub = await this.stripe.call('subscriptions.retrieve', (s) => s.subscriptions.retrieve(subscriptionId));
    return this.applySubscription(sub, eventCreatedAt);
  }

  async applySubscription(sub: Stripe.Subscription, eventCreatedAt?: Date): Promise<SyncResult> {
    const row = await this.rowForCustomer(sub.customer, sub.metadata);
    const status = toStatus(sub.status);
    const isNewSubscription = row.stripeSubscriptionId !== sub.id;

    // A different subscription is adopted only when ours is over and the new one is live.
    if (row.stripeSubscriptionId && isNewSubscription) {
      const oursOver = isTerminal(row.status);
      const theirsOver = isTerminal(status);
      if (!oursOver || theirsOver) {
        if (!oursOver && !theirsOver) {
          this.logger.error(`Organization ${row.orgId} has a second live subscription ${sub.id} besides ${row.stripeSubscriptionId}; review in Stripe`);
        }
        return { orgId: row.orgId, applied: false, skipped: 'not the current subscription' };
      }
    }

    const item = sub.items.data[0];
    const priceId = item?.price.id ?? null;
    const ref = priceId ? this.config.priceRef(priceId) : undefined;
    if (!ref && !isTerminal(status)) {
      throw new Error(`Stripe subscription ${sub.id} is on Price ${priceId ?? '(none)'}, which no plan is configured with`);
    }

    const pendingStillAhead =
      !!sub.schedule && !!row.pendingPlan && !(ref && ref.plan === row.pendingPlan && ref.interval === row.pendingInterval);
    const newerEvent = eventCreatedAt && (!row.lastStripeEventAt || eventCreatedAt > row.lastStripeEventAt);

    const data: Prisma.SubscriptionUpdateInput = {
      stripeSubscriptionId: sub.id,
      stripePriceId: priceId,
      ...(ref && { plan: ref.plan, billingInterval: ref.interval }),
      status,
      currentPeriodStart: fromUnix(item?.current_period_start),
      currentPeriodEnd: fromUnix(item?.current_period_end),
      trialStart: fromUnix(sub.trial_start),
      trialEnd: fromUnix(sub.trial_end),
      cancelAtPeriodEnd: sub.cancel_at_period_end || (!!sub.cancel_at && !isTerminal(status)),
      canceledAt: fromUnix(sub.canceled_at),
      endedAt: fromUnix(sub.ended_at),
      pastDueSince: status === SubscriptionStatus.past_due ? (row.status === SubscriptionStatus.past_due && row.pastDueSince) || new Date() : null,
      stripeScheduleId: stripeId(sub.schedule),
      ...(!pendingStillAhead && { pendingPlan: null, pendingInterval: null, pendingChangeAt: null }),
      ...(isNewSubscription && CLEARED_CHECKOUT),
      ...(newerEvent && { lastStripeEventAt: eventCreatedAt }),
      syncedAt: new Date(),
    };
    await this.repo.update(row.orgId, data);

    const newPlan = ref?.plan ?? row.plan;
    if (row.plan !== newPlan || row.status !== status || isNewSubscription) {
      this.logger.log(`Organization ${row.orgId}: ${row.plan}/${row.status} → ${newPlan}/${status} (${sub.id})`);
      this.audit.quietly({
        orgId: row.orgId,
        actorType: ActorType.webhook,
        action: BillingAuditAction.SUBSCRIPTION_CHANGED,
        entityType: BILLING_AUDIT_ENTITY,
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

  async syncInvoiceById(invoiceId: string, eventType: string): Promise<SyncResult & { stripeSubscriptionId: string | null }> {
    const invoice = await this.stripe.call('invoices.retrieve', (s) =>
      s.invoices.retrieve(invoiceId, { expand: ['payments.data.payment.payment_intent'] }),
    );
    const details = invoice.parent?.subscription_details ?? null;
    const row = await this.rowForCustomer(invoice.customer, details?.metadata);
    const stripeSubscriptionId = stripeId(details?.subscription);
    const subscriptionRowId = stripeSubscriptionId && stripeSubscriptionId === row.stripeSubscriptionId ? row.id : null;
    const paidAt = fromUnix(invoice.status_transitions?.paid_at);

    await this.repo.upsertInvoice(invoice.id, {
      orgId: row.orgId,
      subscriptionId: subscriptionRowId,
      number: invoice.number,
      amountDue: invoice.amount_due,
      amountPaid: invoice.amount_paid,
      currency: invoice.currency,
      status: invoice.status ?? InvoiceStatus.DRAFT,
      invoiceUrl: invoice.hosted_invoice_url ?? null,
      invoicePdf: invoice.invoice_pdf ?? null,
      periodStart: fromUnix(invoice.period_start),
      periodEnd: fromUnix(invoice.period_end),
      dueDate: fromUnix(invoice.due_date),
      paidAt,
      issuedAt: fromUnix(invoice.created) ?? new Date(),
    });

    if (invoice.amount_due > 0 && invoice.status !== InvoiceStatus.DRAFT) {
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

    let status: PaymentStatus = PaymentStatus.pending;
    if (invoice.status === InvoiceStatus.PAID) status = PaymentStatus.succeeded;
    else if (eventType === StripeEventType.INVOICE_PAYMENT_FAILED) status = PaymentStatus.failed;
    else if (eventType === StripeEventType.INVOICE_PAYMENT_ACTION_REQUIRED || intentObj?.status === 'requires_action') {
      status = PaymentStatus.requires_action;
    }

    const existing = await this.repo.findPayment(invoice.id);
    // Success is final: a late failure event never overwrites it.
    if (existing?.status === PaymentStatus.succeeded && status !== PaymentStatus.succeeded) return;

    await this.repo.upsertPayment(invoice.id, {
      orgId: row.orgId,
      subscriptionId: subscriptionRowId,
      stripePaymentIntentId: stripeId(intent) ?? existing?.stripePaymentIntentId ?? null,
      amount: invoice.amount_due,
      currency: invoice.currency,
      status,
      paymentMethod: intentObj?.payment_method_types?.[0] ?? existing?.paymentMethod ?? null,
      failureReason: status === PaymentStatus.failed ? (intentObj?.last_payment_error?.message ?? 'The payment was declined.').slice(0, 500) : null,
      paidAt: status === PaymentStatus.succeeded ? (paidAt ?? new Date()) : null,
    });

    if (existing?.status !== status && (status === PaymentStatus.succeeded || status === PaymentStatus.failed)) {
      this.audit.quietly({
        orgId: row.orgId,
        actorType: ActorType.webhook,
        action: status === PaymentStatus.succeeded ? BillingAuditAction.PAYMENT_SUCCEEDED : BillingAuditAction.PAYMENT_FAILED,
        entityType: BILLING_AUDIT_ENTITY,
        entityId: row.id,
        payload: { stripeInvoiceId: invoice.id, amount: invoice.amount_due, currency: invoice.currency },
      });
    }
  }
}
