import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineService } from './engine.service';
import { CALLBACK_UNHANDLED_REVIEW, SCORE_MISSING_REVIEW } from '@/outreach/step-guard.service';
import type { StrategyStep } from './strategy-store.service';

/** The safety rules as the strategy sees them: held while a call is live, ended by an answer or a booking. */

vi.mock('@/common/utils/quiet-hours', async (original) => ({
  ...(await original<typeof import('@/common/utils/quiet-hours')>()),
  inQuietHours: vi.fn(() => false),
}));

const ORG = 'org-1';
const LEAD = 'lead-1';
const NOW = new Date('2026-10-26T15:00:00Z');
const MIN = 60_000;

const steps: StrategyStep[] = [
  { id: 's1', after: { value: 0, unit: 'minutes' }, channel: 'sms', message: 'Hi {{firstName}}' },
  { id: 's2', after: { value: 1, unit: 'minutes' }, channel: 'voice' },
  { id: 's3', after: { value: 5, unit: 'minutes' }, channel: 'sms', message: 'Just tried you' },
];

function setup(opts: { steps?: StrategyStep[]; maxVoiceAttempts?: number } = {}) {
  const live = { id: LEAD, orgId: ORG, firstName: 'Asha', phone: '+12895550111', status: 'contacting', dncStatus: false, automationPaused: false, aiSummary: null };
  const tx = { lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), update: vi.fn() } };
  const prisma = {
    lead: {
      findFirst: vi.fn().mockResolvedValue(live),
      findUnique: vi.fn().mockResolvedValue(live),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    organization: { findUnique: vi.fn().mockResolvedValue({ name: 'Acme Realty', settings: { timezone: 'UTC' } }) },
    $transaction: vi.fn(async (run: (t: typeof tx) => Promise<unknown>) => run(tx)),
  };
  const strategies = { getStrategy: vi.fn().mockResolvedValue({ name: 'Default', guardrails: { respectQuietHours: false, maxVoiceAttempts: opts.maxVoiceAttempts ?? 3 }, steps: opts.steps ?? steps }) };
  const sms = { sendSms: vi.fn().mockResolvedValue({ id: 'msg-1' }) };
  const calls = { enqueue: vi.fn().mockResolvedValue('job-1') };
  const activity = { recordSms: vi.fn(), recordCallFailed: vi.fn(), exitStrategy: vi.fn() };
  const followup = { sequenceForTrigger: vi.fn(), enroll: vi.fn().mockResolvedValue(true), stopForLead: vi.fn(), liveEnrollment: vi.fn().mockResolvedValue(null) };
  const guard = {
    check: vi.fn().mockResolvedValue({ kind: 'go' }),
    conditionUnmet: vi.fn().mockResolvedValue(null),
    lastRunAt: vi.fn().mockResolvedValue(null),
    lastCallEndedAt: vi.fn().mockResolvedValue(null),
    isScoredCall: vi.fn().mockResolvedValue(false),
    record: vi.fn(),
    flagReview: vi.fn(),
    clearReview: vi.fn(),
  };
  const engine = new EngineService(prisma as any, strategies as any, sms as any, calls as any, activity as any, followup as any, guard as any, { get: () => true } as any);
  const runs = () => guard.record.mock.calls.map(([r]) => `${r.stepNumber}:${r.outcome}${r.reason ? `:${r.reason}` : ''}`);
  return { engine, prisma, sms, calls, activity, followup, guard, runs };
}

