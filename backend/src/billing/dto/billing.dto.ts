import { BillingInterval, SubscriptionPlan } from '@prisma/client';
import { IsBoolean, IsIn, IsOptional, IsString, Matches } from 'class-validator';

const PAID: SubscriptionPlan[] = ['STARTER', 'PROFESSIONAL', 'BUSINESS'];

/**
 * A plan and an interval — the only things the browser chooses. No price,
 * amount, Price ID or organization is accepted (unknown fields are rejected by
 * the global ValidationPipe's forbidNonWhitelisted).
 */
export class SelectPlanDto {
  @IsIn(PAID, { message: `plan must be one of ${PAID.join(', ')}` })
  plan!: SubscriptionPlan;

  @IsIn(Object.values(BillingInterval), { message: 'interval must be MONTHLY or YEARLY' })
  interval!: BillingInterval;
}

export class CancelSubscriptionDto {
  /** End now instead of at the period end; refused unless the server allows it. */
  @IsOptional()
  @IsBoolean()
  immediately?: boolean;
}

export class CheckoutStatusParams {
  @IsString()
  @Matches(/^cs_(test|live)_\w+$/, { message: 'Not a checkout session id' })
  sessionId!: string;
}
