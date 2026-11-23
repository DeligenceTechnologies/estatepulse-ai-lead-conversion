/**
 * What Source ROI assumes an AI call minute and a text segment cost, in USD,
 * until the organization enters its own rates. Calls and texts are billed to
 * the organization's own telephony account, so these are estimates of that
 * bill, not charges of ours.
 *
 * PLACEHOLDERS: round figures chosen to be in the right range, not taken from
 * a price list. Replace them with the confirmed list prices before this is
 * switched on for customers.
 */
export const DEFAULT_CALL_RATE_PER_MINUTE_USD = 0.09;
export const DEFAULT_SMS_RATE_PER_SEGMENT_USD = 0.008;

/** org_settings.*_rate are Decimal(8, 4). */
export const MAX_RATE = 9999.9999;

export const METRIC = {
  CALL_MINUTES: 'ai_call_minutes',
  SMS_SEGMENTS: 'sms_segments',
} as const;

export interface CostRates {
  callRatePerMinute: number;
  smsRatePerSegment: number;
}

export const DEFAULT_RATES: CostRates = {
  callRatePerMinute: DEFAULT_CALL_RATE_PER_MINUTE_USD,
  smsRatePerSegment: DEFAULT_SMS_RATE_PER_SEGMENT_USD,
};

type Numeric = { toString(): string } | number | null | undefined;

/** The organization's own rate where it set one, the default where it did not. */
export function ratesFrom(row: { callRatePerMinute?: Numeric; smsRatePerSegment?: Numeric } | null | undefined): CostRates {
  return {
    callRatePerMinute: row?.callRatePerMinute == null ? DEFAULT_RATES.callRatePerMinute : Number(row.callRatePerMinute),
    smsRatePerSegment: row?.smsRatePerSegment == null ? DEFAULT_RATES.smsRatePerSegment : Number(row.smsRatePerSegment),
  };
}

/** Ledger quantities and amounts are kept to four decimal places. */
export const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;
