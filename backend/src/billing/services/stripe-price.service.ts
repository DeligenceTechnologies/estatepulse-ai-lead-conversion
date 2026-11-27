import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { SubscriptionPlan, type BillingInterval } from '@prisma/client';
import { AppError } from '@/common/errors/app-error';
import { BillingConfig } from '../billing.config';
import { BillingErrorCode, STRIPE_RECURRING_INTERVAL, StripeMode } from '../billing.constants';
import { PLANS } from '../billing-plans';
import { StripeService } from './stripe.service';

const VERIFIED_TTL_MS = 10 * 60_000;

/** Resolves plan+interval to a Stripe Price and checks it matches the catalog before checkout. */
@Injectable()
export class StripePriceService {
  private readonly logger = new Logger('BillingPrices');
  private readonly verified = new Map<string, number>();

  constructor(
    private readonly config: BillingConfig,
    private readonly stripe: StripeService,
  ) {}

  priceIdFor(plan: SubscriptionPlan, interval: BillingInterval): string {
    if (plan === SubscriptionPlan.FREE) throw new AppError(BillingErrorCode.INVALID_PLAN, 'The free plan has no checkout.');
    const priceId = this.config.priceIdFor(plan, interval);
    if (!this.stripe.configured || !priceId) {
      throw new AppError(
        BillingErrorCode.NOT_CONFIGURED,
        `Checkout for ${PLANS[plan].name} (${interval.toLowerCase()}) is not configured yet.`,
        undefined,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return priceId;
  }

  async verifiedPriceId(plan: SubscriptionPlan, interval: BillingInterval): Promise<string> {
    const priceId = this.priceIdFor(plan, interval);
    if ((this.verified.get(priceId) ?? 0) > Date.now()) return priceId;

    const price = await this.stripe.call('prices.retrieve', (s) => s.prices.retrieve(priceId));
    const expected = PLANS[plan].prices![interval];
    const recurring = price.recurring;
    const problems: string[] = [];
    if (!price.active) problems.push('the Price is archived');
    if (price.type !== 'recurring' || !recurring) problems.push('the Price is not recurring');
    if (recurring && recurring.interval !== STRIPE_RECURRING_INTERVAL[interval]) problems.push(`it bills every ${recurring.interval}`);
    if (recurring && recurring.interval_count !== 1) problems.push(`interval_count is ${recurring.interval_count}`);
    if (price.currency !== this.config.currency) problems.push(`currency is ${price.currency}, expected ${this.config.currency}`);
    if (price.unit_amount !== expected) problems.push(`amount is ${price.unit_amount}, expected ${expected}`);
    if (price.livemode !== (this.config.mode === StripeMode.LIVE)) problems.push(`it is a ${price.livemode ? StripeMode.LIVE : StripeMode.TEST} Price`);

    if (problems.length) {
      this.logger.error(`Stripe Price ${priceId} for ${plan}/${interval} does not match the catalog: ${problems.join('; ')}`);
      throw new AppError(
        BillingErrorCode.PRICE_MISMATCH,
        'This plan’s price is misconfigured, so checkout is paused. Please contact support.',
        undefined,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    this.verified.set(priceId, Date.now() + VERIFIED_TTL_MS);
    return priceId;
  }
}
