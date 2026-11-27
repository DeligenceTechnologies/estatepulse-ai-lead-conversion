import { Injectable } from '@nestjs/common';
import { SubscriptionPlan } from '@prisma/client';
import type { ListQuery } from '@/common/pagination/pagination.types';
import { BillingConfig } from './billing.config';
import { TERMINAL_STATUSES } from './billing.constants';
import { BillingRepository } from './billing.repository';
import {
  Feature,
  FEATURE_LABELS,
  INTERVALS,
  lowestPlanForMembers,
  PLAN_ORDER,
  PLANS,
} from './billing-plans';
import { EntitlementService } from './entitlements/entitlement.service';

const iso = (date: Date | null | undefined): string | null => (date ? date.toISOString() : null);

@Injectable()
export class BillingService {
  constructor(
    private readonly config: BillingConfig,
    private readonly repo: BillingRepository,
    private readonly entitlements: EntitlementService,
  ) {}

  /** Public catalog; Stripe Price IDs never leave the server. */
  plans() {
    return {
      currency: this.config.currency,
      mode: this.config.mode,
      checkoutConfigured: this.config.stripeConfigured,
      features: Object.values(Feature).map((key) => ({ key, label: FEATURE_LABELS[key] })),
      plans: PLAN_ORDER.map((key) => {
        const plan = PLANS[key];
        return {
          key,
          name: plan.name,
          description: plan.description,
          recommended: plan.recommended ?? false,
          prices: plan.prices,
          checkoutAvailable: Object.fromEntries(
            INTERVALS.map((interval) => [interval, key !== SubscriptionPlan.FREE && this.config.checkoutAvailable(key, interval)]),
          ),
          features: plan.features,
          limits: plan.limits,
        };
      }),
    };
  }

  async subscription(orgId: string) {
    const [row, entitlements] = await Promise.all([this.repo.findByOrg(orgId), this.entitlements.get(orgId)]);
    const live = !!row?.stripeSubscriptionId && !TERMINAL_STATUSES.includes(row.status);
    return {
      plan: entitlements.access.plan,
      subscribedPlan: row?.plan ?? SubscriptionPlan.FREE,
      accessReason: entitlements.access.reason,
      graceEndsAt: iso(entitlements.access.graceEndsAt),
      status: row?.stripeSubscriptionId ? row.status : null,
      hasSubscription: live,
      hasBillingAccount: !!row?.stripeCustomerId,
      billingInterval: live ? row!.billingInterval : null,
      currentPeriodStart: live ? iso(row!.currentPeriodStart) : null,
      currentPeriodEnd: live ? iso(row!.currentPeriodEnd) : null,
      renewsAt: live && !row!.cancelAtPeriodEnd ? iso(row!.currentPeriodEnd) : null,
      trialEnd: live ? iso(row!.trialEnd) : null,
      cancelAtPeriodEnd: live ? row!.cancelAtPeriodEnd : false,
      canceledAt: iso(row?.canceledAt),
      endedAt: iso(row?.endedAt),
      pendingChange:
        live && row!.pendingPlan
          ? { plan: row!.pendingPlan, interval: row!.pendingInterval, effectiveAt: iso(row!.pendingChangeAt) }
          : null,
      checkoutPending: !!row?.checkoutSessionId && !!row.checkoutExpiresAt && row.checkoutExpiresAt > new Date(),
      features: entitlements.features,
      limits: entitlements.limits,
      enforced: entitlements.enforced,
      mode: this.config.mode,
      immediateCancelAllowed: this.config.allowImmediateCancel,
      lastSyncedAt: iso(row?.syncedAt),
    };
  }

  async usage(orgId: string) {
    const [entitlements, members] = await Promise.all([this.entitlements.get(orgId), this.repo.countActiveMembers(orgId)]);
    const max = entitlements.limits.maxMembers;
    const atLimit = members >= max;
    const recommended = atLimit ? lowestPlanForMembers(members + 1) : null;
    return {
      plan: entitlements.access.plan,
      enforced: entitlements.enforced,
      members: { used: members, limit: max, atLimit, overLimit: members > max },
      features: entitlements.features,
      upgradeRecommendation: recommended
        ? { plan: recommended, reason: `Your plan allows ${max} team member${max === 1 ? '' : 's'}.` }
        : null,
    };
  }

  invoices(orgId: string, query: ListQuery) {
    return this.repo.listInvoices(orgId, query);
  }
}
