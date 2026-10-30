import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SMS_READY } from '@/calling/calling-providers';
import { LeadStateService } from '@/lead/lead-state.service';
import { FollowupRunner } from './followup.runner';
import { DEFAULT_LIMITS } from './journey';

const CLOSE_OUT_AFTER_MS = 48 * 3_600_000;
const CHAT_QUIET_MS = 30 * 60_000;

const NOW = new Date('2026-10-26T10:00:00Z');
const smsStep = (text: string) => ({ actionType: 'sms', delayMinutes: 60, messageTemplate: text, voicePrompt: null, maxAttempts: 1 });
const voiceStep = () => ({ actionType: 'voice', delayMinutes: 60, messageTemplate: null, voicePrompt: 'call back', maxAttempts: 1 });

/** `smsOn` false: the organization calls through a provider without SMS (Retell). */
function setup(steps: unknown[], currentStep: number, smsOn = true) {
  const tx = {
    sequenceEnrollment: { update: vi.fn(async () => ({})) },
    lead: { findUnique: vi.fn(async () => ({ orgId: 'org-1', status: 'follow_up' })), updateMany: vi.fn(async () => ({ count: 1 })) },
    leadEvent: { create: vi.fn(async () => ({})) },
  };
  const prisma = {
    lead: { findUnique: vi.fn(async () => ({ firstName: 'Ana', phone: '+12895550100', status: 'follow_up', dncStatus: false, automationPaused: false })) },
    leadEvent: { create: vi.fn(async () => ({})), findFirst: vi.fn(async () => null as { createdAt: Date } | null) },
    message: { findFirst: vi.fn(async (_args?: any): Promise<any> => null) },
    call: { findFirst: vi.fn(async () => null as Record<string, unknown> | null) },
    sequence: { findUnique: vi.fn(async () => ({ steps, closeOutHours: 48, closeOutUnresponsive: true })) },
    organization: { findUnique: vi.fn(async () => ({ name: 'Acme Realty' })) },
    calendarMeeting: { count: vi.fn(async () => 0) },
    sequenceEnrollment: { update: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const followup = {
    guardrailsFor: vi.fn(async () => ({ timeZone: 'UTC', quiet: undefined, skipDays: [] as number[], limits: { ...DEFAULT_LIMITS } })),
    dueAt: vi.fn(async () => NOW),
    contactSlot: vi.fn(async () => ({ at: new Date(Date.now()), reason: null as string | null })),
  };
  const sms = { sendSms: vi.fn(async () => ({ id: 'msg-1' })) };
  const calls = { enqueue: vi.fn(async () => 'job-1') };
  const activity = { recordSms: vi.fn(), recordCallFailed: vi.fn(), leadVariables: vi.fn(async () => ({ firstName: 'Ana', location: 'Austin' })) };
  const conversations = { appendOurMessage: vi.fn(async () => undefined) };
  const runner = new FollowupRunner(
    prisma as any,
    { get: vi.fn() } as any,
    followup as any,
    {
      for: async () => ({
        name: smsOn ? 'telnyx' : 'retell',
        capabilities: { sms: true },
        smsCapability: async () => (smsOn ? SMS_READY : { available: false, state: 'not_configured', reason: 'SMS is not set up on Retell yet', deliveryReports: false }),
        sendSms: sms.sendSms,
      }),
      nameFor: async () => (smsOn ? 'telnyx' : 'retell'),
    } as any,
    calls as any,
    activity as any,
    new LeadStateService(prisma as any),
    conversations as any,
  );
  const row = { id: 'enr-1', organization_id: 'org-1', lead_id: 'lead-1', sequence_id: 'seq-1', current_step: currentStep, attempts: 1, enrolled_at: new Date('2026-10-25T10:00:00Z') };
  const execute = () => (runner as any).execute(row) as Promise<void>;
  return { execute, prisma, tx, sms, calls, followup, conversations };
}

describe('FollowupRunner last step', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('skips an SMS step for a provider without SMS (Retell) instead of sending or failing it, and moves on', async () => {
    const s = setup([smsStep('one'), smsStep('two')], 1, false);
    await s.execute();
    expect(s.sms.sendSms).not.toHaveBeenCalled();
    expect(s.prisma.sequenceEnrollment.update).toHaveBeenCalledWith({ where: { id: 'enr-1' }, data: expect.objectContaining({ currentStep: 2 }) });
  });

  it('sends the last step, then gives the lead time to answer instead of closing them out at once', async () => {
    const s = setup([smsStep('one'), smsStep('two')], 2);
    await s.execute();
    expect(s.sms.sendSms).toHaveBeenCalledWith('org-1', '+12895550100', 'two', { leadId: 'lead-1' });
    expect(s.prisma.sequenceEnrollment.update).toHaveBeenCalledWith({
      where: { id: 'enr-1' },
      data: expect.objectContaining({ currentStep: 3, nextActionAt: new Date(NOW.getTime() + CLOSE_OUT_AFTER_MS) }),
    });
    expect(s.tx.lead.updateMany).not.toHaveBeenCalled();
  });

  it('leaves the lead callable on a last-step call, so the worker does not drop it', async () => {
    const s = setup([smsStep('one'), voiceStep()], 2);
    await s.execute();
    expect(s.calls.enqueue).toHaveBeenCalledOnce();
    expect(s.tx.lead.updateMany).not.toHaveBeenCalled();
  });

  it('closes the lead out as unresponsive once the wait after the last step has passed in silence', async () => {
    const s = setup([smsStep('one'), smsStep('two')], 3);
    await s.execute();
    expect(s.sms.sendSms).not.toHaveBeenCalled();
    expect(s.tx.sequenceEnrollment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'completed' }) }),
    );
    expect(s.tx.lead.updateMany).toHaveBeenCalledWith({
      where: { id: 'lead-1', status: 'follow_up' },
      data: { status: 'unresponsive', lostReason: 'Follow-up sequence exhausted with no response' },
    });
    expect(s.tx.leadEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ fromStatus: 'follow_up', toStatus: 'unresponsive', source: 'followup' }),
    });
  });

  it("keeps to the sequence's own close-out: how long to wait, and whether to mark the lead unresponsive", async () => {
    const wait = setup([smsStep('one'), smsStep('two')], 2);
    wait.prisma.sequence.findUnique.mockResolvedValue({ steps: [smsStep('one'), smsStep('two')], closeOutHours: 120, closeOutUnresponsive: true } as any);
    await wait.execute();
    expect(wait.prisma.sequenceEnrollment.update).toHaveBeenCalledWith({
      where: { id: 'enr-1' },
      data: expect.objectContaining({ currentStep: 3, nextActionAt: new Date(NOW.getTime() + 120 * 3_600_000) }),
    });

    const keep = setup([smsStep('one'), smsStep('two')], 3);
    keep.prisma.sequence.findUnique.mockResolvedValue({ steps: [smsStep('one'), smsStep('two')], closeOutHours: 48, closeOutUnresponsive: false } as any);
    await keep.execute();
    expect(keep.tx.lead.updateMany).not.toHaveBeenCalled();
    expect(keep.prisma.sequenceEnrollment.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'completed' }) }));
  });

  it("waits after the lead's last text as long as the organization set, and not at all at 0", async () => {
    const lastText = new Date(NOW.getTime() - 5 * 60_000);
    const longer = setup([smsStep('one'), smsStep('two')], 2);
    longer.followup.guardrailsFor.mockResolvedValue({ timeZone: 'UTC', quiet: undefined, skipDays: [], limits: { ...DEFAULT_LIMITS, chatQuietMinutes: 60 } } as any);
    longer.prisma.message.findFirst.mockResolvedValue({ createdAt: lastText });
    await longer.execute();
    expect(longer.prisma.sequenceEnrollment.update).toHaveBeenCalledWith({
      where: { id: 'enr-1' },
      data: { nextActionAt: new Date(lastText.getTime() + 60 * 60_000), lockedBy: null, lockedAt: null },
    });

    const off = setup([smsStep('one'), smsStep('two')], 2);
    off.followup.guardrailsFor.mockResolvedValue({ timeZone: 'UTC', quiet: undefined, skipDays: [], limits: { ...DEFAULT_LIMITS, chatQuietMinutes: 0 } } as any);
    off.prisma.message.findFirst.mockResolvedValue({ createdAt: lastText });
    await off.execute();
    expect(off.sms.sendSms).toHaveBeenCalledWith('org-1', '+12895550100', 'two', { leadId: 'lead-1' });
  });

  it('does not close out a lead who replied during the wait', async () => {
    const s = setup([smsStep('one')], 2);
    s.prisma.lead.findUnique.mockResolvedValue({ firstName: 'Ana', phone: '+1', status: 'contacting', dncStatus: false, automationPaused: true });
    await s.execute();
    expect(s.tx.lead.updateMany).not.toHaveBeenCalled();
    expect(s.prisma.sequenceEnrollment.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'paused' }) }));
  });

  it('holds the next step while the lead is texting, until the chat has been quiet a while', async () => {
    const s = setup([smsStep('one'), smsStep('two')], 1);
    const lastText = new Date(NOW.getTime() - 5 * 60_000);
    s.prisma.message.findFirst.mockResolvedValue({ createdAt: lastText });
    await s.execute();
    expect(s.sms.sendSms).not.toHaveBeenCalled();
    expect(s.prisma.sequenceEnrollment.update).toHaveBeenCalledWith({
      where: { id: 'enr-1' },
      data: { nextActionAt: new Date(lastText.getTime() + CHAT_QUIET_MS), lockedBy: null, lockedAt: null },
    });
  });
});

