import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CallingProviders, TelnyxCallingProvider } from '@/calling/calling-providers';
import { FollowupRunner } from './followup.runner';

/** Characterization: what a due sequence step sends, through Telnyx SMS or the call queue. */

const ORG = 'org-1';
const LEAD = 'lead-1';
const row = { id: 'enr-1', organization_id: ORG, lead_id: LEAD, sequence_id: 'seq-1', current_step: 1, attempts: 1 };

function setup(stepList: Record<string, unknown>[], lead: Record<string, unknown> = {}) {
  const prisma = {
    $executeRaw: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn().mockResolvedValue([row]),
    lead: { findUnique: vi.fn().mockResolvedValue({ firstName: 'Asha', phone: '+12895550111', status: 'follow_up', dncStatus: false, automationPaused: false, ...lead }) },
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
  // RETELL_ENABLED off: the real registry hands the text to the real Telnyx wrapper, which hands it to `sms`.
  const providers = new CallingProviders(config as any, {} as any, new TelnyxCallingProvider({} as any, sms as any, {} as any), {} as any);
  const runner = new FollowupRunner(prisma as any, config as any, followup as any, providers, calls as any, activity as any);
  return { tick: () => (runner as any).tick() as Promise<void>, prisma, sms, calls, activity };
}

const smsStep = { actionType: 'sms', delayMinutes: 0, messageTemplate: 'Hi {{firstName}} from {{brokerage}}', voicePrompt: null, maxAttempts: 1 };
const voiceStep = { actionType: 'voice', delayMinutes: 60, messageTemplate: null, voicePrompt: null, maxAttempts: 1 };

describe('FollowupRunner', () => {
  beforeEach(() => vi.clearAllMocks());

  it('texts an SMS step through Telnyx SMS, records it and moves to the next step', async () => {
    const { tick, sms, activity, prisma } = setup([smsStep, voiceStep]);
    await tick();
    expect(sms.sendSms).toHaveBeenCalledWith(ORG, '+12895550111', 'Hi Asha from Acme Realty');
    expect(activity.recordSms).toHaveBeenCalledWith(ORG, LEAD, 'Hi Asha from Acme Realty', true, 'msg-1');
    expect(prisma.sequenceEnrollment.update).toHaveBeenCalledWith({
      where: { id: 'enr-1' },
      data: expect.objectContaining({ currentStep: 2, lockedBy: null, lastError: null }),
    });
  });

  it('records a failed text without failing the step', async () => {
    const { tick, sms, activity } = setup([smsStep, voiceStep]);
    sms.sendSms.mockRejectedValue(new Error('No provider connected'));
    await tick();
    expect(activity.recordSms).toHaveBeenCalledWith(ORG, LEAD, 'Hi Asha from Acme Realty', false, 'No provider connected');
  });

  it('queues a voice step, keyed by enrolment and step', async () => {
    const { tick, calls } = setup([voiceStep, smsStep]);
    await tick();
    expect(calls.enqueue).toHaveBeenCalledWith({ orgId: ORG, leadId: LEAD, source: 'followup', sequenceId: 'seq-1' }, { dedupeKey: 'followup:enr-1:1' });
  });

  it('records a failed call when the queue refuses the job', async () => {
    const { tick, calls, activity } = setup([voiceStep, smsStep]);
    calls.enqueue.mockRejectedValue(new Error('The call queue is unavailable'));
    await tick();
    expect(activity.recordCallFailed).toHaveBeenCalledWith(ORG, LEAD, 'The call queue is unavailable', 'telnyx');
  });

  it('skips an SMS step for a provider without SMS, never calling it, and moves on', async () => {
    const { prisma, sms, calls, activity } = setup([smsStep, voiceStep]);
    const noSms = { name: 'retell', capabilities: { sms: false }, sendSms: vi.fn() };
    const providers = { for: vi.fn().mockResolvedValue(noSms), nameFor: vi.fn().mockResolvedValue('retell') };
    const config = { get: vi.fn((key: string) => ({ FOLLOWUP_BATCH_SIZE: 20, FOLLOWUP_STUCK_AFTER_MS: 600_000 })[key]) };
    const followup = { guardrailsFor: vi.fn().mockResolvedValue({ timeZone: 'UTC', quiet: undefined }), dueAt: vi.fn().mockResolvedValue(new Date()) };
    const runner = new FollowupRunner(prisma as any, config as any, followup as any, providers as any, calls as any, activity as any);
    await (runner as any).tick();
    expect(noSms.sendSms).not.toHaveBeenCalled();
    expect(sms.sendSms).not.toHaveBeenCalled();
    expect(activity.recordSms).not.toHaveBeenCalled();
    expect(prisma.sequenceEnrollment.update).toHaveBeenCalledWith({ where: { id: 'enr-1' }, data: expect.objectContaining({ currentStep: 2 }) });
  });

  it('sends nothing to a lead who opted out', async () => {
    const { tick, sms, calls } = setup([smsStep], { dncStatus: true });
    await tick();
    expect(sms.sendSms).not.toHaveBeenCalled();
    expect(calls.enqueue).not.toHaveBeenCalled();
  });
});
