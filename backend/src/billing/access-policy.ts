import type { SubscriptionPlan, SubscriptionStatus } from '@prisma/client';
import { PAID_ACCESS_STATUSES } from './billing.constants';

export interface AccessInput {
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  pastDueSince: Date | null;
}

export type AccessReason =
  | 'free_plan'
  | 'paid'
  | 'trial'
  | 'past_due_grace'
  | 'past_due_expired'
  | 'unpaid'
  | 'canceled'
  | 'incomplete'
  | 'paused';

export interface Access {
  /** The plan whose features and limits apply right now. */
  plan: SubscriptionPlan;
  reason: AccessReason;
  /** Past due: paid features end at this time unless the payment recovers. */
  graceEndsAt?: Date;
}

/**
 * What a subscription entitles the organization to, by status:
 *
 *  - trialing, active            → the plan they pay for (cancel-at-period-end
 *                                  stays active until the period ends)
 *  - past_due                    → the plan, for the grace period while Stripe
 *                                  retries the card; then free
 *  - unpaid, paused              → free (Stripe stopped retrying / collection paused)
 *  - incomplete                  → free: the first payment has not succeeded,
 *                                  so nothing paid is granted on an unverified payment
 *  - canceled, incomplete_expired → free; the history is kept
 *
 * Data is never deleted on a downgrade: going over a limit only blocks NEW
 * usage (another member), never what already exists.
 */
export function resolveAccess(sub: AccessInput | null, now: Date, graceDays: number): Access {
  if (!sub || sub.plan === 'FREE') return { plan: 'FREE', reason: 'free_plan' };

  if (PAID_ACCESS_STATUSES.includes(sub.status)) {
    return { plan: sub.plan, reason: sub.status === 'trialing' ? 'trial' : 'paid' };
  }
  switch (sub.status) {
    case 'past_due': {
      const since = sub.pastDueSince ?? now;
      const graceEndsAt = new Date(since.getTime() + graceDays * 86_400_000);
      return graceEndsAt > now
        ? { plan: sub.plan, reason: 'past_due_grace', graceEndsAt }
        : { plan: 'FREE', reason: 'past_due_expired', graceEndsAt };
    }
    case 'unpaid':
      return { plan: 'FREE', reason: 'unpaid' };
    case 'paused':
      return { plan: 'FREE', reason: 'paused' };
    case 'incomplete':
      return { plan: 'FREE', reason: 'incomplete' };
    default:
      return { plan: 'FREE', reason: 'canceled' };
  }
}