describe('FollowupRunner journey rules', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  const deferredTo = (s: ReturnType<typeof setup>) =>
    (s.prisma.sequenceEnrollment.update.mock.calls as any[]).map((c) => c[0].data.nextActionAt).filter(Boolean);
  const loggedEvent = (s: ReturnType<typeof setup>, type: string) =>
    (s.prisma.leadEvent.create.mock.calls as any[]).some((c) => c[0].data.type === type);

  it('fills the lead variables into a text and adds it to the AI chat', async () => {
    const s = setup([{ ...smsStep('Hi {{firstName}}, still looking in {{location}}?') }], 1);
    await s.execute();
    expect(s.sms.sendSms).toHaveBeenCalledWith('org-1', '+12895550100', 'Hi Ana, still looking in Austin?', { leadId: 'lead-1' });
    expect(s.conversations.appendOurMessage).toHaveBeenCalledWith('org-1', '+12895550100', 'Hi Ana, still looking in Austin?');
  });

  it('waits while a call of this sequence is still ringing or live', async () => {
    const s = setup([voiceStep(), smsStep('two')], 2);
    s.prisma.call.findFirst.mockResolvedValue({ status: 'in_progress', disposition: null, endedAt: null, createdAt: new Date(NOW.getTime() - 60_000) });
    await s.execute();
    expect(s.sms.sendSms).not.toHaveBeenCalled();
    expect(deferredTo(s)).toEqual([new Date(NOW.getTime() + 30_000)]);
  });

  it('waits while the call it queued has not been placed yet', async () => {
    const s = setup([voiceStep(), smsStep('two')], 2);
    s.prisma.leadEvent.findFirst.mockResolvedValue({ createdAt: new Date(NOW.getTime() - 2 * 60_000) });
    await s.execute();
    expect(s.sms.sendSms).not.toHaveBeenCalled();
  });

  it('after a pick-up the next step waits for the call analysis instead of stopping on a guess', async () => {
    const s = setup([voiceStep(), smsStep('two')], 2);
    s.prisma.call.findFirst.mockResolvedValue({ status: 'completed', disposition: 'connected', endedAt: new Date(NOW.getTime() - 60_000), createdAt: NOW });
    await s.execute();
    expect(s.sms.sendSms).not.toHaveBeenCalled();
    expect(deferredTo(s)).toEqual([new Date(NOW.getTime() + 30_000)]);
    expect(loggedEvent(s, 'sequence_stopped')).toBe(false);
  });

  it('a meeting on the calendar stops the sequence and marks the lead booked', async () => {
    const s = setup([smsStep('one'), smsStep('two')], 2);
    s.prisma.calendarMeeting.count.mockResolvedValue(1);
    await s.execute();
    expect(s.sms.sendSms).not.toHaveBeenCalled();
    expect(s.tx.lead.updateMany).toHaveBeenCalledWith({ where: { id: 'lead-1', status: 'follow_up' }, data: { status: 'appointment_booked' } });
    expect(s.prisma.sequenceEnrollment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'stopped', stoppedReason: 'appointment_booked' }) }),
    );
  });

  it('looks at the lead once more right before sending: a pause that came in meanwhile holds the step', async () => {
    const s = setup([smsStep('one'), smsStep('two')], 2);
    const lead = { firstName: 'Ana', phone: '+12895550100', status: 'follow_up', dncStatus: false, automationPaused: false };
    s.prisma.lead.findUnique.mockResolvedValueOnce(lead).mockResolvedValueOnce({ ...lead, automationPaused: true });
    await s.execute();
    expect(s.sms.sendSms).not.toHaveBeenCalled();
    expect(s.prisma.sequenceEnrollment.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'paused' }) }));
  });

  it('after a conversation the sequence stops: the call scoring decides what comes next', async () => {
    const s = setup([voiceStep(), smsStep('two')], 2);
    s.prisma.call.findFirst.mockResolvedValue({ status: 'completed', disposition: 'connected', endedAt: NOW, createdAt: NOW, extractedIntel: { qualification: {} } });
    await s.execute();
    expect(s.sms.sendSms).not.toHaveBeenCalled();
    expect(s.prisma.sequenceEnrollment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'stopped', stoppedReason: 'lead_talked' }) }),
    );
    expect(loggedEvent(s, 'sequence_stopped')).toBe(true);
  });

  it('"only if the last call was not answered": sent after a voicemail, skipped when no call has ended', async () => {
    const step = { ...smsStep('Tried calling'), onlyIf: { lastCallMissed: true } };
    const missed = setup([voiceStep(), step], 2);
    missed.prisma.call.findFirst.mockResolvedValue({ status: 'completed', disposition: 'voicemail', endedAt: NOW, createdAt: NOW });
    await missed.execute();
    expect(missed.sms.sendSms).toHaveBeenCalled();

    const none = setup([smsStep('one'), step, smsStep('three')], 2);
    await none.execute();
    expect(none.sms.sendSms).not.toHaveBeenCalled();
    expect(loggedEvent(none, 'step_skipped')).toBe(true);
    expect(none.prisma.sequenceEnrollment.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ currentStep: 3 }) }));
  });

  it('a condition is about the step before: after a skipped call, an older missed call does not make "tried calling" true', async () => {
    const step = (onlyIf: object) => ({ ...smsStep('Tried you again'), onlyIf });
    const steps = [voiceStep(), step({ lastCallMissed: true }), { ...voiceStep(), onlyIf: { noReply: true } }, step({ lastCallMissed: true })];
    const s = setup(steps, 4);
    s.prisma.call.findFirst.mockResolvedValue({ status: 'completed', disposition: 'no_answer', endedAt: NOW, createdAt: NOW });
    // The latest step event of this enrolment: step 3 (the call) was skipped.
    s.prisma.leadEvent.findFirst.mockImplementation((async (args: any) =>
      args.where.type?.in ? { type: 'step_skipped', payload: { sequenceId: 'seq-1', step: 3 } } : null) as any);
    await s.execute();
    expect(s.sms.sendSms).not.toHaveBeenCalled();
    expect(loggedEvent(s, 'step_skipped')).toBe(true);
  });

  it('"only if they have not replied": skipped once the lead has texted back', async () => {
    const s = setup([{ ...smsStep('Still there?'), onlyIf: { noReply: true } }], 1);
    // The chat check sees no recent text (quiet for long), the reply check sees one since enrolment.
    s.prisma.message.findFirst.mockImplementation(async (args: any) => (args.where.createdAt ? ({ id: 'm1' } as any) : null));
    await s.execute();
    expect(s.sms.sendSms).not.toHaveBeenCalled();
  });

  it('the daily limit or the gap defers the step to when it may go, without dropping it', async () => {
    const s = setup([smsStep('one'), smsStep('two')], 2);
    const tomorrow = new Date('2026-10-27T08:00:00Z');
    s.followup.contactSlot.mockResolvedValue({ at: tomorrow, reason: 'Daily limit of 3 texts reached' });
    await s.execute();
    expect(s.sms.sendSms).not.toHaveBeenCalled();
    expect(deferredTo(s)).toEqual([tomorrow]);
    expect(loggedEvent(s, 'step_held')).toBe(true);
  });

  it('a call step carries its voicemail choice and its prompt as the call context', async () => {
    const s = setup([{ ...voiceStep(), voicemail: 'skip' }], 1);
    await s.execute();
    expect(s.calls.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'followup', voicemail: 'skip', context: 'call back' }),
      expect.anything(),
    );
  });

  it('does not close out as unresponsive a lead who talked on the last call', async () => {
    const s = setup([voiceStep()], 2);
    s.prisma.call.findFirst.mockResolvedValue({ status: 'completed', disposition: 'connected', endedAt: NOW, createdAt: NOW });
    await s.execute();
    expect(s.tx.lead.updateMany).not.toHaveBeenCalled();
    expect(s.prisma.sequenceEnrollment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'completed' }) }),
    );
  });
});
