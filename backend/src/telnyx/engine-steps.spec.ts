import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inQuietHours } from '@/common/utils/quiet-hours';
import { EngineService, remainingSteps } from './engine.service';
import type { StrategyStep } from './strategy-store.service';

/** Characterization: what each strategy step sends, when, and what holds it back or ends it. */

vi.mock('@/common/utils/quiet-hours', async (original) => ({
  ...(await original<typeof import('@/common/utils/quiet-hours')>()),
  inQuietHours: vi.fn(() => false),
  deferredResume: vi.fn(({ now }: { now: number }) => ({ shift: 0, resumeAt: now + 3_600_000 })),
}));

const ORG = 'org-1';
const LEAD = 'lead-1';
const NOW = new Date('2026-10-26T15:00:00Z');
const MIN = 60_000;

/** The default cadence: text at once, call a minute later, text again at five minutes. */
const steps: StrategyStep[] = [
  { id: 's1', after: { value: 0, unit: 'minutes' }, channel: 'sms', message: 'Hi {{firstName}}, this is {{brokerage}}. {{firstName}}?' },
  { id: 's2', after: { value: 1, unit: 'minutes' }, channel: 'voice' },
  { id: 's3', after: { value: 5, unit: 'minutes' }, channel: 'sms', message: 'Just tried you, {{firstName}}.' },
];

function setup(opts: { lead?: Record<string, unknown>; steps?: StrategyStep[]; guardrails?: Record<string, unknown> } = {}) {
  const live = { id: LEAD, orgId: ORG, firstName: ' Asha ', phone: '+12895550111', status: 'contacting', dncStatus: false, automationPaused: false, aiSummary: null, ...opts.lead };
  const tx = { lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), update: vi.fn() } };
  const prisma = {
    lead: {
      findFirst: vi.fn().mockResolvedValue({ ...live, dncStatus: false, automationPaused: false }),
      findUnique: vi.fn().mockResolvedValue(live),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    call: { count: vi.fn().mockResolvedValue(0) },
    message: { count: vi.fn().mockResolvedValue(0) },
    organization: { findUnique: vi.fn().mockResolvedValue({ name: 'Acme Realty', settings: { timezone: 'UTC' } }) },
    $transaction: vi.fn(async (run: (t: typeof tx) => Promise<unknown>) => run(tx)),
  };
  const strategies = {
    getStrategy: vi.fn().mockResolvedValue({
      name: 'Default',
      guardrails: { respectQuietHours: true, quietHours: { start: '21:00', end: '08:00' }, maxVoiceAttempts: 3, ...opts.guardrails },
      steps: opts.steps ?? steps,
    }),
  };
  const sms = { sendSms: vi.fn().mockResolvedValue({ id: 'msg-1' }) };
  const calls = { enqueue: vi.fn().mockResolvedValue('job-1') };
  const activity = { recordSms: vi.fn(), recordCallFailed: vi.fn(), exitStrategy: vi.fn() };
  const followup = { sequenceForTrigger: vi.fn(), enroll: vi.fn().mockResolvedValue(true), stopForLead: vi.fn(), liveEnrollment: vi.fn().mockResolvedValue(null) };
  // Nothing on the calendar, no call live or answered: every step is free to go, as before the safety rules.
  const guard = {
    check: vi.fn().mockResolvedValue({ kind: 'go' }),
    conditionUnmet: vi.fn().mockResolvedValue(null),
    lastRunAt: vi.fn().mockResolvedValue(null),
    lastCallEndedAt: vi.fn().mockResolvedValue(null),
    isScoredCall: vi.fn().mockResolvedValue(true),
    record: vi.fn(),
    flagReview: vi.fn(),
    clearReview: vi.fn(),
  };
  const engine = new EngineService(prisma as any, strategies as any, sms as any, calls as any, activity as any, followup as any, guard as any);
  return { engine, prisma, tx, strategies, sms, calls, activity, followup, guard, live };
}

