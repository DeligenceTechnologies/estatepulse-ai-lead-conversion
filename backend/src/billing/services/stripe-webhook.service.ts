import { Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { BillingConfig } from '../billing.config';
import { META } from '../billing.constants';
import { BillingRepository } from '../billing.repository';
import { fromUnix, StripeService, stripeId } from './stripe.service';
import { SubscriptionSyncService, TenantMismatchError, UnknownCustomerError } from './subscription-sync.service';
export type WebhookResult =
  | { kind: 'invalid_signature' }
  | { kind: 'not_configured' }
  | { kind: 'processed' | 'ignored' | 'duplicate'; eventId: string }
  /** Another worker holds it right now; Stripe should come back later. */
  | { kind: 'in_progress'; eventId: string }
  | { kind: 'failed'; eventId: string };

interface Outcome {
  status: 'processed' | 'ignored';
  orgId?: string | null;
  note?: string;
}

const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'customer.subscription.pending_update_applied',
  'customer.subscription.pending_update_expired',
  'customer.subscription.trial_will_end',
]);

const INVOICE_EVENTS = new Set([
  'invoice.paid',
  'invoice.payment_succeeded',
  'invoice.payment_failed',
  'invoice.finalized',
  'invoice.payment_action_required',
  'invoice.voided',
  'invoice.marked_uncollectible',
]);

/** Invoice events after which the subscription's own status may have moved. */
const INVOICE_EVENTS_THAT_MOVE_STATUS = new Set(['invoice.paid', 'invoice.payment_succeeded', 'invoice.payment_failed']);

