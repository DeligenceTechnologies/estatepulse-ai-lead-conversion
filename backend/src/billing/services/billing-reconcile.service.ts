import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BillingConfig } from '../billing.config';
import { STALE_PROCESSING_MS } from '../billing.constants';
import { BillingRepository } from '../billing.repository';
import { StripeService } from './stripe.service';
import { StripeWebhookService, WebhookResultKind } from './stripe-webhook.service';
import { SubscriptionSyncService } from './subscription-sync.service';

const BATCH = 25;
const STALE_SUBSCRIPTION_MS = 24 * 60 * 60_000;

/** Webhook safety net: retries failed events and resyncs subscriptions not synced in 24h. Idempotent. */
@Injectable()
export class BillingReconcileService {
  private readonly logger = new Logger('BillingReconcile');
  private running = false;

  constructor(
    private readonly config: BillingConfig,
    private readonly stripe: StripeService,
    private readonly repo: BillingRepository,
    private readonly webhooks: StripeWebhookService,
    private readonly sync: SubscriptionSyncService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'billing-reconcile' })
  async tick(): Promise<void> {
    if (!this.config.reconcileEnabled || !this.stripe.configured || this.running) return;
    this.running = true;
    try {
      await this.retryEvents();
      await this.resyncStaleSubscriptions();
    } catch (error) {
      this.logger.warn(`Reconcile pass stopped: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  async retryEvents(): Promise<number> {
    const due = await this.repo.retryableEvents(new Date(Date.now() - STALE_PROCESSING_MS), BATCH);
    let done = 0;
    for (const { stripeEventId } of due) {
      try {
        const event = await this.stripe.call('events.retrieve', (s) => s.events.retrieve(stripeEventId));
        const result = await this.webhooks.process(event);
        if (result.kind !== WebhookResultKind.FAILED) done++;
      } catch (error) {
        this.logger.warn(`Retry of ${stripeEventId} failed: ${(error as Error).message}`);
      }
    }
    if (due.length) this.logger.log(`Retried ${due.length} billing event(s), ${done} settled`);
    return done;
  }

  async resyncStaleSubscriptions(): Promise<number> {
    const stale = await this.repo.staleSubscriptions(new Date(Date.now() - STALE_SUBSCRIPTION_MS), BATCH);
    let synced = 0;
    for (const { orgId, stripeSubscriptionId } of stale) {
      try {
        await this.sync.syncSubscriptionById(stripeSubscriptionId!);
        synced++;
      } catch (error) {
        this.logger.warn(`Resync of organization ${orgId} failed: ${(error as Error).message}`);
      }
    }
    return synced;
  }
}
