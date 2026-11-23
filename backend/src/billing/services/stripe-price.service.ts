import { Injectable, Logger } from '@nestjs/common';
import type { BillingInterval, SubscriptionPlan } from '@prisma/client';
import { AppError } from '@/common/errors/app-error';
import { BillingConfig } from '../billing.config';
import { BILLING_ERRORS } from '../billing.constants';
import { PLANS } from '../billing-plans';
import { StripeService } from './stripe.service';

const VERIFIED_TTL_MS = 10 * 60_000;

/**
 * Resolves a plan and interval to the Stripe Price to charge, from server
 * config only, and checks that Price against the catalog before anyone is sent
 * to pay: same amount, same currency, same interval, recurring and active. A
 * mismatch is a configuration error and checkout refuses to start — the
 * customer is never charged an amount the pricing page did not show.
 */
@Injectable()
export class StripePriceService {
  private readonly logger = new Logger('BillingPrices');
  private readonly verified = new Map<string, number>();

  constructor(
    private readonly config: BillingConfig,
    private readonly stripe: StripeService,
  ) {}

  /** The configured Price ID, or BILLING_NOT_CONFIGURED. */
  priceIdFor(plan: SubscriptionPlan, interval: BillingInterval): string {
    if (plan === 'FREE') {
      throw new AppError(BILLING_ERRORS.INVALID_PLAN, 'The free plan has no checkout.');
    }
    const priceId = this.config.priceIdFor(plan, interval);
    if (!this.stripe.configured || !priceId) {
      throw new AppError(
        BILLING_ERRORS.NOT_CONFIGURED,
        `Checkout for ${PLANS[plan].name} (${interval.toLowerCase()}) is not configured yet.`,
        undefined,
        503,
      );
    }
    return priceId;
  }

  /** priceIdFor, plus the check against Stripe (cached for a few minutes). */
  async verifiedPriceId(plan: SubscriptionPlan, interval: BillingInterval): Promise<string> {
    const priceId = this.priceIdFor(plan, interval);
    const until = this.verified.get(priceId);
    if (until && until > Date.now()) return priceId;

    const price = await this.stripe.call('prices.retrieve', (s) => s.prices.retrieve(priceId));
    const expected = PLANS[plan].prices![interval];
    const problems: string[] = [];
    if (!price.active) problems.push('the Price is archived');
    if (price.type !== 'recurring' || !price.recurring) problems.push('the Price is not recurring');
    if (price.recurring && price.recurring.interval !== (interval === 'YEARLY' ? 'year' : 'month')) {
      problems.push(`it bills every ${price.recurring.interval}`);
    }
    if (price.recurring && price.recurring.interval_count !== 1) problems.push(`interval_count is ${price.recurring.interval_count}`);
    if (price.currency !== this.config.currency) problems.push(`currency is ${price.currency}, expected ${this.config.currency}`);
    if (price.unit_amount !== expected) problems.push(`amount is ${price.unit_amount}, expected ${expected}`);
    if (price.livemode !== (this.config.mode === 'live')) problems.push(`it is a ${price.livemode ? 'live' : 'test'} Price`);

    if (problems.length) {
      this.logger.error(`Stripe Price ${priceId} for ${plan}/${interval} does not match the plan catalog: ${problems.join('; ')}`);
      throw new AppError(
        BILLING_ERRORS.PRICE_MISMATCH,
        'This plan’s price is misconfigured, so checkout is paused. Please contact support.',
        undefined,
        503,
      );
    }
    this.verified.set(priceId, Date.now() + VERIFIED_TTL_MS);
    return priceId;
  }
}
