import { BillingInterval, SubscriptionPlan } from '@prisma/client';

/**
 * The one place plans are defined: what each costs on screen, what it unlocks
 * and how far it stretches. Every check in the app reads from here, so adding a
 * feature to a plan or changing a limit is an edit to this file only.
 *
 * Prices here are DISPLAY prices, in minor units (paise for INR). They are
 * never sent to Stripe: Stripe charges whatever its Price says. What links the
 * two is the Price ID in env (STRIPE_<PLAN>_<INTERVAL>_PRICE_ID), and checkout
 * refuses to start when the Stripe Price does not match the amount, currency
 * and interval shown here — so the customer is never charged a different
 * amount from the one on the pricing page.
 *
 * The current values are demo prices for Stripe test mode.
 */

export const FEATURES = {
  LEAD_MANAGEMENT: 'lead_management',
  BASIC_CRM: 'basic_crm',
  BASIC_DASHBOARD: 'basic_dashboard',
  ADVANCED_CRM: 'advanced_crm',
  LEAD_AUTOMATION: 'lead_automation',
  ADVANCED_ANALYTICS: 'advanced_analytics',
  CALENDAR_INTEGRATION: 'calendar_integration',
  ADVANCED_AUTOMATION: 'advanced_automation',
  PRIORITY_SUPPORT: 'priority_support',
  ADVANCED_REPORTING: 'advanced_reporting',
} as const;

export type Feature = (typeof FEATURES)[keyof typeof FEATURES];

export const FEATURE_LABELS: Record<Feature, string> = {
  lead_management: 'Lead management',
  basic_crm: 'Basic CRM',
  basic_dashboard: 'Basic dashboard',
  advanced_crm: 'Advanced CRM',
  lead_automation: 'Lead automation (follow-up sequences)',
  advanced_analytics: 'Advanced analytics',
  calendar_integration: 'Calendar integration (Calendly, Cal.com)',
  advanced_automation: 'Advanced automation',
  priority_support: 'Priority support',
  advanced_reporting: 'Advanced reporting',
};

export interface PlanLimits {
  /** Active users in the organization, owners included. */
  maxMembers: number;
}

export interface PlanDefinition {
  key: SubscriptionPlan;
  name: string;
  description: string;
  /** Minor units per interval; FREE has none. */
  prices: Record<BillingInterval, number> | null;
  features: readonly Feature[];
  limits: PlanLimits;
  recommended?: boolean;
}

const FREE_FEATURES: readonly Feature[] = [FEATURES.LEAD_MANAGEMENT, FEATURES.BASIC_CRM];
const STARTER_FEATURES: readonly Feature[] = [...FREE_FEATURES, FEATURES.BASIC_DASHBOARD];
const PROFESSIONAL_FEATURES: readonly Feature[] = [
  ...STARTER_FEATURES,
  FEATURES.ADVANCED_CRM,
  FEATURES.LEAD_AUTOMATION,
  FEATURES.ADVANCED_ANALYTICS,
  FEATURES.CALENDAR_INTEGRATION,
];
const BUSINESS_FEATURES: readonly Feature[] = [
  ...PROFESSIONAL_FEATURES,
  FEATURES.ADVANCED_AUTOMATION,
  FEATURES.PRIORITY_SUPPORT,
  FEATURES.ADVANCED_REPORTING,
];

export const PLANS: Readonly<Record<SubscriptionPlan, PlanDefinition>> = {
  FREE: {
    key: 'FREE',
    name: 'Free',
    description: 'For trying EstatePulse on your own.',
    prices: null,
    features: FREE_FEATURES,
    limits: { maxMembers: 1 },
  },
  STARTER: {
    key: 'STARTER',
    name: 'Starter',
    description: 'For a small team getting organised.',
    prices: { MONTHLY: 99_900, YEARLY: 999_900 },
    features: STARTER_FEATURES,
    limits: { maxMembers: 3 },
  },
  PROFESSIONAL: {
    key: 'PROFESSIONAL',
    name: 'Professional',
    description: 'Automation, analytics and calendar booking for a growing office.',
    prices: { MONTHLY: 299_900, YEARLY: 2_999_900 },
    features: PROFESSIONAL_FEATURES,
    limits: { maxMembers: 10 },
    recommended: true,
  },
  BUSINESS: {
    key: 'BUSINESS',
    name: 'Business',
    description: 'Everything, for brokerages running at scale.',
    prices: { MONTHLY: 599_900, YEARLY: 5_999_900 },
    features: BUSINESS_FEATURES,
    limits: { maxMembers: 25 },
  },
};

/** Cheapest first. Also the upgrade order. */
export const PLAN_ORDER: readonly SubscriptionPlan[] = ['FREE', 'STARTER', 'PROFESSIONAL', 'BUSINESS'];
export const PAID_PLANS: readonly SubscriptionPlan[] = ['STARTER', 'PROFESSIONAL', 'BUSINESS'];
export const INTERVALS: readonly BillingInterval[] = ['MONTHLY', 'YEARLY'];

export const planRank = (plan: SubscriptionPlan): number => PLAN_ORDER.indexOf(plan);

export const planHasFeature = (plan: SubscriptionPlan, feature: Feature): boolean => PLANS[plan].features.includes(feature);

/** The cheapest plan that includes the feature. */
export function lowestPlanWith(feature: Feature): SubscriptionPlan | null {
  return PLAN_ORDER.find((plan) => planHasFeature(plan, feature)) ?? null;
}

/** The cheapest plan that allows at least `members` active users. */
export function lowestPlanForMembers(members: number): SubscriptionPlan | null {
  return PLAN_ORDER.find((plan) => PLANS[plan].limits.maxMembers >= members) ?? null;
}

export type PlanChange = 'same' | 'upgrade' | 'downgrade';

/**
 * A higher plan is an upgrade whatever the interval; on the same plan, monthly
 * to yearly is an upgrade (paid now) and yearly to monthly a downgrade (at the
 * end of the year already paid for).
 */
export function classifyPlanChange(
  from: { plan: SubscriptionPlan; interval: BillingInterval | null },
  to: { plan: SubscriptionPlan; interval: BillingInterval },
): PlanChange {
  const diff = planRank(to.plan) - planRank(from.plan);
  if (diff > 0) return 'upgrade';
  if (diff < 0) return 'downgrade';
  if (from.interval === to.interval) return 'same';
  return to.interval === 'YEARLY' ? 'upgrade' : 'downgrade';
}

export const isPaidPlan = (plan: SubscriptionPlan): boolean => plan !== 'FREE';
