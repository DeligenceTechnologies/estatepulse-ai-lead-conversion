const whole = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const cents = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** What stands in for a number there is no way to work out (a cost per appointment with no appointments). */
export const NO_VALUE = '—';

/**
 * A US-dollar amount: whole dollars by default, cents when asked for or when
 * the amount is under ten dollars (a $0.14 call would otherwise read "$0").
 * Null and undefined read as a dash, never as "$0": "nothing to divide by" is
 * not "free".
 */
export function formatUsd(amount: number | null | undefined, options: { cents?: boolean } = {}): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return NO_VALUE;
  const precise = options.cents ?? (amount !== 0 && Math.abs(amount) < 10);
  return (precise ? cents : whole).format(amount);
}

/** A 0–1 share as a whole percentage; a dash when there is none. */
export function formatPercent(share: number | null | undefined): string {
  if (share === null || share === undefined || !Number.isFinite(share)) return NO_VALUE;
  return `${Math.round(share * 100)}%`;
}

/**
 * What a person typed in a money box, as a number: "$1,500.50" is 1500.5 and
 * an emptied box is null. Anything else that is not an amount of at most two
 * decimals, or is negative, is `undefined`: the caller says so instead of
 * guessing.
 */
export function parseMoney(text: string): number | null | undefined {
  const cleaned = text.replace(/[$,\s]/g, '');
  if (cleaned === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return undefined;
  return Number(cleaned);
}
