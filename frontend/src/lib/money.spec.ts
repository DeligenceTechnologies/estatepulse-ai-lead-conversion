import { describe, expect, it } from 'vitest';
import { formatPercent, formatUsd, NO_VALUE, parseMoney } from './money';

describe('formatUsd', () => {
  it('shows whole dollars for ordinary amounts and cents for small ones', () => {
    expect(formatUsd(1500)).toBe('$1,500');
    expect(formatUsd(339.6)).toBe('$340');
    expect(formatUsd(0.14)).toBe('$0.14');
    expect(formatUsd(0)).toBe('$0');
  });

  it('shows cents when asked', () => {
    expect(formatUsd(1500, { cents: true })).toBe('$1,500.00');
  });

  it('an amount that cannot be worked out is a dash, not $0', () => {
    expect(formatUsd(null)).toBe(NO_VALUE);
    expect(formatUsd(undefined)).toBe(NO_VALUE);
    expect(formatUsd(Number.NaN)).toBe(NO_VALUE);
  });
});

describe('formatPercent', () => {
  it('rounds a share to a whole percentage', () => {
    expect(formatPercent(0.754)).toBe('75%');
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(null)).toBe(NO_VALUE);
  });
});

describe('parseMoney', () => {
  it('reads what a person types', () => {
    expect(parseMoney('1500')).toBe(1500);
    expect(parseMoney(' $1,500.50 ')).toBe(1500.5);
    expect(parseMoney('0')).toBe(0);
  });

  it('an emptied box is null', () => {
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('  ')).toBeNull();
  });

  it('anything else is refused, not guessed at', () => {
    for (const bad of ['abc', '-5', '1.234', '1e3', '12.']) expect(parseMoney(bad)).toBeUndefined();
  });
});
