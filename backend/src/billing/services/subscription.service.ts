import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ActorType, SubscriptionPlan, SubscriptionStatus, type BillingInterval, type Prisma } from '@prisma/client';
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
  STRIPE_RECURRING_INTERVAL,
} from '../billing.constants';
import { BillingRepository, type SubscriptionRow } from '../billing.repository';
import { classifyPlanChange, PlanChange, PLANS } from '../billing-plans';
import { StripePriceService } from './stripe-price.service';
import { digest, fromUnix, StripeService, stripeId } from './stripe.service';
import { SubscriptionSyncService } from './subscription-sync.service';

/** What a change-plan request did. Values are sent to the client. */
export enum PlanChangeOutcome {
  UPGRADE = 'upgrade',
  DOWNGRADE = 'downgrade',
  /** A booked downgrade was dropped; the current plan stays. */
  KEPT = 'kept',
}

export interface PlanChangeResult {
  change: PlanChangeOutcome;
  effectiveAt: string | null;
  paymentRequired: boolean;
  invoiceUrl: string | null;
}

const PAYMENT_ISSUE_STATUSES: ReadonlySet<SubscriptionStatus> = new Set([
  SubscriptionStatus.past_due,
  SubscriptionStatus.unpaid,
  SubscriptionStatus.incomplete,
]);

/**
 * Upgrade: immediate, prorated, held as pending until paid.
 * Downgrade: scheduled for period end. Cancel: at period end unless immediate cancel is enabled.
 */
