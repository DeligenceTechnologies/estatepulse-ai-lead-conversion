import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FollowupRunner } from './followup.runner';

/** The safety rules as a sequence step sees them: held while a call is live or awaiting its score, stopped by a booking. */

const ORG = 'org-1';
const LEAD = 'lead-1';
const ENROLLED = new Date('2026-10-26T14:00:00Z');
const row = { id: 'enr-1', organization_id: ORG, lead_id: LEAD, sequence_id: 'seq-1', current_step: 2, attempts: 3, enrolled_at: ENROLLED };

const smsStep = { actionType: 'sms', delayMinutes: 5, messageTemplate: 'Hi {{firstName}}', voicePrompt: null, maxAttempts: 1 };
const voiceStep = { actionType: 'voice', delayMinutes: 60, messageTemplate: null, voicePrompt: 'Check in', maxAttempts: 1 };

function setup(stepList: Record<string, unknown>[]) {
  const prisma = {
    $executeRaw: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn().mockResolvedValue([row]),
    lead: { findUnique: vi.fn().mockResolvedValue({ firstName: 'Asha', phone: '+12895550111', status: 'follow_up', dncStatus: false, automationPaused: false }) },
    sequence: { findUnique: vi.fn().mockResolvedValue({ steps: stepList }) },
    organization: { findUnique: vi.fn().mockResolvedValue({ name: 'Acme Realty' }) },
    sequenceEnrollment: { update: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(async (run: (t: unknown) => Promise<unknown>) => run({ sequenceEnrollment: prisma.sequenceEnrollment, lead: { updateMany: vi.fn() } })),
  };
  const config = { get: vi.fn((key: string) => ({ FOLLOWUP_BATCH_SIZE: 20, FOLLOWUP_STUCK_AFTER_MS: 600_000 })[key]) };
  const followup = { guardrailsFor: vi.fn().mockResolvedValue({ timeZone: 'UTC', quiet: undefined }), dueAt: vi.fn().mockResolvedValue(new Date()) };
  const sms = { sendSms: vi.fn().mockResolvedValue({ id: 'msg-1' }) };
  const calls = { enqueue: vi.fn().mockResolvedValue('job-1') };
  const activity = { recordSms: vi.fn(), recordCallFailed: vi.fn() };
  const guard = { check: vi.fn().mockResolvedValue({ kind: 'go' }), conditionUnmet: vi.fn().mockResolvedValue(null), record: vi.fn(), markBooked: vi.fn() };
  const runner = new FollowupRunner(prisma as any, config as any, followup as any, sms as any, calls as any, activity as any, guard as any);
  return { tick: () => (runner as any).tick() as Promise<void>, prisma, sms, calls, guard };
}

describe('FollowupRunner safety rules', () => {
  beforeEach(() => vi.clearAllMocks());

  it('asks the guard about this enrolment, from when the lead was enrolled', async () => {
    const { tick, guard } = setup([voiceStep, smsStep]);
    await tick();
    expect(guard.check).toHaveBeenCalledWith({ orgId: ORG, leadId: LEAD, since: ENROLLED, endOnAnswer: false });
  });

  it('holds a step while a call is live: nothing sent, looked at again, and the hold is not a failed attempt', async () => {
    const { tick, guard, sms, prisma } = setup([voiceStep, smsStep]);
    const until = Date.now() + 60_000;
    guard.check.mockResolvedValue({ kind: 'wait', until, reason: 'call_live' });
    await tick();
    expect(sms.sendSms).not.toHaveBeenCalled();
    expect(prisma.sequenceEnrollment.update).toHaveBeenCalledWith({
      where: { id: 'enr-1' },
      data: { nextActionAt: new Date(until), lockedBy: null, lockedAt: null, attempts: 2 },
    });
  });

  it('a meeting on the calendar books the lead and stops the enrolment', async () => {
    const { tick, guard, sms, prisma } = setup([voiceStep, smsStep]);
    guard.check.mockResolvedValue({ kind: 'booked' });
    await tick();
    expect(sms.sendSms).not.toHaveBeenCalled();
    expect(guard.markBooked).toHaveBeenCalledWith(ORG, LEAD);
    expect(guard.record).toHaveBeenCalledWith(expect.objectContaining({ runKey: 'followup:enr-1:2', outcome: 'skipped', reason: 'booked' }));
    expect(prisma.sequenceEnrollment.update).toHaveBeenCalledWith({ where: { id: 'enr-1' }, data: expect.objectContaining({ status: 'stopped', stoppedReason: 'lead_appointment_booked' }) });
  });

  it('records what each step did', async () => {
    const texted = setup([voiceStep, smsStep]);
    await texted.tick();
    expect(texted.guard.record).toHaveBeenCalledWith({
      orgId: ORG, leadId: LEAD, source: 'followup', enrollmentId: 'enr-1', runKey: 'followup:enr-1:2', stepNumber: 2, channel: 'sms', outcome: 'sent',
    });

    const called = setup([smsStep, voiceStep]);
    await called.tick();
    expect(called.guard.record).toHaveBeenCalledWith(expect.objectContaining({ channel: 'voice', outcome: 'queued', callKey: 'followup:enr-1:2' }));
  });
});

describe('FollowupRunner stuck call', () => {
  it('a call stuck in the queue for a day: the step is skipped with the reason and the enrolment moves on', async () => {
    const { tick, guard, sms, prisma } = setup([voiceStep, smsStep, voiceStep]);
    guard.check.mockResolvedValue({ kind: 'stuck' });
    await tick();
    expect(sms.sendSms).not.toHaveBeenCalled();
    expect(guard.conditionUnmet).not.toHaveBeenCalled();
    expect(guard.record).toHaveBeenCalledWith(expect.objectContaining({ stepNumber: 2, outcome: 'skipped', reason: 'call_still_queued' }));
    expect(prisma.sequenceEnrollment.update).toHaveBeenCalledWith({ where: { id: 'enr-1' }, data: expect.objectContaining({ currentStep: 3 }) });
  });
});

describe('FollowupRunner step conditions', () => {
  it('a step whose condition does not hold is recorded as skipped, nothing is sent, and the enrolment moves on', async () => {
    const { tick, guard, sms, calls, prisma } = setup([voiceStep, { ...smsStep, condition: 'call_not_answered' }, voiceStep]);
    guard.conditionUnmet.mockResolvedValue({ reason: 'condition_not_met', detail: 'The call result was a conversation' });
    await tick();
    expect(guard.conditionUnmet).toHaveBeenCalledWith(
      { match: 'all', rules: [{ field: 'call_result', op: 'in', value: ['no_answer', 'voicemail', 'busy', 'short_pickup'] }] },
      { orgId: ORG, leadId: LEAD, since: ENROLLED, callsSince: null },
    );
    expect(sms.sendSms).not.toHaveBeenCalled();
    expect(calls.enqueue).not.toHaveBeenCalled();
    expect(guard.record).toHaveBeenCalledWith(
      expect.objectContaining({ stepNumber: 2, outcome: 'skipped', reason: 'condition_not_met', detail: 'The call result was a conversation' }),
    );
    expect(prisma.sequenceEnrollment.update).toHaveBeenCalledWith({ where: { id: 'enr-1' }, data: expect.objectContaining({ currentStep: 3 }) });
  });
});

describe('FollowupRunner when the last step is a call (audit D1)', () => {
  const lastCall = [smsStep, voiceStep];

  it('the call is queued and the enrolment stays open, the lead untouched, until the call has an outcome', async () => {
    const { tick, calls, prisma } = setup(lastCall);
    await tick();
    expect(calls.enqueue).toHaveBeenCalledOnce();
    const data = prisma.sequenceEnrollment.update.mock.calls.map((c) => c[0].data);
    expect(data).toEqual([expect.objectContaining({ currentStep: 3, lockedBy: null, nextActionAt: expect.any(Date) })]);
    expect(data[0]).not.toHaveProperty('status');
  });

  it('past the last step, while the call is still live or awaiting its analysis: held', async () => {
    const { tick, guard, prisma } = setup(lastCall);
    prisma.$queryRaw.mockResolvedValue([{ ...row, current_step: 3 }]);
    guard.check.mockResolvedValue({ kind: 'wait', until: Date.now() + 60_000, reason: 'call_live' });
    await tick();
    expect(prisma.sequenceEnrollment.update).toHaveBeenCalledWith({ where: { id: 'enr-1' }, data: expect.objectContaining({ nextActionAt: expect.any(Date), attempts: 2 }) });
  });

  it('past the last step, the call done and the lead never reached: completed, and the lead closed as not interested', async () => {
    const { tick, guard, prisma } = setup(lastCall);
    const txLead = { updateMany: vi.fn() };
    prisma.$transaction.mockImplementation(async (run: any) => run({ sequenceEnrollment: prisma.sequenceEnrollment, lead: txLead }));
    prisma.$queryRaw.mockResolvedValue([{ ...row, current_step: 3 }]);
    await tick();
    expect(guard.conditionUnmet).toHaveBeenCalledWith('not_reached', { orgId: ORG, leadId: LEAD, since: ENROLLED });
    expect(prisma.sequenceEnrollment.update).toHaveBeenCalledWith({ where: { id: 'enr-1' }, data: expect.objectContaining({ status: 'completed' }) });
    expect(txLead.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'not_interested' }) }));
  });

  it('past the last step, the lead was reached (answered the call or replied): completed, never closed as not interested', async () => {
    const { tick, guard, prisma } = setup(lastCall);
    const txLead = { updateMany: vi.fn() };
    prisma.$transaction.mockImplementation(async (run: any) => run({ sequenceEnrollment: prisma.sequenceEnrollment, lead: txLead }));
    prisma.$queryRaw.mockResolvedValue([{ ...row, current_step: 3 }]);
    guard.conditionUnmet.mockResolvedValue({ reason: 'condition_not_met', detail: 'The lead replied' });
    await tick();
    expect(prisma.sequenceEnrollment.update).toHaveBeenCalledWith({ where: { id: 'enr-1' }, data: expect.objectContaining({ status: 'completed' }) });
    expect(txLead.updateMany).not.toHaveBeenCalled();
  });
});
