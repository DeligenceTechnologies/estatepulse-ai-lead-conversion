import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { BillingInterval, SubscriptionPlan } from '@prisma/client';
import type Stripe from 'stripe';
import { AuditService } from '@/audit/audit.service';
import type { AuthContext } from '@/auth/auth.types';
import { AppError } from '@/common/errors/app-error';
import { BillingConfig } from '../billing.config';
import { BILLING_ERRORS, TERMINAL_STATUSES } from '../billing.constants';
import { BillingRepository, type SubscriptionRow } from '../billing.repository';
import { classifyPlanChange, PLANS } from '../billing-plans';
import { StripePriceService } from './stripe-price.service';
import { fromUnix, StripeService, stripeId } from './stripe.service';
import { SubscriptionSyncService } from './subscription-sync.service';

export interface PlanChangeResult {
  change: 'upgrade' | 'downgrade' | 'kept';
  /** When the new plan applies: now for an upgrade, the period end for a downgrade. */
  effectiveAt: string | null;
  /** The upgrade's prorated invoice needs the customer (3-D Secure, a declined card). */
  paymentRequired: boolean;
  /** Where to finish that payment. */
  invoiceUrl: string | null;
}

/**
 * Changing an existing subscription: upgrades, downgrades, cancelling and
 * undoing a cancellation. Every call goes to Stripe first and the row is
 * updated from Stripe's answer, so our state is always Stripe's.
 *
 *  - Upgrade: immediate, prorated and invoiced now. `pending_if_incomplete`
 *    keeps the old plan until that invoice is paid, so a failed card never
 *    unlocks the higher plan.
 *  - Downgrade: booked for the end of the period already paid for, as a
 *    subscription schedule; nothing is refunded and access stays until then.
 *  - Cancel: at period end; immediately only with BILLING_ALLOW_IMMEDIATE_CANCEL.
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
    if (plan === 'FREE') {
      throw new AppError(BILLING_ERRORS.INVALID_PLAN, 'To move to the free plan, cancel your subscription.');
    }
    const row = await this.liveRow(auth.organizationId);
    if (row.status === 'past_due' || row.status === 'unpaid' || row.status === 'incomplete') {
      throw new AppError(
        BILLING_ERRORS.PAYMENT_ISSUE,
        'Your last payment did not go through. Update your payment method in Manage billing before changing plans.',
        undefined,
        409,
      );
    }

    const change = classifyPlanChange({ plan: row.plan, interval: row.billingInterval }, { plan, interval });
    if (change === 'same') {
      if (row.pendingPlan) return this.keepCurrentPlan(auth, row);
      throw new AppError(BILLING_ERRORS.ALREADY_ON_PLAN, `You are already on ${PLANS[plan].name} (${interval.toLowerCase()}).`, undefined, 409);
    }

    const priceId = await this.prices.verifiedPriceId(plan, interval);
    const sub = await this.retrieve(row.stripeSubscriptionId!);
    const item = sub.items.data[0];
    if (!item) throw new Error(`Stripe subscription ${sub.id} has no items`);

    const result =
      change === 'upgrade'
        ? await this.upgrade(sub, item, priceId)
        : await this.scheduleDowngrade(row, sub, item, priceId, plan, interval);

    await this.audit.record({
      orgId: auth.organizationId,
      actorType: 'user',
      actorId: auth.userId,
      action: change === 'upgrade' ? 'billing.plan_upgraded' : 'billing.plan_downgrade_scheduled',
      entityType: 'subscription',
      entityId: row.id,
      payload: {
        from: { plan: row.plan, interval: row.billingInterval },
        to: { plan, interval },
        effectiveAt: result.effectiveAt,
        paymentRequired: result.paymentRequired,
      },
    });
    return result;
  }

  async cancel(auth: AuthContext, immediately: boolean): Promise<{ cancelAtPeriodEnd: boolean; endsAt: string | null }> {
    const row = await this.liveRow(auth.organizationId);
    if (immediately && !this.config.allowImmediateCancel) {
      throw new AppError(
        BILLING_ERRORS.IMMEDIATE_CANCEL_DISABLED,
        'Subscriptions end at the close of the period already paid for. Immediate cancellation is not available.',
      );
    }
    const subscriptionId = row.stripeSubscriptionId!;
    // A booked downgrade is dropped: the subscription is ending instead.
    await this.releaseSchedule(row.stripeScheduleId);

    const sub = immediately
      ? await this.stripe.call('subscriptions.cancel', (s) => s.subscriptions.cancel(subscriptionId, { prorate: false, invoice_now: false }))
      : await this.stripe.call('subscriptions.update', (s) => s.subscriptions.update(subscriptionId, { cancel_at_period_end: true }));
    await this.sync.applySubscription(sub);

    const endsAt = immediately ? fromUnix(sub.ended_at ?? sub.canceled_at) : fromUnix(sub.items.data[0]?.current_period_end);
    await this.audit.record({
      orgId: auth.organizationId,
      actorType: 'user',
      actorId: auth.userId,
      action: immediately ? 'billing.canceled_immediately' : 'billing.cancel_scheduled',
      entityType: 'subscription',
      entityId: row.id,
      payload: { plan: row.plan, endsAt: endsAt?.toISOString() ?? null },
    });
    return { cancelAtPeriodEnd: !immediately, endsAt: endsAt?.toISOString() ?? null };
  }

  async reactivate(auth: AuthContext): Promise<{ reactivated: true }> {
    const row = await this.liveRow(auth.organizationId);
    if (!row.cancelAtPeriodEnd) {
      throw new AppError(BILLING_ERRORS.NOT_CANCELING, 'Your subscription is not set to cancel.', undefined, 409);
    }
    const subscriptionId = row.stripeSubscriptionId!;
    const sub = await this.stripe.call('subscriptions.update', (s) =>
      s.subscriptions.update(subscriptionId, { cancel_at_period_end: false, cancel_at: '' }),
    );
    await this.sync.applySubscription(sub);
    await this.audit.record({
      orgId: auth.organizationId,
      actorType: 'user',
      actorId: auth.userId,
      action: 'billing.reactivated',
      entityType: 'subscription',
      entityId: row.id,
      payload: { plan: row.plan },
    });
    return { reactivated: true };
  }

  // -------------------------------------------------------------------------

  /** The organization's subscription, which must be one Stripe still bills. */
  private async liveRow(orgId: string): Promise<SubscriptionRow> {
    const row = await this.repo.findByOrg(orgId);
    if (!row?.stripeSubscriptionId || TERMINAL_STATUSES.includes(row.status)) {
      throw new AppError(BILLING_ERRORS.NO_SUBSCRIPTION, 'Your organization has no active subscription.', undefined, 409);
    }
    return row;
  }

  private retrieve(subscriptionId: string): Promise<Stripe.Subscription> {
    return this.stripe.call('subscriptions.retrieve', (s) => s.subscriptions.retrieve(subscriptionId));
  }

  private async upgrade(sub: Stripe.Subscription, item: Stripe.SubscriptionItem, priceId: string): Promise<PlanChangeResult> {
    // An upgrade replaces any downgrade that was booked.
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
      change: 'upgrade',
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
    const periodStart = item.current_period_start;
    const periodEnd = item.current_period_end;
    const existing = stripeId(sub.schedule);
    const scheduleId =
      existing ??
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
          // What they have now, to the end of what they paid for…
          { items: [{ price: item.price.id, quantity: item.quantity ?? 1 }], start_date: periodStart, end_date: periodEnd },
          // …then the lower plan, after which the schedule lets go of the subscription.
          {
            items: [{ price: priceId, quantity: 1 }],
            duration: { interval: interval === 'YEARLY' ? 'year' : 'month', interval_count: 1 },
            proration_behavior: 'none',
          },
        ],
      }),
    );

    const effectiveAt = new Date(periodEnd * 1000);
    await this.repo.update(row.orgId, {
      pendingPlan: plan,
      pendingInterval: interval,
      pendingChangeAt: effectiveAt,
      stripeScheduleId: scheduleId,
    });
    return { change: 'downgrade', effectiveAt: effectiveAt.toISOString(), paymentRequired: false, invoiceUrl: null };
  }

  /** Choosing the current plan while a downgrade is booked keeps the current plan. */
  private async keepCurrentPlan(auth: AuthContext, row: SubscriptionRow): Promise<PlanChangeResult> {
    await this.releaseSchedule(row.stripeScheduleId);
    await this.repo.update(row.orgId, { pendingPlan: null, pendingInterval: null, pendingChangeAt: null, stripeScheduleId: null });
    await this.audit.record({
      orgId: auth.organizationId,
      actorType: 'user',
      actorId: auth.userId,
      action: 'billing.plan_downgrade_canceled',
      entityType: 'subscription',
      entityId: row.id,
      payload: { kept: row.plan, dropped: row.pendingPlan },
    });
    return { change: 'kept', effectiveAt: null, paymentRequired: false, invoiceUrl: null };
  }

  /** Lets go of a schedule, keeping the subscription exactly as it is now. */
  private async releaseSchedule(scheduleId: string | null): Promise<void> {
    if (!scheduleId) return;
    const schedule = await this.stripe.call('subscriptionSchedules.retrieve', (s) => s.subscriptionSchedules.retrieve(scheduleId));
    if (schedule.status === 'active' || schedule.status === 'not_started') {
      await this.stripe.call('subscriptionSchedules.release', (s) => s.subscriptionSchedules.release(scheduleId));
      this.logger.log(`Released subscription schedule ${scheduleId}`);
    }
  }
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 40);
