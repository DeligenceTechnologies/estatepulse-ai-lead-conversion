import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FollowupRunner } from './followup.runner';

/** Characterization: what a due sequence step sends, what holds it back, and how the enrolment moves on. */

const ORG = 'org-1';
const LEAD = 'lead-1';
const row = { id: 'enr-1', organization_id: ORG, lead_id: LEAD, sequence_id: 'seq-1', current_step: 1, attempts: 1 };
const DUE = new Date('2026-10-26T16:00:00Z');

function setup(stepList: Record<string, unknown>[], opts: { lead?: Record<string, unknown> | null; claimed?: Record<string, unknown> } = {}) {
  const lead = opts.lead === null ? null : { firstName: 'Asha', phone: '+12895550111', status: 'follow_up', dncStatus: false, automationPaused: false, ...opts.lead };
  const txLead = { updateMany: vi.fn() };
  const prisma = {
    $executeRaw: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn().mockResolvedValue([{ ...row, ...opts.claimed }]),
    lead: { findUnique: vi.fn().mockResolvedValue(lead) },
    sequence: { findUnique: vi.fn().mockResolvedValue({ steps: stepList }) },
    organization: { findUnique: vi.fn().mockResolvedValue({ name: 'Acme Realty' }) },
    sequenceEnrollment: { update: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(async (run: (t: unknown) => Promise<unknown>) => run({ sequenceEnrollment: prisma.sequenceEnrollment, lead: txLead })),
  };
  const config = { get: vi.fn((key: string) => ({ FOLLOWUP_BATCH_SIZE: 20, FOLLOWUP_STUCK_AFTER_MS: 600_000 })[key]) };
  const followup = { guardrailsFor: vi.fn().mockResolvedValue({ timeZone: 'UTC', quiet: undefined }), dueAt: vi.fn().mockResolvedValue(DUE) };
  const sms = { sendSms: vi.fn().mockResolvedValue({ id: 'msg-1' }) };
  const calls = { enqueue: vi.fn().mockResolvedValue('job-1') };
  const activity = { recordSms: vi.fn(), recordCallFailed: vi.fn() };
  // Nothing on the calendar, no call live or awaiting its score: every step is free to go, as before the safety rules.
  const guard = { check: vi.fn().mockResolvedValue({ kind: 'go' }), conditionUnmet: vi.fn().mockResolvedValue(null), record: vi.fn(), markBooked: vi.fn() };
  const runner = new FollowupRunner(prisma as any, config as any, followup as any, sms as any, calls as any, activity as any, guard as any);
  return { tick: () => (runner as any).tick() as Promise<void>, prisma, txLead, followup, sms, calls, activity, guard };
}

const smsStep = { actionType: 'sms', delayMinutes: 0, messageTemplate: 'Hi {{firstName}} from {{brokerage}}', voicePrompt: null, maxAttempts: 1 };
const voiceStep = { actionType: 'voice', delayMinutes: 60, messageTemplate: null, voicePrompt: 'Check in', maxAttempts: 1 };

const updateFor = (prisma: ReturnType<typeof setup>['prisma']) => prisma.sequenceEnrollment.update.mock.calls.map((c) => c[0].data);

describe('FollowupRunner', () => {
  beforeEach(() => vi.clearAllMocks());

  it('texts an SMS step, records it, and schedules the next step its delay after this one', async () => {
    const { tick, sms, activity, prisma, followup } = setup([smsStep, voiceStep]);
    await tick();
    expect(sms.sendSms).toHaveBeenCalledWith(ORG, '+12895550111', 'Hi Asha from Acme Realty');
    expect(activity.recordSms).toHaveBeenCalledWith(ORG, LEAD, 'Hi Asha from Acme Realty', true, 'msg-1');
    expect(followup.dueAt).toHaveBeenCalledWith(ORG, 60);
    expect(prisma.sequenceEnrollment.update).toHaveBeenCalledWith({
      where: { id: 'enr-1' },
      data: { currentStep: 2, nextActionAt: DUE, lockedBy: null, lockedAt: null, lastError: null },
    });
  });

  it('records a failed text and still moves on', async () => {
    const { tick, sms, activity, prisma } = setup([smsStep, voiceStep]);
    sms.sendSms.mockRejectedValue(new Error('No Telnyx account'));
    await tick();
    expect(activity.recordSms).toHaveBeenCalledWith(ORG, LEAD, 'Hi Asha from Acme Realty', false, 'No Telnyx account');
    expect(updateFor(prisma)).toContainEqual(expect.objectContaining({ currentStep: 2 }));
  });

  it('queues a voice step, keyed by enrolment and step', async () => {
    const { tick, calls } = setup([voiceStep, smsStep]);
    await tick();
    // Audit fix A4 added the enrolment, so the worker can drop the call once it has stopped.
    expect(calls.enqueue).toHaveBeenCalledWith({ orgId: ORG, leadId: LEAD, source: 'followup', sequenceId: 'seq-1', enrollmentId: 'enr-1' }, { dedupeKey: 'followup:enr-1:1' });
  });

  it('records a failed call when the queue refuses the job', async () => {
    const { tick, calls, activity } = setup([voiceStep, smsStep]);
    calls.enqueue.mockRejectedValue(new Error('The call queue is unavailable'));
    await tick();
    expect(activity.recordCallFailed).toHaveBeenCalledWith(ORG, LEAD, 'The call queue is unavailable');
  });

  it('after the last step completes the enrolment and closes a lead still in follow-up as not interested', async () => {
    const { tick, prisma, txLead } = setup([smsStep]);
    await tick();
    expect(updateFor(prisma)).toContainEqual(expect.objectContaining({ status: 'completed', nextActionAt: null }));
    expect(txLead.updateMany).toHaveBeenCalledWith({
      where: { id: LEAD, status: 'follow_up' },
      data: { status: 'not_interested', lostReason: 'Follow-up sequence exhausted with no response' },
    });
  });

  it('completes an enrolment whose step no longer exists without sending', async () => {
    const { tick, sms, prisma } = setup([smsStep], { claimed: { current_step: 3 } });
    await tick();
    expect(sms.sendSms).not.toHaveBeenCalled();
    expect(updateFor(prisma)).toContainEqual(expect.objectContaining({ status: 'completed' }));
  });

  it.each([
    ['opted out', { dncStatus: true }, { status: 'stopped', stoppedReason: 'opted_out' }],
    ['booked', { status: 'appointment_booked' }, { status: 'stopped', stoppedReason: 'lead_appointment_booked' }],
    ['paused by a reply', { automationPaused: true }, { status: 'paused', nextActionAt: null }],
  ])('sends nothing to a lead who %s', async (_label, lead, expected) => {
    const { tick, sms, calls, prisma } = setup([smsStep], { lead });
    await tick();
    expect(sms.sendSms).not.toHaveBeenCalled();
    expect(calls.enqueue).not.toHaveBeenCalled();
    expect(updateFor(prisma)).toContainEqual(expect.objectContaining(expected));
  });

  it('stops the enrolment of a deleted lead', async () => {
    const { tick, prisma } = setup([smsStep], { lead: null });
    await tick();
    expect(updateFor(prisma)).toContainEqual(expect.objectContaining({ status: 'stopped', stoppedReason: 'lead_deleted' }));
  });

  it('holds a step due inside quiet hours until they end', async () => {
    const { tick, sms, prisma, followup } = setup([smsStep]);
    followup.guardrailsFor.mockResolvedValue({ timeZone: 'UTC', quiet: { start: '00:00', end: '23:59' } });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T12:00:00Z'));
    await tick();
    vi.useRealTimers();
    expect(sms.sendSms).not.toHaveBeenCalled();
    expect(updateFor(prisma)).toEqual([{ nextActionAt: new Date('2026-10-26T23:59:00Z'), lockedBy: null, lockedAt: null }]);
  });

  it('retries a failed step with backoff and gives up after six attempts', async () => {
    const first = setup([smsStep]);
    first.prisma.sequence.findUnique.mockRejectedValue(new Error('db down'));
    await first.tick();
    expect(updateFor(first.prisma)[0]).toEqual(expect.objectContaining({ lastError: 'db down', nextActionAt: expect.any(Date) }));

    const last = setup([smsStep], { claimed: { attempts: 6 } });
    last.prisma.sequence.findUnique.mockRejectedValue(new Error('db down'));
    await last.tick();
    expect(updateFor(last.prisma)[0]).toEqual(expect.objectContaining({ status: 'stopped', stoppedReason: 'failed', nextActionAt: null }));
  });
});
