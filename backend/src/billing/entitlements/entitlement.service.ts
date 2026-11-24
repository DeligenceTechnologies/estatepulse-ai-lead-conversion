import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { BaseStatus, SubscriptionPlan, type Prisma, type SubscriptionStatus } from '@prisma/client';
import { httpError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { resolveAccess, type Access } from '../access-policy';
import { BillingConfig } from '../billing.config';
import { BillingErrorCode } from '../billing.constants';
import {
  FEATURE_LABELS,
  lowestPlanForMembers,
  lowestPlanWith,
  PLANS,
  type Feature,
  type PlanLimits,
} from '../billing-plans';

export interface Entitlements {
  subscribedPlan: SubscriptionPlan;
  status: SubscriptionStatus | null;
  access: Access;
  features: readonly Feature[];
  limits: PlanLimits;
  /** False while BILLING_ENFORCEMENT_ENABLED is off: blocks are only logged. */
  enforced: boolean;
}

type Db = Pick<PrismaService, 'subscription' | 'user'> | Prisma.TransactionClient;

/** Single source for "may this organization do X?". */
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
      subscribedPlan: sub?.plan ?? SubscriptionPlan.FREE,
      status: sub?.status ?? null,
      access,
      features: plan.features,
      limits: plan.limits,
      enforced: this.config.enforcementEnabled,
    };
  }

  async assertFeature(orgId: string, feature: Feature): Promise<void> {
    const entitlements = await this.get(orgId);
    if (entitlements.features.includes(feature)) return;
    const requiredPlan = lowestPlanWith(feature);
    const message = `${FEATURE_LABELS[feature]} needs the ${requiredPlan ? PLANS[requiredPlan].name : 'a higher'} plan.`;
    this.block(orgId, message, BillingErrorCode.PLAN_UPGRADE_REQUIRED, { feature, requiredPlan, currentPlan: entitlements.access.plan });
  }

  /** Blocks adding members past the plan limit; existing members are never removed. */
  async assertCanAddMembers(orgId: string, adding = 1, db: Db = this.prisma): Promise<void> {
    const entitlements = await this.get(orgId, db);
    const used = await db.user.count({ where: { orgId, status: BaseStatus.active } });
    const limit = entitlements.limits.maxMembers;
    if (used + adding <= limit) return;
    const requiredPlan = lowestPlanForMembers(used + adding);
    const message =
      `Your ${PLANS[entitlements.access.plan].name} plan allows ${limit} team member${limit === 1 ? '' : 's'}` +
      (requiredPlan ? `. Upgrade to ${PLANS[requiredPlan].name} to add more.` : '.');
    this.block(orgId, message, BillingErrorCode.PLAN_LIMIT_REACHED, {
      limit: 'maxMembers',
      used,
      max: limit,
      requiredPlan,
      currentPlan: entitlements.access.plan,
    });
  }

  private block(orgId: string, message: string, code: BillingErrorCode, details: Record<string, unknown>): void {
    if (!this.config.enforcementEnabled) {
      this.logger.warn(`[not enforced] organization ${orgId} would be blocked: ${message}`);
      return;
    }
    throw httpError(HttpStatus.FORBIDDEN, code, message, details);
  }
}
