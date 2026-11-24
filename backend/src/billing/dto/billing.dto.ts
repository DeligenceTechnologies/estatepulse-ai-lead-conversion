import { BillingInterval, type SubscriptionPlan } from '@prisma/client';
import { IsBoolean, IsEnum, IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { PAID_PLANS } from '../billing-plans';

/** Only plan + interval are accepted; never a price or Price ID. */
export class SelectPlanDto {
  @IsIn([...PAID_PLANS], { message: `plan must be one of ${PAID_PLANS.join(', ')}` })
  plan!: SubscriptionPlan;

  @IsEnum(BillingInterval, { message: `interval must be one of ${Object.values(BillingInterval).join(', ')}` })
  interval!: BillingInterval;
}

export class CancelSubscriptionDto {
  @IsOptional()
  @IsBoolean()
  immediately?: boolean;
}

export class CheckoutStatusParams {
  @IsString()
  @Matches(/^cs_(test|live)_\w+$/, { message: 'Not a checkout session id' })
  sessionId!: string;
}
