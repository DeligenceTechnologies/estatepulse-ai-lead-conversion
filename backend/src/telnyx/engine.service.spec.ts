import { describe, expect, it } from 'vitest';
import { remainingSteps } from './engine.service';
import type { StrategyStep } from './strategy-store.service';

const MIN = 60_000;
const step = (id: string, channel: 'sms' | 'voice', minutes: number): StrategyStep =>
  ({ id, channel, after: { value: minutes, unit: 'minutes' } }) as StrategyStep;

// Call at 1m, call at 2m, SMS at 5m — the default strategy shape.
const steps = [step('c1', 'voice', 1), step('c2', 'voice', 2), step('s1', 'sms', 5)];
const T0 = 1_000_000_000_000;

describe('remainingSteps (resume after restart)', () => {
  it('nothing on record: every step remains, anchor unchanged when not yet due', () => {
    const r = remainingSteps(steps, 0, 0, T0, T0 + 30_000);
    expect(r.remaining.map((s) => s.id)).toEqual(['c1', 'c2', 's1']);
    expect(r.anchor).toBe(T0);
  });

  it('skips steps already on record, per channel and in order', () => {
    const r = remainingSteps(steps, 1, 0, T0, T0 + 90_000);
    expect(r.remaining.map((s) => s.id)).toEqual(['c2', 's1']);
  });

  it('a text on record does not count as a call', () => {
    const r = remainingSteps(steps, 0, 1, T0, T0);
    expect(r.remaining.map((s) => s.id)).toEqual(['c1', 'c2']);
  });

  it('overdue steps are staggered, not fired as one burst', () => {
    // Restarted 10 minutes in with only the first call made.
    const now = T0 + 10 * MIN;
    const r = remainingSteps(steps, 1, 0, T0, now);
    // First remaining step (c2 at 2m) is due exactly now…
    expect(r.anchor + 2 * MIN).toBe(now);
    // …and the SMS keeps its 3-minute gap after it.
    expect(r.anchor + 5 * MIN - now).toBe(3 * MIN);
  });

  it('everything on record: nothing remains', () => {
    const r = remainingSteps(steps, 2, 1, T0, T0 + 60 * MIN);
    expect(r.remaining).toEqual([]);
    expect(r.anchor).toBe(T0);
  });
});
