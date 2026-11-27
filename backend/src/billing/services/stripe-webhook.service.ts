import { Injectable, Logger } from '@nestjs/common';
import { BillingEventStatus } from '@prisma/client';
import Stripe from 'stripe';
import { BillingConfig } from '../billing.config';
import { StripeEventType, StripeMetadataKey, StripeMode } from '../billing.constants';
import { BillingRepository } from '../billing.repository';
import { StripeService, stripeId } from './stripe.service';
import { SubscriptionSyncService, TenantMismatchError, UnknownCustomerError } from './subscription-sync.service';

export enum WebhookResultKind {
  PROCESSED = 'processed',
  IGNORED = 'ignored',
  DUPLICATE = 'duplicate',
  IN_PROGRESS = 'in_progress',
  FAILED = 'failed',
  INVALID_SIGNATURE = 'invalid_signature',
  NOT_CONFIGURED = 'not_configured',
}

export type WebhookResult =
  | { kind: WebhookResultKind.INVALID_SIGNATURE | WebhookResultKind.NOT_CONFIGURED }
  | {
      kind:
        | WebhookResultKind.PROCESSED
        | WebhookResultKind.IGNORED
        | WebhookResultKind.DUPLICATE
        | WebhookResultKind.IN_PROGRESS
        | WebhookResultKind.FAILED;
      eventId: string;
    };

type DoneStatus = typeof BillingEventStatus.processed | typeof BillingEventStatus.ignored;

interface Outcome {
  status: DoneStatus;
  orgId?: string | null;
  note?: string;
}

const CHECKOUT_COMPLETED: ReadonlySet<string> = new Set([
  StripeEventType.CHECKOUT_SESSION_COMPLETED,
  StripeEventType.CHECKOUT_SESSION_ASYNC_PAYMENT_SUCCEEDED,
]);

const SUBSCRIPTION_EVENTS: ReadonlySet<string> = new Set([
  StripeEventType.SUBSCRIPTION_CREATED,
  StripeEventType.SUBSCRIPTION_UPDATED,
  StripeEventType.SUBSCRIPTION_DELETED,
  StripeEventType.SUBSCRIPTION_PAUSED,
  StripeEventType.SUBSCRIPTION_RESUMED,
  StripeEventType.SUBSCRIPTION_PENDING_UPDATE_APPLIED,
  StripeEventType.SUBSCRIPTION_PENDING_UPDATE_EXPIRED,
  StripeEventType.SUBSCRIPTION_TRIAL_WILL_END,
]);

const INVOICE_EVENTS: ReadonlySet<string> = new Set([
  StripeEventType.INVOICE_PAID,
  StripeEventType.INVOICE_PAYMENT_SUCCEEDED,
  StripeEventType.INVOICE_PAYMENT_FAILED,
  StripeEventType.INVOICE_FINALIZED,
  StripeEventType.INVOICE_PAYMENT_ACTION_REQUIRED,
  StripeEventType.INVOICE_VOIDED,
  StripeEventType.INVOICE_MARKED_UNCOLLECTIBLE,
]);

/** Invoice events after which the subscription status may have changed. */
const STATUS_MOVING_INVOICE_EVENTS: ReadonlySet<string> = new Set([
  StripeEventType.INVOICE_PAID,
  StripeEventType.INVOICE_PAYMENT_SUCCEEDED,
  StripeEventType.INVOICE_PAYMENT_FAILED,
]);

const isDone = (status: BillingEventStatus): boolean =>
  status === BillingEventStatus.processed || status === BillingEventStatus.ignored;

const OUTCOME_KIND: Readonly<Record<DoneStatus, WebhookResultKind.PROCESSED | WebhookResultKind.IGNORED>> = {
  [BillingEventStatus.processed]: WebhookResultKind.PROCESSED,
  [BillingEventStatus.ignored]: WebhookResultKind.IGNORED,
};

const applied = (ok: boolean): DoneStatus => (ok ? BillingEventStatus.processed : BillingEventStatus.ignored);

/**
 * Verify signature → store event once → claim it → re-read the object from Stripe and apply it → mark result.
 * Failures return 500 so Stripe redelivers; the reconciler retries too.
 */
