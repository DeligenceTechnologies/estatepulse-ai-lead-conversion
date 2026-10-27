import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StrategyStep } from '@/telnyx/strategy-store.service';
import { strategyFlowSteps } from './strategy-flow';

const T = (min: number) => new Date(Date.UTC(2026, 9, 26, 15, min));
const steps: StrategyStep[] = [
  { id: 'a', after: { value: 0, unit: 'minutes' }, channel: 'voice' },
  { id: 'b', after: { value: 5, unit: 'minutes' }, channel: 'sms', message: 'x', condition: 'call_not_answered' },
];
const call = (over: Record<string, unknown>) =>
  ({ id: 'c', status: 'completed', createdAt: T(0), startedAt: T(0), answeredAt: T(0), endedAt: T(2), durationSeconds: null, extractedIntel: null, ...over }) as any;
const analysed = (reached: boolean) => ({ extractedIntel: { qualification: { extraction: { reached_person: reached } } } });
const queuedRun = { stepNumber: 1, outcome: 'queued', reason: null, createdAt: T(0) };

describe('strategyFlowSteps', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T(4));
  });
  afterEach(() => vi.useRealTimers());

  it('shows each step from its run: the call by how it went, a skipped step with why', () => {
    const out = strategyFlowSteps(steps, [queuedRun, { stepNumber: 2, outcome: 'skipped', reason: 'call_answered', createdAt: T(3) }], [call(analysed(true))]);
    expect(out.map((s) => [s.state, s.outcome])).toEqual([
      ['done', 'Answered'],
      ['skipped', 'Skipped — the call was answered'],
    ]);
  });

  it('a voicemail reads as such, a call awaiting its analysis as being checked, a step not yet reached as pending', () => {
    expect(strategyFlowSteps(steps, [queuedRun], [call(analysed(false))]).map((s) => [s.state, s.outcome])).toEqual([
      ['failed', 'Short call or voicemail'],
      ['pending', null],
    ]);
    expect(strategyFlowSteps(steps, [queuedRun], [call({})])[0]).toEqual(expect.objectContaining({ state: 'current', outcome: 'Checking how the call went' }));
  });

  it('a call step whose call is still to be dialed reads as queued; one that never left the queue as skipped', () => {
    expect(strategyFlowSteps(steps, [queuedRun], [])[0]).toEqual(expect.objectContaining({ state: 'current', outcome: 'Call queued' }));
    const stuck = strategyFlowSteps(steps, [queuedRun, { stepNumber: 2, outcome: 'skipped', reason: 'call_still_queued', createdAt: T(3) }], []);
    expect(stuck[1]).toEqual(expect.objectContaining({ state: 'skipped', outcome: 'Skipped — the call never left the queue' }));
  });
});
