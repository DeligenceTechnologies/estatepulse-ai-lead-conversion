import { IsBoolean, IsIn, IsISO8601, IsNumber, IsOptional, IsUUID, Matches, Max, Min, ValidateIf } from 'class-validator';
import { MAX_RATE } from '../cost-rates';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONTH_MESSAGE = 'A month must look like 2026-11.';
/** Decimal(12, 2): ten whole digits. */
const MAX_MONEY = 9_999_999_999.99;

export class RoiRangeQuery {
  @Matches(MONTH, { message: MONTH_MESSAGE })
  from!: string;

  @Matches(MONTH, { message: MONTH_MESSAGE })
  to!: string;
}

export class SpendDto {
  @IsUUID()
  leadSourceId!: string;

  @Matches(MONTH, { message: MONTH_MESSAGE })
  month!: string;

  /** Null (or 0) clears the month's spend. */
  @ValidateIf((_, v) => v !== null)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Spend must be an amount with at most two decimal places.' })
  @Min(0)
  @Max(MAX_MONEY)
  amount!: number | null;
}

export class RatesDto {
  /** Null puts the rate back on the default. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(MAX_RATE)
  callRatePerMinute?: number | null;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(MAX_RATE)
  smsRatePerSegment?: number | null;
}

export const DEAL_OUTCOMES = ['won', 'lost'] as const;
export type DealOutcome = (typeof DEAL_OUTCOMES)[number];

export class DealDto {
  /** Null reopens the deal and clears its value and closing date. */
  @ValidateIf((_, v) => v !== null)
  @IsIn(DEAL_OUTCOMES)
  outcome!: DealOutcome | null;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Deal value must be an amount with at most two decimal places.' })
  @Min(0)
  @Max(MAX_MONEY)
  value?: number | null;

  /** When the deal closed; now when left out. */
  @IsOptional()
  @IsISO8601({ strict: true })
  closedAt?: string | null;
}

export class NoShowDto {
  @IsBoolean()
  noShow!: boolean;
}