@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger('BillingSubscriptions');

  constructor(
    private readonly config: BillingConfig,
    private readonly stripe: StripeService,
    private readonly prices: StripePriceService,
    private readonly repo: BillingRepository,
    private readonly sync: SubscriptionSyncService,
    private readonly audit: AuditService,
  ) {}

  async changePlan(auth: AuthContext, plan: SubscriptionPlan, interval: BillingInterval): Promise<PlanChangeResult> {
    if (plan === SubscriptionPlan.FREE) throw new AppError(BillingErrorCode.INVALID_PLAN, 'To move to the free plan, cancel your subscription.');
    const row = await this.liveRow(auth.organizationId);
    if (PAYMENT_ISSUE_STATUSES.has(row.status)) {
      throw new AppError(
        BillingErrorCode.PAYMENT_ISSUE,
        'Your last payment did not go through. Update your payment method in Manage billing before changing plans.',
        undefined,
        HttpStatus.CONFLICT,
      );
    }

    const change = classifyPlanChange({ plan: row.plan, interval: row.billingInterval }, { plan, interval });
    if (change === PlanChange.SAME) {
      if (row.pendingPlan) return this.keepCurrentPlan(auth, row);
      throw new AppError(BillingErrorCode.ALREADY_ON_PLAN, `You are already on ${PLANS[plan].name} (${interval.toLowerCase()}).`, undefined, HttpStatus.CONFLICT);
    }

    const priceId = await this.prices.verifiedPriceId(plan, interval);
    const subscriptionId = row.stripeSubscriptionId!;
    const sub = await this.stripe.call('subscriptions.retrieve', (s) => s.subscriptions.retrieve(subscriptionId));
    const item = sub.items.data[0];
    if (!item) throw new Error(`Stripe subscription ${sub.id} has no items`);

    const result =
      change === PlanChange.UPGRADE ? await this.upgrade(sub, item, priceId) : await this.scheduleDowngrade(row, sub, item, priceId, plan, interval);

    await this.record(auth, row, change === PlanChange.UPGRADE ? BillingAuditAction.PLAN_UPGRADED : BillingAuditAction.PLAN_DOWNGRADE_SCHEDULED, {
      from: { plan: row.plan, interval: row.billingInterval },
      to: { plan, interval },
      effectiveAt: result.effectiveAt,
      paymentRequired: result.paymentRequired,
    });
    return result;
  }

  async cancel(auth: AuthContext, immediately: boolean): Promise<{ cancelAtPeriodEnd: boolean; endsAt: string | null }> {
    const row = await this.liveRow(auth.organizationId);
    if (immediately && !this.config.allowImmediateCancel) {
      throw new AppError(
        BillingErrorCode.IMMEDIATE_CANCEL_DISABLED,
        'Subscriptions end at the close of the period already paid for. Immediate cancellation is not available.',
      );
    }
    const id = row.stripeSubscriptionId!;
    await this.releaseSchedule(row.stripeScheduleId);

    const sub = immediately
      ? await this.stripe.call('subscriptions.cancel', (s) => s.subscriptions.cancel(id, { prorate: false, invoice_now: false }))
      : await this.stripe.call('subscriptions.update', (s) => s.subscriptions.update(id, { cancel_at_period_end: true }));
    await this.sync.applySubscription(sub);

    const endsAt = (immediately ? fromUnix(sub.ended_at ?? sub.canceled_at) : fromUnix(sub.items.data[0]?.current_period_end))?.toISOString() ?? null;
    await this.record(auth, row, immediately ? BillingAuditAction.CANCELED_IMMEDIATELY : BillingAuditAction.CANCEL_SCHEDULED, { plan: row.plan, endsAt });
    return { cancelAtPeriodEnd: !immediately, endsAt };
  }

  async reactivate(auth: AuthContext): Promise<{ reactivated: true }> {
    const row = await this.liveRow(auth.organizationId);
    if (!row.cancelAtPeriodEnd) {
      throw new AppError(BillingErrorCode.NOT_CANCELING, 'Your subscription is not set to cancel.', undefined, HttpStatus.CONFLICT);
    }
    const id = row.stripeSubscriptionId!;
    const sub = await this.stripe.call('subscriptions.update', (s) => s.subscriptions.update(id, { cancel_at_period_end: false, cancel_at: '' }));
    await this.sync.applySubscription(sub);
    await this.record(auth, row, BillingAuditAction.REACTIVATED, { plan: row.plan });
    return { reactivated: true };
  }

  private async liveRow(orgId: string): Promise<SubscriptionRow> {
    const row = await this.repo.findByOrg(orgId);
    if (!row?.stripeSubscriptionId || isTerminal(row.status)) {
      throw new AppError(BillingErrorCode.NO_SUBSCRIPTION, 'Your organization has no active subscription.', undefined, HttpStatus.CONFLICT);
    }
    return row;
  }

  private record(auth: AuthContext, row: SubscriptionRow, action: BillingAuditAction, payload: Prisma.InputJsonObject) {
    return this.audit.record({
      orgId: auth.organizationId,
      actorType: ActorType.user,
      actorId: auth.userId,
      action,
      entityType: BILLING_AUDIT_ENTITY,
      entityId: row.id,
      payload,
    });
  }

  private async upgrade(sub: Stripe.Subscription, item: Stripe.SubscriptionItem, priceId: string): Promise<PlanChangeResult> {
    await this.releaseSchedule(stripeId(sub.schedule));
    const updated = await this.stripe.call('subscriptions.update', (s) =>
      s.subscriptions.update(
        sub.id,
        {
          items: [{ id: item.id, price: priceId, quantity: 1 }],
          proration_behavior: 'always_invoice',
          payment_behavior: 'pending_if_incomplete',
          expand: ['latest_invoice'],
        },
        { idempotencyKey: `upgrade:${digest(`${sub.id}:${item.price.id}:${priceId}`)}` },
      ),
    );
    await this.sync.applySubscription(updated);

    const paymentRequired = !!updated.pending_update;
    const invoice = typeof updated.latest_invoice === 'object' ? updated.latest_invoice : null;
    return {
      change: PlanChangeOutcome.UPGRADE,
      effectiveAt: paymentRequired ? null : new Date().toISOString(),
      paymentRequired,
      invoiceUrl: paymentRequired ? (invoice?.hosted_invoice_url ?? null) : null,
    };
  }

  private async scheduleDowngrade(
    row: SubscriptionRow,
    sub: Stripe.Subscription,
    item: Stripe.SubscriptionItem,
    priceId: string,
    plan: SubscriptionPlan,
    interval: BillingInterval,
  ): Promise<PlanChangeResult> {
    const { current_period_start: periodStart, current_period_end: periodEnd } = item;
    const scheduleId =
      stripeId(sub.schedule) ??
      (
        await this.stripe.call('subscriptionSchedules.create', (s) =>
          s.subscriptionSchedules.create(
            { from_subscription: sub.id },
            { idempotencyKey: `schedule:${digest(`${sub.id}:${periodEnd}:${priceId}`)}` },
          ),
        )
      ).id;

    await this.stripe.call('subscriptionSchedules.update', (s) =>
      s.subscriptionSchedules.update(scheduleId, {
        end_behavior: 'release',
        phases: [
          { items: [{ price: item.price.id, quantity: item.quantity ?? 1 }], start_date: periodStart, end_date: periodEnd },
          {
            items: [{ price: priceId, quantity: 1 }],
            duration: { interval: STRIPE_RECURRING_INTERVAL[interval], interval_count: 1 },
            proration_behavior: 'none',
          },
        ],
      }),
    );

    const effectiveAt = new Date(periodEnd * 1000);
    await this.repo.update(row.orgId, { pendingPlan: plan, pendingInterval: interval, pendingChangeAt: effectiveAt, stripeScheduleId: scheduleId });
    return { change: PlanChangeOutcome.DOWNGRADE, effectiveAt: effectiveAt.toISOString(), paymentRequired: false, invoiceUrl: null };
  }

  /** Re-selecting the current plan while a downgrade is booked cancels the downgrade. */
  private async keepCurrentPlan(auth: AuthContext, row: SubscriptionRow): Promise<PlanChangeResult> {
    await this.releaseSchedule(row.stripeScheduleId);
    await this.repo.update(row.orgId, { pendingPlan: null, pendingInterval: null, pendingChangeAt: null, stripeScheduleId: null });
    await this.record(auth, row, BillingAuditAction.PLAN_DOWNGRADE_CANCELED, { kept: row.plan, dropped: row.pendingPlan });
    return { change: PlanChangeOutcome.KEPT, effectiveAt: null, paymentRequired: false, invoiceUrl: null };
  }

  private async releaseSchedule(scheduleId: string | null): Promise<void> {
    if (!scheduleId) return;
    const schedule = await this.stripe.call('subscriptionSchedules.retrieve', (s) => s.subscriptionSchedules.retrieve(scheduleId));
    if (schedule.status === 'active' || schedule.status === 'not_started') {
      await this.stripe.call('subscriptionSchedules.release', (s) => s.subscriptionSchedules.release(scheduleId));
      this.logger.log(`Released subscription schedule ${scheduleId}`);
    }
  }
}