describe('EngineService steps', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(NOW);
    vi.mocked(inQuietHours).mockReturnValue(false);
  });
  afterEach(() => vi.useRealTimers());

  it('claims the lead once and moves it from new to contacting', async () => {
    const { engine, tx } = setup();
    await engine.enroll(ORG, LEAD);
    expect(tx.lead.updateMany).toHaveBeenNthCalledWith(1, { where: { id: LEAD, firstContactAt: null }, data: { firstContactAt: NOW } });
    expect(tx.lead.updateMany).toHaveBeenNthCalledWith(2, { where: { id: LEAD, status: 'new' }, data: { status: 'contacting' } });
    expect(engine.isRunning(LEAD)).toBe(true);
  });

  it('does not run a lead another instance already claimed', async () => {
    const { engine, tx, sms } = setup();
    tx.lead.updateMany.mockResolvedValueOnce({ count: 0 });
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(engine.isRunning(LEAD)).toBe(false);
    expect(sms.sendSms).not.toHaveBeenCalled();
  });

  it('texts the templated message and records it', async () => {
    const { engine, sms, activity } = setup();
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(0);
    expect(sms.sendSms).toHaveBeenCalledWith(ORG, '+12895550111', 'Hi Asha, this is Acme Realty. Asha?');
    expect(activity.recordSms).toHaveBeenCalledWith(ORG, LEAD, 'Hi Asha, this is Acme Realty. Asha?', true, 'msg-1');
  });

  it('records the failure when the text cannot be sent', async () => {
    const { engine, sms, activity } = setup();
    sms.sendSms.mockRejectedValue(new Error('No Telnyx account'));
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(0);
    expect(activity.recordSms).toHaveBeenCalledWith(ORG, LEAD, expect.any(String), false, 'No Telnyx account');
  });

  it('queues the voice step with a key that never dials twice', async () => {
    const { engine, calls } = setup();
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(MIN);
    expect(calls.enqueue).toHaveBeenCalledOnce();
    expect(calls.enqueue).toHaveBeenCalledWith({ orgId: ORG, leadId: LEAD, source: 'strategy' }, { dedupeKey: `strategy:${LEAD}:${NOW.getTime()}:1` });
  });

  it('stops queueing calls at the attempt limit', async () => {
    const voice = (id: string, value: number): StrategyStep => ({ id, after: { value, unit: 'minutes' }, channel: 'voice' });
    const { engine, calls } = setup({ steps: [voice('a', 0), voice('b', 1), voice('c', 2)], guardrails: { maxVoiceAttempts: 2 } });
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(3 * MIN);
    expect(calls.enqueue).toHaveBeenCalledTimes(2);
  });

  it('records a failed call when the queue refuses the job', async () => {
    const { engine, calls, activity } = setup();
    calls.enqueue.mockRejectedValue(new Error('The call queue is unavailable'));
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(MIN);
    expect(activity.recordCallFailed).toHaveBeenCalledWith(ORG, LEAD, 'The call queue is unavailable');
  });

  it('times every step from enrolment, not from the step before it', async () => {
    const { engine, sms, calls } = setup();
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(5 * MIN - 1);
    expect(sms.sendSms).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sms.sendSms).toHaveBeenCalledTimes(2);
    expect(calls.enqueue).toHaveBeenCalledOnce();
  });

  // Today the step after a call goes on schedule whatever the call did: still queued, ringing, answered or in progress.
  it('sends the step after a call without looking at the call', async () => {
    const { engine, sms } = setup();
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(sms.sendSms).toHaveBeenLastCalledWith(ORG, '+12895550111', 'Just tried you, Asha.');
  });

  it('holds every step during quiet hours', async () => {
    vi.mocked(inQuietHours).mockReturnValue(true);
    const { engine, sms, calls } = setup();
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(sms.sendSms).not.toHaveBeenCalled();
    expect(calls.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ['opted out', { dncStatus: true }],
    ['paused by a reply', { automationPaused: true }],
    ['booked', { status: 'appointment_booked' }],
    ['interested', { status: 'interested' }],
  ])('stops when the lead was %s before the step ran', async (_label, lead) => {
    const { engine, sms, calls } = setup({ lead });
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(sms.sendSms).not.toHaveBeenCalled();
    expect(calls.enqueue).not.toHaveBeenCalled();
    expect(engine.isRunning(LEAD)).toBe(false);
  });

  it('parks the lead for follow-up after the last step and enrols the sequence for its reason', async () => {
    const { engine, prisma, activity, followup } = setup();
    followup.sequenceForTrigger.mockResolvedValue('NO_ANSWER');
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    prisma.lead.findFirst.mockResolvedValue({ status: 'follow_up', followUpReason: 'no_answer' });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(activity.exitStrategy).toHaveBeenCalledWith(LEAD, expect.stringContaining('Strategy complete after 3 step(s)'));
    expect(followup.sequenceForTrigger).toHaveBeenCalledWith(ORG, 'follow_up_no_answer');
    expect(followup.enroll).toHaveBeenCalledWith(ORG, LEAD, 'NO_ANSWER');
    expect(engine.isRunning(LEAD)).toBe(false);
  });
});

