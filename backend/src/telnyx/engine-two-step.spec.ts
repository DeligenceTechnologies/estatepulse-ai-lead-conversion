import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inQuietHours } from '@/common/utils/quiet-hours';
import { EngineService } from './engine.service';
import type { StrategyStep } from './strategy-store.service';

/** The two-step strategy: step 2 waits its time after step 1 ran, and goes only when its condition holds. */

vi.mock('@/common/utils/quiet-hours', async (original) => ({
  ...(await original<typeof import('@/common/utils/quiet-hours')>()),
  inQuietHours: vi.fn(() => false),
}));

const ORG = 'org-1';
const LEAD = 'lead-1';
const NOW = new Date('2026-10-26T15:00:00Z');
const MIN = 60_000;

const callThenSms: StrategyStep[] = [
  { id: 'a', after: { value: 0, unit: 'minutes' }, channel: 'voice' },
  { id: 'b', after: { value: 5, unit: 'minutes' }, channel: 'sms', message: 'Sorry we missed you', condition: 'call_not_answered' },
];

function setup(steps: StrategyStep[] = callThenSms) {
  const live = { id: LEAD, orgId: ORG, firstName: 'Asha', phone: '+12895550111', status: 'contacting', dncStatus: false, automationPaused: false, aiSummary: null };
  const tx = { lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } };
  const prisma = {
    lead: { findFirst: vi.fn().mockResolvedValue(live), findUnique: vi.fn().mockResolvedValue(live), update: vi.fn(), updateMany: vi.fn() },
    call: { count: vi.fn().mockResolvedValue(0) },
    message: { count: vi.fn().mockResolvedValue(0) },
    organization: { findUnique: vi.fn().mockResolvedValue({ name: 'Acme Realty', settings: { timezone: 'UTC' } }) },
    $transaction: vi.fn(async (run: (t: typeof tx) => Promise<unknown>) => run(tx)),
  };
  const strategies = {
    getStrategy: vi.fn().mockResolvedValue({ name: 'Two-step', timing: 'after_previous', guardrails: { respectQuietHours: true, quietHours: { start: '21:00', end: '08:00' }, maxVoiceAttempts: 3 }, steps }),
  };
  const sms = { sendSms: vi.fn().mockResolvedValue({ id: 'msg-1' }) };
  const calls = { enqueue: vi.fn().mockResolvedValue('job-1') };
  const activity = { recordSms: vi.fn(), recordCallFailed: vi.fn(), exitStrategy: vi.fn() };
  const followup = { sequenceForTrigger: vi.fn(), enroll: vi.fn(), stopForLead: vi.fn(), liveEnrollment: vi.fn() };
  const guard = {
    check: vi.fn().mockResolvedValue({ kind: 'go' }),
    conditionUnmet: vi.fn().mockResolvedValue(null),
    stepRuns: vi.fn().mockResolvedValue([]),
    lastCallEndedAt: vi.fn().mockResolvedValue(null),
    record: vi.fn(),
    flagReview: vi.fn(),
    clearReview: vi.fn(),
  };
  const engine = new EngineService(prisma as any, strategies as any, sms as any, calls as any, activity as any, followup as any, guard as any, { get: () => true } as any);
  const runs = () => guard.record.mock.calls.map(([r]) => `${r.stepNumber}:${r.outcome}${r.reason ? `:${r.reason}` : ''}`);
  return { engine, prisma, sms, calls, guard, runs };
}