/**
 * Stripe's webhook, end to end:
 *
 *  1. Verify the signature over the raw bytes; anything else is rejected.
 *  2. Store the event id (unique). A redelivery of a finished event is a no-op.
 *  3. Claim it, so two deliveries (or two servers) never process it at once.
 *  4. Re-read the object from Stripe and apply THAT, so events arriving late
 *     or out of order still leave Stripe's current state.
 *  5. Mark it processed / ignored, or failed with the reason. A failure answers
 *     500, Stripe redelivers, and the reconciler retries it too.
 *
 * Only ids are stored from the payload, never the customer's details.
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
    if (!this.config.webhookConfigured || !this.stripe.configured) return { kind: 'not_configured' };
    if (!signature) return { kind: 'invalid_signature' };

    let event: Stripe.Event;
    try {
      event = this.stripe.constructWebhookEvent(rawBody, signature);
    } catch (error) {
      if (error instanceof Stripe.errors.StripeSignatureVerificationError) {
        this.logger.warn('Rejected a webhook whose signature did not verify');
        return { kind: 'invalid_signature' };
      }
      throw error;
    }
    return this.process(event);
  }

  /** Steps 2–5, for a verified event (also used by the reconciler's retries). */
  async process(event: Stripe.Event): Promise<WebhookResult> {
    const { row } = await this.repo.recordEvent({
      stripeEventId: event.id,
      eventType: event.type,
      livemode: event.livemode,
      metadata: safeMetadata(event),
      stripeCreatedAt: new Date(event.created * 1000),
    });
    if (row.processingStatus === 'processed' || row.processingStatus === 'ignored') {
      return { kind: 'duplicate', eventId: event.id };
    }
    if (!(await this.repo.claimEvent(row.id))) {
      const again = await this.repo.recordEvent({
        stripeEventId: event.id,
        eventType: event.type,
        livemode: event.livemode,
        metadata: safeMetadata(event),
        stripeCreatedAt: new Date(event.created * 1000),
      });
      return again.row.processingStatus === 'processed' || again.row.processingStatus === 'ignored'
        ? { kind: 'duplicate', eventId: event.id }
        : { kind: 'in_progress', eventId: event.id };
    }

    try {
      const outcome = await this.dispatch(event);
      await this.repo.finishEvent(row.id, { status: outcome.status, orgId: outcome.orgId ?? null, error: outcome.note });
      if (outcome.status === 'ignored' && outcome.note) this.logger.log(`${event.type} ${event.id} ignored: ${outcome.note}`);
      return { kind: outcome.status, eventId: event.id };
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      this.logger.error(`${event.type} ${event.id} failed (attempt ${row.attempts + 1}): ${message}`);
      await this.repo.finishEvent(row.id, { status: 'failed', error: message }).catch((e) =>
        this.logger.error(`Could not record the failure of ${event.id}: ${(e as Error).message}`),
      );
      return { kind: 'failed', eventId: event.id };
    }
  }

  private async dispatch(event: Stripe.Event): Promise<Outcome> {
    if (event.livemode !== (this.config.mode === 'live')) {
      return { status: 'ignored', note: `${event.livemode ? 'live' : 'test'} event on a ${this.config.mode}-mode server` };
    }
    const created = new Date(event.created * 1000);
    try {
      if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
        return await this.checkoutCompleted(event.data.object as Stripe.Checkout.Session, created);
      }
      if (event.type === 'checkout.session.expired') {
        return await this.checkoutExpired(event.data.object as Stripe.Checkout.Session);
      }
      if (SUBSCRIPTION_EVENTS.has(event.type)) {
        const sub = event.data.object as Stripe.Subscription;
        const result = await this.sync.syncSubscriptionById(sub.id, created);
        return { status: result.applied ? 'processed' : 'ignored', orgId: result.orgId, note: result.skipped };
      }
      if (INVOICE_EVENTS.has(event.type)) {
        return await this.invoiceEvent(event.data.object as Stripe.Invoice, event.type, created);
      }
    } catch (error) {
      // Not ours: answered 200 so Stripe stops. A TenantMismatchError, by
      // contrast, propagates and leaves the event failed for someone to review.
      if (error instanceof UnknownCustomerError) return { status: 'ignored', note: error.message };
      throw error;
    }
    return { status: 'ignored', note: 'event type not handled' };
  }

  private async checkoutCompleted(session: Stripe.Checkout.Session, created: Date): Promise<Outcome> {
    if (session.mode !== 'subscription') return { status: 'ignored', note: 'not a subscription checkout' };
    const row = await this.sync.rowForCustomer(session.customer, session.metadata);
    if (session.client_reference_id && session.client_reference_id !== row.orgId) {
      throw new TenantMismatchError(`Checkout ${session.id} references organization ${session.client_reference_id}, customer belongs to ${row.orgId}`);
    }
    await this.repo.clearCheckout(row.orgId, session.id);
    const subscriptionId = stripeId(session.subscription);
    if (!subscriptionId) return { status: 'ignored', orgId: row.orgId, note: 'checkout has no subscription' };
    const result = await this.sync.syncSubscriptionById(subscriptionId, created);
    return { status: result.applied ? 'processed' : 'ignored', orgId: row.orgId, note: result.skipped };
  }

  private async checkoutExpired(session: Stripe.Checkout.Session): Promise<Outcome> {
    const row = await this.sync.rowForCustomer(session.customer, session.metadata);
    await this.repo.clearCheckout(row.orgId, session.id);
    return { status: 'processed', orgId: row.orgId };
  }

  private async invoiceEvent(invoice: Stripe.Invoice, type: string, created: Date): Promise<Outcome> {
    if (!invoice.id) return { status: 'ignored', note: 'invoice without an id' };
    const result = await this.sync.syncInvoiceById(invoice.id, type);
    // A paid invoice is how past_due recovers; a failed one how it starts.
    if (result.stripeSubscriptionId && INVOICE_EVENTS_THAT_MOVE_STATUS.has(type)) {
      await this.sync.syncSubscriptionById(result.stripeSubscriptionId, created);
    }
    return { status: 'processed', orgId: result.orgId };
  }
}

/** Ids and the claimed organization only: enough to trace an event, nothing personal. */
function safeMetadata(event: Stripe.Event): Record<string, string | null> {
  const object = event.data.object as unknown as Record<string, unknown>;
  const pick = (key: string): string | null => {
    const value = object[key];
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') return (value as { id: string }).id;
    return null;
  };
  const metadata = (object.metadata ?? null) as Record<string, string> | null;
  return {
    objectType: typeof object.object === 'string' ? object.object : null,
    objectId: pick('id'),
    customer: pick('customer'),
    subscription: pick('subscription'),
    claimedOrganizationId: metadata?.[META.ORGANIZATION_ID] ?? null,
    createdAt: fromUnix(event.created)?.toISOString() ?? null,
  };
}
