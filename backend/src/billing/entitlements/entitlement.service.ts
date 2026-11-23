import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, SubscriptionPlan, SubscriptionStatus } from '@prisma/client';
import { httpError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { resolveAccess, type Access } from '../access-policy';
import { BillingConfig } from '../billing.config';
import { BILLING_ERRORS } from '../billing.constants';
import {
  FEATURE_LABELS,
  lowestPlanForMembers,
  lowestPlanWith,
  PLANS,
  type Feature,
  type PlanLimits,
} from '../billing-plans';

export interface Entitlements {
  /** The plan on file (what they subscribed to). */
  subscribedPlan: SubscriptionPlan;
  status: SubscriptionStatus | null;
  /** The plan whose features apply now (see access-policy.ts). */
  access: Access;
  features: readonly Feature[];
  limits: PlanLimits;
  /** False while BILLING_ENFORCEMENT_ENABLED is off: limits are reported, not applied. */
  enforced: boolean;
}

type Db = Pick<PrismaService, 'subscription' | 'user'> | Prisma.TransactionClient;

/**
 * The single answer to "may this organization do X?". Plan definitions live in
 * billing-plans.ts and the status rules in access-policy.ts; nothing else in
 * the app compares plan names. Routes ask through @RequireFeature(); services
 * with a limit (members) call assert* directly.
 *
 * With enforcement off the checks still run and log what they would have
 * blocked, so a rollout can be watched before it is switched on.
 */
@Injectable()
export class EntitlementService {
  private readonly logger = new Logger('Entitlements');

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: BillingConfig,
  ) {}

  async get(orgId: string, db: Db = this.prisma): Promise<Entitlements> {
    const sub = await db.subscription.findUnique({
      where: { orgId },
      select: { plan: true, status: true, pastDueSince: true },
    });
    const access = resolveAccess(sub, new Date(), this.config.pastDueGraceDays);
    const plan = PLANS[access.plan];
    return {
      subscribedPlan: sub?.plan ?? 'FREE',
      status: sub?.status ?? null,
      access,
      features: plan.features,
      limits: plan.limits,
      enforced: this.config.enforcementEnabled,
    };
  }

  async hasFeature(orgId: string, feature: Feature): Promise<boolean> {
    return (await this.get(orgId)).features.includes(feature);
  }

  /** Throws PLAN_UPGRADE_REQUIRED (403) unless the plan includes the feature. */
  async assertFeature(orgId: string, feature: Feature): Promise<void> {
    const entitlements = await this.get(orgId);
    if (entitlements.features.includes(feature)) return;
    const requiredPlan = lowestPlanWith(feature);
    const message = `${FEATURE_LABELS[feature]} needs the ${requiredPlan ? PLANS[requiredPlan].name : 'a higher'} plan.`;
    this.block(orgId, message, BILLING_ERRORS.PLAN_UPGRADE_REQUIRED, { feature, requiredPlan, currentPlan: entitlements.access.plan });
  }

  /**
   * Throws PLAN_LIMIT_REACHED (403) when `adding` more active members would
   * pass the plan's limit. Existing members are never removed by a downgrade;
   * only adding is blocked.
   */
  async assertCanAddMembers(orgId: string, adding = 1, db: Db = this.prisma): Promise<void> {
    const entitlements = await this.get(orgId, db);
    const used = await db.user.count({ where: { orgId, status: 'active' } });
    const limit = entitlements.limits.maxMembers;
    if (used + adding <= limit) return;
    const requiredPlan = lowestPlanForMembers(used + adding);
    const message =
      `Your ${PLANS[entitlements.access.plan].name} plan allows ${limit} team member${limit === 1 ? '' : 's'}` +
      (requiredPlan ? `. Upgrade to ${PLANS[requiredPlan].name} to add more.` : '.');
    this.block(orgId, message, BILLING_ERRORS.PLAN_LIMIT_REACHED, {
      limit: 'maxMembers',
      used,
      max: limit,
      requiredPlan,
      currentPlan: entitlements.access.plan,
    });
  }

  private block(orgId: string, message: string, code: string, details: Record<string, unknown>): void {
    if (!this.config.enforcementEnabled) {
      this.logger.warn(`[not enforced] organization ${orgId} would be blocked: ${message}`);
      return;
    }
    throw httpError(403, code, message, details);
  }
}