describe('EngineService outcomes', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('a booking marks the lead booked, ends the strategy and stops its sequences', async () => {
    const { engine, prisma, sms, activity, followup } = setup();
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(0);
    prisma.lead.findFirst.mockResolvedValue({ id: LEAD, status: 'contacting', dncStatus: false });
    await engine.appointmentBooked(ORG, LEAD);
    expect(prisma.lead.update).toHaveBeenCalledWith({ where: { id: LEAD }, data: { status: 'appointment_booked' } });
    expect(activity.exitStrategy).toHaveBeenCalledWith(LEAD, 'Appointment booked — strategy stopped');
    expect(followup.stopForLead).toHaveBeenCalledWith(ORG, LEAD, 'appointment_booked');
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(sms.sendSms).toHaveBeenCalledOnce();
  });

  // Changed by audit fix D4: a hot lead used to be enrolled in a "Qualified as hot" sequence that could never send.
  it('a hot score hands the lead to an agent, and enrols it in nothing', async () => {
    const { engine, prisma, followup } = setup();
    followup.sequenceForTrigger.mockImplementation(async (_o: string, t: string) => (t === 'qualified_hot' ? 'HOT' : undefined));
    await engine.qualified(ORG, LEAD, 'hot', 'HOT — 90.');
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({ where: { id: LEAD, orgId: ORG }, data: { status: 'interested', temperature: 'hot', aiSummary: 'HOT — 90.' } });
    expect(followup.sequenceForTrigger).not.toHaveBeenCalled();
    expect(followup.enroll).not.toHaveBeenCalled();
  });

  it('a warm score parks the lead as not ready, preferring the follow-up sequence over the temperature one', async () => {
    const { engine, prisma, followup } = setup();
    prisma.lead.findFirst.mockResolvedValue({ status: 'contacting', followUpReason: null });
    followup.sequenceForTrigger.mockImplementation(async (_o: string, t: string) => ({ follow_up_not_ready: 'NOT_READY', qualified_warm: 'WARM' })[t]);
    await engine.qualified(ORG, LEAD, 'warm');
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({ where: { id: LEAD, orgId: ORG }, data: { status: 'follow_up', followUpReason: 'not_ready', temperature: 'warm' } });
    expect(followup.enroll).toHaveBeenCalledWith(ORG, LEAD, 'NOT_READY');
  });

  it('a callback request is kept as the follow-up reason', async () => {
    const { engine, prisma, followup } = setup();
    prisma.lead.findFirst.mockResolvedValue({ status: 'contacting', followUpReason: null });
    followup.sequenceForTrigger.mockResolvedValue(undefined);
    await engine.qualified(ORG, LEAD, 'cold', undefined, { callbackRequested: true });
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({ where: { id: LEAD, orgId: ORG }, data: { status: 'follow_up', followUpReason: 'callback_requested', temperature: 'cold' } });
    expect(followup.sequenceForTrigger).toHaveBeenCalledWith(ORG, 'follow_up_callback_requested');
    expect(followup.enroll).not.toHaveBeenCalled();
  });

  // Changed by safety rule A4 (approved 2026-10-26). Before it, a lead already in a sequence kept it whatever the new
  // score said (enroll refused a second live enrolment); now an automatic enrolment moves to the sequence the score points at.
  it('a new score moves a lead out of the automatic sequence it is in, into the one the score points at', async () => {
    const { engine, prisma, followup } = setup();
    prisma.lead.findFirst.mockResolvedValue({ status: 'follow_up', followUpReason: 'no_answer' });
    followup.sequenceForTrigger.mockImplementation(async (_o: string, t: string) => (t === 'qualified_warm' ? 'WARM' : undefined));
    followup.liveEnrollment.mockResolvedValue({ id: 'enr-1', enrolledBy: 'auto', sequence: { code: 'NO_ANSWER' } });
    await engine.qualified(ORG, LEAD, 'warm');
    expect(followup.stopForLead).toHaveBeenCalledWith(ORG, LEAD, 'rescored');
    expect(followup.enroll).toHaveBeenCalledWith(ORG, LEAD, 'WARM');
  });

  it('an opt-out sets do-not-contact and stops the sequences in one transaction', async () => {
    const { engine, tx, followup } = setup();
    await engine.setStatus(ORG, LEAD, 'not_interested' as any, 'Asked to stop', { optOut: true });
    expect(tx.lead.update).toHaveBeenCalledWith({
      where: { id: LEAD },
      data: expect.objectContaining({ status: 'not_interested', dncStatus: true, automationPaused: true, consentStatus: 'revoked' }),
    });
    expect(followup.stopForLead).toHaveBeenCalledWith(ORG, LEAD, 'opted_out', tx);
  });
});

describe('EngineService resume', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('after a restart runs only the steps the calls and texts on record do not account for', async () => {
    const { engine, prisma, sms, calls } = setup();
    prisma.lead.findFirst.mockResolvedValue({ firstContactAt: new Date(NOW.getTime() - 2 * MIN), status: 'contacting', dncStatus: false, automationPaused: false });
    prisma.call.count.mockResolvedValue(1);
    prisma.message.count.mockResolvedValue(1);
    expect(await engine.resume(ORG, LEAD)).toBe(true);
    await vi.advanceTimersByTimeAsync(3 * MIN);
    expect(calls.enqueue).not.toHaveBeenCalled();
    expect(sms.sendSms).toHaveBeenCalledOnce();
    expect(sms.sendSms).toHaveBeenCalledWith(ORG, '+12895550111', 'Just tried you, Asha.');
  });
});

describe('remainingSteps', () => {
  it('skips the calls and texts already on record and keeps the spacing', () => {
    const enrolledAt = 1_000_000;
    const { remaining, anchor } = remainingSteps(steps, 1, 1, enrolledAt, enrolledAt + 2 * MIN);
    expect(remaining.map((s) => s.id)).toEqual(['s3']);
    expect(anchor).toBe(enrolledAt);
    expect(remainingSteps(steps, 0, 0, enrolledAt, enrolledAt + 5 * MIN).anchor).toBe(enrolledAt + 5 * MIN);
  });
});
