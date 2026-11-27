import { SubscriptionPlan, SubscriptionStatus } from '@prisma/client';
import { PAID_ACCESS_STATUSES } from './billing.constants';

export interface AccessInput {
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  pastDueSince: Date | null;
}

/** Why the organization has the access it has. Values are sent to the client. */
export enum AccessReason {
  FREE_PLAN = 'free_plan',
  PAID = 'paid',
  TRIAL = 'trial',
  PAST_DUE_GRACE = 'past_due_grace',
  PAST_DUE_EXPIRED = 'past_due_expired',
  UNPAID = 'unpaid',
  CANCELED = 'canceled',
  INCOMPLETE = 'incomplete',
  PAUSED = 'paused',
}

export interface Access {
  /** Plan whose features apply right now. */
  plan: SubscriptionPlan;
  reason: AccessReason;
  graceEndsAt?: Date;
}

const DAY_MS = 86_400_000;
const FREE_REASON: Partial<Record<SubscriptionStatus, AccessReason>> = {
  [SubscriptionStatus.unpaid]: AccessReason.UNPAID,
  [SubscriptionStatus.paused]: AccessReason.PAUSED,
  [SubscriptionStatus.incomplete]: AccessReason.INCOMPLETE,
};

/** active/trialing → paid plan; past_due → paid plan during grace; anything else → free. */
export function resolveAccess(sub: AccessInput | null, now: Date, graceDays: number): Access {
  if (!sub || sub.plan === SubscriptionPlan.FREE) return { plan: SubscriptionPlan.FREE, reason: AccessReason.FREE_PLAN };

  if (PAID_ACCESS_STATUSES.includes(sub.status)) {
    return { plan: sub.plan, reason: sub.status === SubscriptionStatus.trialing ? AccessReason.TRIAL : AccessReason.PAID };
  }
  if (sub.status === SubscriptionStatus.past_due) {
    const graceEndsAt = new Date((sub.pastDueSince ?? now).getTime() + graceDays * DAY_MS);
    return graceEndsAt > now
      ? { plan: sub.plan, reason: AccessReason.PAST_DUE_GRACE, graceEndsAt }
      : { plan: SubscriptionPlan.FREE, reason: AccessReason.PAST_DUE_EXPIRED, graceEndsAt };
  }
  return { plan: SubscriptionPlan.FREE, reason: FREE_REASON[sub.status] ?? AccessReason.CANCELED };
}