describe('EngineService safety rules', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('records every step it runs: the text sent, the call queued under its key', async () => {
    const { engine, runs, guard } = setup();
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(runs()).toEqual(['1:sent', '2:queued', '3:sent']);
    expect(guard.record).toHaveBeenCalledWith(expect.objectContaining({ runKey: `strategy:${NOW.getTime()}:2`, callKey: `strategy:${LEAD}:${NOW.getTime()}:2` }));
  });

  it('holds the step after a call while the call is live, then sends it once the call ends unanswered', async () => {
    const { engine, sms, guard } = setup();
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(MIN);
    guard.check.mockResolvedValueOnce({ kind: 'wait', until: Date.now() + 4 * MIN + MIN, reason: 'call_live' });
    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(sms.sendSms).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MIN);
    expect(sms.sendSms).toHaveBeenCalledTimes(2);
  });

  it('runs the steps in order: a held step holds every step after it', async () => {
    const voice = (id: string, value: number): StrategyStep => ({ id, after: { value, unit: 'minutes' }, channel: 'voice' });
    const { engine, calls, sms, guard } = setup({ steps: [voice('a', 0), voice('b', 1), { id: 'c', after: { value: 2, unit: 'minutes' }, channel: 'sms', message: 'x' }] });
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(0);
    guard.check.mockResolvedValue({ kind: 'wait', until: Date.now() + 10 * MIN, reason: 'call_live' });
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(calls.enqueue).toHaveBeenCalledTimes(1);
    expect(sms.sendSms).not.toHaveBeenCalled();
  });

  it('an answered call ends the strategy: the rest is recorded as skipped and nothing else is sent', async () => {
    const { engine, sms, calls, runs, guard } = setup();
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(MIN);
    guard.check.mockResolvedValue({ kind: 'answered', call: { id: 'call-1', endedAt: new Date(Date.now() + 2 * MIN) } });
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(sms.sendSms).toHaveBeenCalledOnce();
    expect(calls.enqueue).toHaveBeenCalledOnce();
    expect(runs()).toEqual(['1:sent', '2:queued', '3:skipped:call_answered']);
    expect(engine.isRunning(LEAD)).toBe(true);
  });

  it('when the answered call never gets a score, the lead is flagged and parked for follow-up', async () => {
    const { engine, activity, guard, followup, prisma } = setup();
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(MIN);
    const endedAt = new Date(Date.now() + 2 * MIN);
    guard.check.mockResolvedValue({ kind: 'answered', call: { id: 'call-1', endedAt } });
    await vi.advanceTimersByTimeAsync(4 * MIN);
    prisma.lead.findFirst.mockResolvedValue({ status: 'follow_up', followUpReason: 'not_ready' });
    followup.sequenceForTrigger.mockResolvedValue('NOT_READY');
    await vi.advanceTimersByTimeAsync(endedAt.getTime() + 15 * MIN - Date.now());
    expect(guard.flagReview).toHaveBeenCalledWith(ORG, LEAD, SCORE_MISSING_REVIEW);
    expect(activity.exitStrategy).toHaveBeenCalledWith(LEAD, 'Call answered — no score came back; needs a look');
    expect(followup.enroll).toHaveBeenCalledWith(ORG, LEAD, 'NOT_READY');
    expect(engine.isRunning(LEAD)).toBe(false);
  });

  it('when the score arrives in time, the score decides and nobody is flagged', async () => {
    const { engine, guard } = setup();
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(MIN);
    guard.check.mockResolvedValue({ kind: 'answered', call: { id: 'call-1', endedAt: new Date() } });
    await vi.advanceTimersByTimeAsync(5 * MIN);
    await engine.qualified(ORG, LEAD, 'warm');
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(guard.flagReview).not.toHaveBeenCalled();
    expect(guard.clearReview).toHaveBeenCalledWith(ORG, LEAD, SCORE_MISSING_REVIEW);
    expect(engine.isRunning(LEAD)).toBe(false);
  });

  it('after the last step, a call awaiting its analysis holds the exit, and an answered one waits for its score', async () => {
    const { engine, activity, guard } = setup();
    const endedAt = new Date(NOW.getTime() + 4 * MIN);
    guard.check
      .mockResolvedValueOnce({ kind: 'go' })
      .mockResolvedValueOnce({ kind: 'go' })
      .mockResolvedValueOnce({ kind: 'go' })
      .mockResolvedValueOnce({ kind: 'wait', until: NOW.getTime() + 5 * MIN + 90_000 + MIN, reason: 'awaiting_analysis' })
      .mockResolvedValue({ kind: 'answered', call: { id: 'call-1', endedAt } });
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(5 * MIN + 90_000);
    expect(activity.exitStrategy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(MIN);
    expect(activity.exitStrategy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(endedAt.getTime() + 15 * MIN - Date.now());
    expect(activity.exitStrategy).toHaveBeenCalledWith(LEAD, 'Call answered — no score came back; needs a look');
  });

  it('a call stuck in the queue for a day: the step after it is skipped with the reason, and the strategy moves on', async () => {
    const { engine, sms, runs, guard } = setup();
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(MIN);
    guard.check.mockResolvedValueOnce({ kind: 'stuck' });
    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(runs()).toEqual(['1:sent', '2:queued', '3:skipped:call_still_queued']);
    expect(sms.sendSms).toHaveBeenCalledOnce();
    expect(guard.conditionUnmet).toHaveBeenCalledTimes(2);
  });

  it('a meeting found on the calendar books the lead and ends everything', async () => {
    const { engine, sms, runs, guard, prisma, followup } = setup();
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(0);
    guard.check.mockResolvedValue({ kind: 'booked' });
    await vi.advanceTimersByTimeAsync(MIN);
    expect(runs()).toEqual(['1:sent', '2:skipped:booked']);
    expect(prisma.lead.update).toHaveBeenCalledWith({ where: { id: LEAD }, data: { status: 'appointment_booked' } });
    expect(followup.stopForLead).toHaveBeenCalledWith(ORG, LEAD, 'appointment_booked');
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(sms.sendSms).toHaveBeenCalledOnce();
    expect(engine.isRunning(LEAD)).toBe(false);
  });

  it('a call step past the attempt limit is recorded as skipped', async () => {
    const { engine, runs } = setup({ steps: [{ id: 'v', after: { value: 0, unit: 'minutes' }, channel: 'voice' }], maxVoiceAttempts: 0 });
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(0);
    expect(runs()).toEqual(['1:skipped:max_voice_attempts']);
  });
});