@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger('BillingWebhook');

  constructor(
    private readonly config: BillingConfig,
    private readonly stripe: StripeService,
    private readonly repo: BillingRepository,
    private readonly sync: SubscriptionSyncService,
  ) {}

  async receive(rawBody: Buffer, signature: string | undefined): Promise<WebhookResult> {
    if (!this.config.webhookConfigured || !this.stripe.configured) return { kind: WebhookResultKind.NOT_CONFIGURED };
    if (!signature) return { kind: WebhookResultKind.INVALID_SIGNATURE };
    try {
      return await this.process(this.stripe.constructWebhookEvent(rawBody, signature));
    } catch (error) {
      if (error instanceof Stripe.errors.StripeSignatureVerificationError) {
        this.logger.warn('Rejected a webhook whose signature did not verify');
        return { kind: WebhookResultKind.INVALID_SIGNATURE };
      }
      throw error;
    }
  }

  async process(event: Stripe.Event): Promise<WebhookResult> {
    const eventId = event.id;
    const row = await this.repo.recordEvent({
      stripeEventId: eventId,
      eventType: event.type,
      livemode: event.livemode,
      metadata: safeMetadata(event),
      stripeCreatedAt: new Date(event.created * 1000),
    });
    if (isDone(row.processingStatus)) return { kind: WebhookResultKind.DUPLICATE, eventId };
    if (!(await this.repo.claimEvent(row.id))) {
      const current = await this.repo.findEvent(row.id);
      return { kind: isDone(current.processingStatus) ? WebhookResultKind.DUPLICATE : WebhookResultKind.IN_PROGRESS, eventId };
    }

    try {
      const outcome = await this.dispatch(event);
      await this.repo.finishEvent(row.id, { status: outcome.status, orgId: outcome.orgId ?? null, error: outcome.note });
      if (outcome.status === BillingEventStatus.ignored && outcome.note) {
        this.logger.log(`${event.type} ${eventId} ignored: ${outcome.note}`);
      }
      return { kind: OUTCOME_KIND[outcome.status], eventId };
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      this.logger.error(`${event.type} ${eventId} failed (attempt ${row.attempts + 1}): ${message}`);
      await this.repo
        .finishEvent(row.id, { status: BillingEventStatus.failed, error: message })
        .catch((e) => this.logger.error(`Could not record failure of ${eventId}: ${(e as Error).message}`));
      return { kind: WebhookResultKind.FAILED, eventId };
    }
  }

  private async dispatch(event: Stripe.Event): Promise<Outcome> {
    const serverMode = this.config.mode;
    const eventMode = event.livemode ? StripeMode.LIVE : StripeMode.TEST;
    if (eventMode !== serverMode) {
      return { status: BillingEventStatus.ignored, note: `${eventMode} event on a ${serverMode}-mode server` };
    }
    const created = new Date(event.created * 1000);
    const object = event.data.object;
    try {
      if (CHECKOUT_COMPLETED.has(event.type)) return await this.checkoutCompleted(object as Stripe.Checkout.Session, created);
      if (event.type === StripeEventType.CHECKOUT_SESSION_EXPIRED) return await this.checkoutExpired(object as Stripe.Checkout.Session);
      if (SUBSCRIPTION_EVENTS.has(event.type)) {
        const result = await this.sync.syncSubscriptionById((object as Stripe.Subscription).id, created);
        return { status: applied(result.applied), orgId: result.orgId, note: result.skipped };
      }
      if (INVOICE_EVENTS.has(event.type)) return await this.invoiceEvent(object as Stripe.Invoice, event.type, created);
    } catch (error) {
      // Unknown customer → 200 so Stripe stops. TenantMismatchError propagates and stays failed for review.
      if (error instanceof UnknownCustomerError) return { status: BillingEventStatus.ignored, note: error.message };
      throw error;
    }
    return { status: BillingEventStatus.ignored, note: 'event type not handled' };
  }

  private async checkoutCompleted(session: Stripe.Checkout.Session, created: Date): Promise<Outcome> {
    if (session.mode !== 'subscription') return { status: BillingEventStatus.ignored, note: 'not a subscription checkout' };
    const row = await this.sync.rowForCustomer(session.customer, session.metadata);
    if (session.client_reference_id && session.client_reference_id !== row.orgId) {
      throw new TenantMismatchError(`Checkout ${session.id} references ${session.client_reference_id}, customer belongs to ${row.orgId}`);
    }
    await this.repo.clearCheckout(row.orgId, session.id);
    const subscriptionId = stripeId(session.subscription);
    if (!subscriptionId) return { status: BillingEventStatus.ignored, orgId: row.orgId, note: 'checkout has no subscription' };
    const result = await this.sync.syncSubscriptionById(subscriptionId, created);
    return { status: applied(result.applied), orgId: row.orgId, note: result.skipped };
  }

  private async checkoutExpired(session: Stripe.Checkout.Session): Promise<Outcome> {
    const row = await this.sync.rowForCustomer(session.customer, session.metadata);
    await this.repo.clearCheckout(row.orgId, session.id);
    return { status: BillingEventStatus.processed, orgId: row.orgId };
  }

  private async invoiceEvent(invoice: Stripe.Invoice, type: string, created: Date): Promise<Outcome> {
    if (!invoice.id) return { status: BillingEventStatus.ignored, note: 'invoice without an id' };
    const result = await this.sync.syncInvoiceById(invoice.id, type);
    if (result.stripeSubscriptionId && STATUS_MOVING_INVOICE_EVENTS.has(type)) {
      await this.sync.syncSubscriptionById(result.stripeSubscriptionId, created);
    }
    return { status: BillingEventStatus.processed, orgId: result.orgId };
  }
}

/** Only ids and the claimed org are stored, never customer details. */
function safeMetadata(event: Stripe.Event): Record<string, string | null> {
  const object = event.data.object as unknown as Record<string, unknown>;
  const pick = (key: string): string | null => {
    const value = object[key];
    if (typeof value === 'string') return value;
    const id = (value as { id?: unknown } | null)?.id;
    return typeof id === 'string' ? id : null;
  };
  const metadata = object.metadata as Record<string, string> | null | undefined;
  return {
    objectType: typeof object.object === 'string' ? object.object : null,
    objectId: pick('id'),
    customer: pick('customer'),
    subscription: pick('subscription'),
    claimedOrganizationId: metadata?.[StripeMetadataKey.ORGANIZATION_ID] ?? null,
    createdAt: new Date(event.created * 1000).toISOString(),
  };
}