describe('EngineService two-step strategy', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(NOW);
    vi.mocked(inQuietHours).mockReturnValue(false);
  });
  afterEach(() => vi.useRealTimers());

  it('call then SMS: the text goes 5 minutes after the call step when the call was not answered', async () => {
    const { engine, sms, calls, guard, runs } = setup();
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.enqueue).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5 * MIN - 1);
    expect(sms.sendSms).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    // The older single condition reaches the guard as the rule set it means.
    expect(guard.conditionUnmet).toHaveBeenLastCalledWith(
      { match: 'all', rules: [{ field: 'call_result', op: 'in', value: ['no_answer', 'voicemail', 'busy', 'short_pickup'] }] },
      { orgId: ORG, leadId: LEAD, since: NOW },
    );
    expect(sms.sendSms).toHaveBeenCalledWith(ORG, '+12895550111', 'Sorry we missed you');
    expect(runs()).toEqual(['1:queued', '2:sent']);
  });

  it('call then SMS: the text is skipped, with why, when its condition does not hold', async () => {
    const { engine, sms, guard, runs } = setup();
    guard.conditionUnmet.mockResolvedValueOnce(null).mockResolvedValueOnce({ reason: 'condition_not_met', detail: 'The call result was a call that did not connect' });
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(sms.sendSms).not.toHaveBeenCalled();
    expect(runs()).toEqual(['1:queued', '2:skipped:condition_not_met']);
  });

  it('SMS then call: the call waits its time after the text', async () => {
    const steps: StrategyStep[] = [
      { id: 'a', after: { value: 0, unit: 'minutes' }, channel: 'sms', message: 'Hi' },
      { id: 'b', after: { value: 2, unit: 'minutes' }, channel: 'voice', condition: 'no_reply' },
    ];
    const { engine, calls, guard } = setup(steps);
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(2 * MIN - 1);
    expect(calls.enqueue).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(guard.conditionUnmet).toHaveBeenLastCalledWith({ match: 'all', rules: [{ field: 'sms_reply', op: 'is', value: 'not_replied' }] }, expect.anything());
    expect(calls.enqueue).toHaveBeenCalledOnce();
  });

  it('the wait counts from when step 1 really ran, not from enrolment', async () => {
    const { engine, sms, guard } = setup();
    // Step 1 is held 10 minutes (say a call from elsewhere was still live).
    guard.check.mockResolvedValueOnce({ kind: 'wait', until: NOW.getTime() + 10 * MIN, reason: 'call_live' });
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    await vi.advanceTimersByTimeAsync(5 * MIN - 1);
    expect(sms.sendSms).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sms.sendSms).toHaveBeenCalledOnce();
  });

  it('a step due in quiet hours goes when they end, and the next one waits its time after that', async () => {
    vi.setSystemTime(new Date('2026-10-26T22:00:00Z'));
    vi.mocked(inQuietHours).mockImplementation(() => {
      const h = new Date().getUTCHours();
      return h >= 21 || h < 8;
    });
    const { engine, calls, sms } = setup();
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(10 * 60 * MIN - 1);
    expect(calls.enqueue).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.enqueue).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(sms.sendSms).toHaveBeenCalledOnce();
  });

  it('after a restart, step 2 waits its time after step 1 ran, as the step record shows', async () => {
    const { engine, prisma, sms, guard } = setup();
    const contacted = new Date(NOW.getTime() - 10 * MIN);
    prisma.lead.findFirst.mockResolvedValue({ firstContactAt: contacted, status: 'contacting', dncStatus: false, automationPaused: false });
    guard.stepRuns.mockResolvedValue([{ stepNumber: 1, channel: 'voice', outcome: 'queued', createdAt: new Date(NOW.getTime() - 2 * MIN) }]);
    expect(await engine.resume(ORG, LEAD)).toBe(true);
    expect(guard.stepRuns).toHaveBeenCalledWith(LEAD, `strategy:${contacted.getTime()}:`);
    await vi.advanceTimersByTimeAsync(3 * MIN - 1);
    expect(sms.sendSms).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sms.sendSms).toHaveBeenCalledOnce();
  });
});

describe('EngineService quick actions', () => {
  it('pausing holds the strategy and the sequence; resuming picks both up', async () => {
    const { engine, prisma } = setup();
    const followup = (engine as any).followup;
    followup.pauseForLead = vi.fn();
    followup.resumeForLead = vi.fn();
    prisma.lead.findFirst.mockResolvedValue({ dncStatus: false, firstContactAt: NOW });
    const resume = vi.spyOn(engine, 'resume').mockResolvedValue(true);

    await engine.setAutomationPaused(ORG, LEAD, true);
    expect(prisma.lead.update).toHaveBeenCalledWith({ where: { id: LEAD }, data: { automationPaused: true } });
    expect(followup.pauseForLead).toHaveBeenCalledWith(ORG, LEAD);

    await engine.setAutomationPaused(ORG, LEAD, false);
    expect(prisma.lead.update).toHaveBeenLastCalledWith({ where: { id: LEAD }, data: { automationPaused: false } });
    expect(followup.resumeForLead).toHaveBeenCalledWith(ORG, LEAD);
    expect(resume).toHaveBeenCalledWith(ORG, LEAD);
  });

  it.each([
    ['opted out', { dncStatus: true, firstContactAt: NOW }, /opted out/],
    ['never started', { dncStatus: false, firstContactAt: null }, /has not started/],
  ])('will not resume a lead that %s', async (_label, lead, message) => {
    const { engine, prisma } = setup();
    prisma.lead.findFirst.mockResolvedValue(lead);
    await expect(engine.setAutomationPaused(ORG, LEAD, false)).rejects.toThrow(message);
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });

  // Changed by audit fix D2: a booking wins from any status but invalid (it used to refuse closed and opted-out leads).
  it('marking booked books the lead and stops its sequences; only an invalid lead is refused', async () => {
    const { engine, prisma } = setup();
    const followup = (engine as any).followup;
    prisma.lead.findFirst.mockResolvedValue({ id: LEAD, status: 'follow_up', dncStatus: false });
    await engine.markBooked(ORG, LEAD);
    expect(prisma.lead.update).toHaveBeenCalledWith({ where: { id: LEAD }, data: { status: 'appointment_booked' } });
    expect(followup.stopForLead).toHaveBeenCalledWith(ORG, LEAD, 'appointment_booked');

    prisma.lead.findFirst.mockResolvedValue({ status: 'invalid', dncStatus: false });
    await expect(engine.markBooked(ORG, LEAD)).rejects.toThrow(/invalid/);
  });
});