describe('EngineService re-score (A4)', () => {
  it.each([
    ['already in the sequence the score points at', { enrolledBy: 'auto', sequence: { code: 'WARM' } }],
    ['put in its sequence by the owner', { enrolledBy: 'manual', sequence: { code: 'NO_ANSWER' } }],
  ])('leaves a lead %s where it is', async (_label, live) => {
    const { engine, prisma, followup } = setup();
    prisma.lead.findFirst.mockResolvedValue({ status: 'follow_up', followUpReason: 'no_answer' });
    followup.sequenceForTrigger.mockImplementation(async (_o: string, t: string) => (t === 'qualified_warm' ? 'WARM' : undefined));
    followup.liveEnrollment.mockResolvedValue({ id: 'enr-1', ...live });
    await engine.qualified(ORG, LEAD, 'warm');
    expect(followup.stopForLead).not.toHaveBeenCalled();
    expect(followup.enroll).not.toHaveBeenCalled();
  });

  it('flags a callback request no sequence picks up, so it is never lost', async () => {
    const { engine, prisma, followup, guard } = setup();
    prisma.lead.findFirst.mockResolvedValue({ status: 'contacting', followUpReason: null });
    followup.sequenceForTrigger.mockResolvedValue(undefined);
    await engine.qualified(ORG, LEAD, 'warm', undefined, { callbackRequested: true });
    expect(guard.flagReview).toHaveBeenCalledWith(ORG, LEAD, CALLBACK_UNHANDLED_REVIEW);

    const kept = setup();
    kept.prisma.lead.findFirst.mockResolvedValue({ status: 'contacting', followUpReason: null });
    kept.followup.sequenceForTrigger.mockResolvedValue(undefined);
    kept.followup.liveEnrollment.mockResolvedValue({ id: 'enr-1', enrolledBy: 'manual', sequence: { code: 'X' } });
    await kept.engine.qualified(ORG, LEAD, 'warm', undefined, { callbackRequested: true });
    expect(kept.guard.flagReview).not.toHaveBeenCalled();
  });
});
