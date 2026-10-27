import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inQuietHours } from '@/common/utils/quiet-hours';
import { EngineService } from './engine.service';
import type { StrategyStep } from './strategy-store.service';

/** The redesigned two-step strategy: a "start after" on step 1, waits from the call's end, an answered call ends it. */

vi.mock('@/common/utils/quiet-hours', async (original) => ({
  ...(await original<typeof import('@/common/utils/quiet-hours')>()),
  inQuietHours: vi.fn(() => false),
}));

const ORG = 'org-1';
const LEAD = 'lead-1';
const NOW = new Date('2026-10-26T15:00:00Z');
const MIN = 60_000;

const call = (after = 0): StrategyStep => ({ id: 'call', after: { value: after, unit: 'minutes' }, channel: 'voice' });
const sms = (after: number, onlyIf?: StrategyStep['onlyIf']): StrategyStep => ({ id: 'sms', after: { value: after, unit: 'minutes' }, channel: 'sms', message: 'Thanks for the chat', onlyIf });

function setup(steps: StrategyStep[]) {
  let lead: Record<string, unknown> = { id: LEAD, orgId: ORG, firstName: 'Asha', phone: '+1', status: 'contacting', dncStatus: false, automationPaused: false };
  const tx = { lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } };
  const prisma = {
    lead: {
      findFirst: vi.fn(async () => lead),
      findUnique: vi.fn(async () => lead),
      update: vi.fn(),
      updateMany: vi.fn(async ({ data }: any) => {
        lead = { ...lead, ...data };
        return { count: 1 };
      }),
    },
    organization: { findUnique: vi.fn().mockResolvedValue({ name: 'Acme', settings: { timezone: 'UTC' } }) },
    $transaction: vi.fn(async (run: (t: typeof tx) => Promise<unknown>) => run(tx)),
  };
  const strategies = { getStrategy: vi.fn().mockResolvedValue({ name: 'S', timing: 'after_previous', guardrails: { respectQuietHours: false }, steps }) };
  const smsSvc = { sendSms: vi.fn().mockResolvedValue({ id: 'm' }) };
  const calls = { enqueue: vi.fn().mockResolvedValue('job') };
  const guard = {
    check: vi.fn().mockResolvedValue({ kind: 'go' }),
    conditionUnmet: vi.fn().mockResolvedValue(null),
    lastRunAt: vi.fn().mockResolvedValue(null),
    lastCallEndedAt: vi.fn().mockResolvedValue(null),
    record: vi.fn(),
    flagReview: vi.fn(),
    clearReview: vi.fn(),
    isScoredCall: vi.fn().mockResolvedValue(true),
  };
  const followup = { stopForLead: vi.fn(), sequenceForTrigger: vi.fn(), enroll: vi.fn(), liveEnrollment: vi.fn() };
  const engine = new EngineService(prisma as any, strategies as any, smsSvc as any, calls as any, { exitStrategy: vi.fn(), recordSms: vi.fn() } as any, followup as any, guard as any);
  const runs = () => guard.record.mock.calls.map(([r]) => `${r.stepNumber}:${r.outcome}${r.reason ? `:${r.reason}` : ''}`);
  return { engine, smsSvc, calls, guard, runs };
}

describe('EngineService redesign', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(NOW);
    vi.mocked(inQuietHours).mockReturnValue(false);
  });
  afterEach(() => vi.useRealTimers());

  it('step 1 "start after 30 min": nothing goes at once; the call goes 30 minutes in', async () => {
    const { engine, calls } = setup([call(30), sms(5)]);
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(30 * MIN - 1);
    expect(calls.enqueue).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.enqueue).toHaveBeenCalledOnce();
  });

  it('the text after a call waits its 5 minutes from when the call ended, not from when it was queued', async () => {
    const { engine, smsSvc, guard } = setup([call(), sms(5)]);
    // The call rang and ran until 4 minutes in.
    guard.lastCallEndedAt.mockResolvedValue(new Date(NOW.getTime() + 4 * MIN));
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(9 * MIN - 1);
    expect(smsSvc.sendSms).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(smsSvc.sendSms).toHaveBeenCalledOnce();
  });

  it('a "not answered" text after an answered call is skipped', async () => {
    const notAnswered = sms(5, { match: 'all', rules: [{ field: 'call_result', op: 'in', value: ['no_answer', 'voicemail', 'busy', 'short_pickup'] }] });
    const { engine, smsSvc, guard, runs } = setup([call(), notAnswered]);
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(0);
    guard.check.mockResolvedValue({ kind: 'answered', call: { id: 'c1', endedAt: new Date(NOW.getTime() + 3 * MIN) } });
    await vi.advanceTimersByTimeAsync(6 * MIN);
    await engine.qualified(ORG, LEAD, 'warm');
    expect(smsSvc.sendSms).not.toHaveBeenCalled();
    expect(runs()).toEqual(['1:queued', '2:skipped:call_answered']);
  });
});
