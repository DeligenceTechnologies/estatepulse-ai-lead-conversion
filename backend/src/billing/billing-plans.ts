import { BillingInterval, SubscriptionPlan } from '@prisma/client';

/**
 * Plan catalog. Prices are display prices in minor units (paise) and must match
 * the Stripe Price configured in STRIPE_<PLAN>_<INTERVAL>_PRICE_ID, or checkout refuses to start.
 */

export enum Feature {
  LEAD_MANAGEMENT = 'lead_management',
  BASIC_CRM = 'basic_crm',
  BASIC_DASHBOARD = 'basic_dashboard',
  ADVANCED_CRM = 'advanced_crm',
  LEAD_AUTOMATION = 'lead_automation',
  ADVANCED_ANALYTICS = 'advanced_analytics',
  CALENDAR_INTEGRATION = 'calendar_integration',
  ADVANCED_AUTOMATION = 'advanced_automation',
  PRIORITY_SUPPORT = 'priority_support',
  ADVANCED_REPORTING = 'advanced_reporting',
  AI_ASSISTANT = 'ai_assistant',
}

export const FEATURE_LABELS: Readonly<Record<Feature, string>> = {
  [Feature.LEAD_MANAGEMENT]: 'Lead management',
  [Feature.BASIC_CRM]: 'Basic CRM',
  [Feature.BASIC_DASHBOARD]: 'Basic dashboard',
  [Feature.ADVANCED_CRM]: 'Advanced CRM',
  [Feature.LEAD_AUTOMATION]: 'Lead automation (follow-up sequences)',
  [Feature.ADVANCED_ANALYTICS]: 'Advanced analytics',
  [Feature.CALENDAR_INTEGRATION]: 'Calendar integration (Calendly, Cal.com)',
  [Feature.ADVANCED_AUTOMATION]: 'Advanced automation',
  [Feature.PRIORITY_SUPPORT]: 'Priority support',
  [Feature.ADVANCED_REPORTING]: 'Advanced reporting',
  [Feature.AI_ASSISTANT]: 'Copilot AI assistant',
};

export interface PlanLimits {
  maxMembers: number;
  /** Copilot spend allowed per calendar month, in US dollars × 1,000,000. */
  assistantMonthlyBudgetMicros: number;
}

export interface PlanDefinition {
  key: SubscriptionPlan;
  name: string;
  description: string;
  prices: Record<BillingInterval, number> | null;
  features: readonly Feature[];
  limits: PlanLimits;
  recommended?: boolean;
}

const FREE_FEATURES: readonly Feature[] = [Feature.LEAD_MANAGEMENT, Feature.BASIC_CRM];
const STARTER_FEATURES: readonly Feature[] = [...FREE_FEATURES, Feature.BASIC_DASHBOARD];
const PROFESSIONAL_FEATURES: readonly Feature[] = [
  ...STARTER_FEATURES,
  Feature.ADVANCED_CRM,
  Feature.LEAD_AUTOMATION,
  Feature.ADVANCED_ANALYTICS,
  Feature.CALENDAR_INTEGRATION,
  Feature.AI_ASSISTANT,
];
const BUSINESS_FEATURES: readonly Feature[] = [
  ...PROFESSIONAL_FEATURES,
  Feature.ADVANCED_AUTOMATION,
  Feature.PRIORITY_SUPPORT,
  Feature.ADVANCED_REPORTING,
];

export const PLANS: Readonly<Record<SubscriptionPlan, PlanDefinition>> = {
  [SubscriptionPlan.FREE]: {
    key: SubscriptionPlan.FREE,
    name: 'Free',
    description: 'For trying EstatePulse on your own.',
    prices: null,
    features: FREE_FEATURES,
    limits: { maxMembers: 1, assistantMonthlyBudgetMicros: 0 },
  },
  [SubscriptionPlan.STARTER]: {
    key: SubscriptionPlan.STARTER,
    name: 'Starter',
    description: 'For a small team getting organised.',
    prices: { [BillingInterval.MONTHLY]: 99_900, [BillingInterval.YEARLY]: 999_900 },
    features: STARTER_FEATURES,
    limits: { maxMembers: 3, assistantMonthlyBudgetMicros: 0 },
  },
  [SubscriptionPlan.PROFESSIONAL]: {
    key: SubscriptionPlan.PROFESSIONAL,
    name: 'Professional',
    description: 'Automation, analytics and calendar booking for a growing office.',
    prices: { [BillingInterval.MONTHLY]: 299_900, [BillingInterval.YEARLY]: 2_999_900 },
    features: PROFESSIONAL_FEATURES,
    limits: { maxMembers: 10, assistantMonthlyBudgetMicros: 50_000_000 },
    recommended: true,
  },
  [SubscriptionPlan.BUSINESS]: {
    key: SubscriptionPlan.BUSINESS,
    name: 'Business',
    description: 'Everything, for brokerages running at scale.',
    prices: { [BillingInterval.MONTHLY]: 599_900, [BillingInterval.YEARLY]: 5_999_900 },
    features: BUSINESS_FEATURES,
    limits: { maxMembers: 25, assistantMonthlyBudgetMicros: 150_000_000 },
  },
};

/** Cheapest first; also the upgrade order. */
export const PLAN_ORDER: readonly SubscriptionPlan[] = [
  SubscriptionPlan.FREE,
  SubscriptionPlan.STARTER,
  SubscriptionPlan.PROFESSIONAL,
  SubscriptionPlan.BUSINESS,
];
export const PAID_PLANS: readonly SubscriptionPlan[] = PLAN_ORDER.filter((p) => p !== SubscriptionPlan.FREE);
export const INTERVALS: readonly BillingInterval[] = Object.values(BillingInterval);

const planRank = (plan: SubscriptionPlan): number => PLAN_ORDER.indexOf(plan);

export const lowestPlanWith = (feature: Feature): SubscriptionPlan | null =>
  PLAN_ORDER.find((plan) => PLANS[plan].features.includes(feature)) ?? null;

export const lowestPlanForMembers = (members: number): SubscriptionPlan | null =>
  PLAN_ORDER.find((plan) => PLANS[plan].limits.maxMembers >= members) ?? null;

export enum PlanChange {
  SAME = 'same',
  UPGRADE = 'upgrade',
  DOWNGRADE = 'downgrade',
}

/** Higher plan = upgrade. Same plan: monthly→yearly upgrade, yearly→monthly downgrade. */
export function classifyPlanChange(
  from: { plan: SubscriptionPlan; interval: BillingInterval | null },
  to: { plan: SubscriptionPlan; interval: BillingInterval },
): PlanChange {
  const diff = planRank(to.plan) - planRank(from.plan);
  if (diff !== 0) return diff > 0 ? PlanChange.UPGRADE : PlanChange.DOWNGRADE;
  if (from.interval === to.interval) return PlanChange.SAME;
  return to.interval === BillingInterval.YEARLY ? PlanChange.UPGRADE : PlanChange.DOWNGRADE;
}
