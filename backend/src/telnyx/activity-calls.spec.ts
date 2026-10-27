import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityService } from './activity.service';

/**
 * How a call's row moves as Telnyx reports it answered and hung up. The row only ever moves
 * forward: a repeated or late event changes nothing, so a short pick-up whose events race
 * never ends up stuck live, and a second hang-up never turns a conversation into no answer.
 */

const ORG = 'org-1';
const LEAD = 'lead-1';
const NOW = new Date('2026-10-26T15:00:00Z');

function setup(call: Record<string, unknown> | null, opts: { ended?: 'completed' | 'no_answer' | null; creds?: unknown; strategy?: unknown } = {}) {
  const prisma = {
    call: {
      findFirst: vi.fn().mockResolvedValue(call),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn().mockResolvedValue({}),
      count: vi.fn().mockResolvedValue(0),
    },
    // The hang-up's one atomic move: what the row became, or nothing when it was already over.
    $queryRaw: vi.fn().mockResolvedValue(opts.ended === null ? [] : [{ status: opts.ended ?? 'completed' }]),
    lead: { update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUnique: vi.fn(), findFirst: vi.fn().mockResolvedValue({ firstName: 'Asha' }) },
    organization: { findUnique: vi.fn().mockResolvedValue({ name: 'Acme Realty' }) },
    organizationSetting: { findUnique: vi.fn().mockResolvedValue({ callRecordingEnabled: false, outreachStrategy: opts.strategy ?? null }) },
  };
  const creds = { getCreds: vi.fn().mockResolvedValue(opts.creds ?? null) };
  const slots = { extend: vi.fn().mockResolvedValue(undefined), release: vi.fn().mockResolvedValue(undefined) };
  const activity = new ActivityService(prisma as any, creds as any, {} as any, {} as any, slots as any, { get: () => 0 } as any);
  return { activity, prisma, slots };
}

/** The Telnyx call actions the service issued, by name, with their bodies. */
function stubActions() {
  const actions: { name: string; body: any }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { body?: string }) => {
      actions.push({ name: String(url).split('/actions/')[1], body: init?.body ? JSON.parse(init.body) : null });
      return { ok: true, text: async () => '' };
    }),
  );
  return actions;
}

describe('ActivityService call bookkeeping', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.unstubAllGlobals();
  });

  it('a dialed call is recorded as ringing from the moment it is placed', async () => {
    const { activity, prisma } = setup(null);
    await activity.startCall(ORG, LEAD, null);
    expect(prisma.call.create).toHaveBeenCalledWith({
      data: { orgId: ORG, leadId: LEAD, provider: 'telnyx', providerCallId: null, status: 'ringing', startedAt: NOW },
    });
  });

  it('an answered call goes in progress (from ringing only), keeps its slot and counts as the lead responding', async () => {
    const { activity, prisma, slots } = setup({ id: 'call-1', orgId: ORG, leadId: LEAD, status: 'ringing' });
    await activity.onCallAnswered('ccid-1');
    expect(prisma.call.updateMany).toHaveBeenCalledWith({
      where: { id: 'call-1', status: { in: ['queued', 'ringing'] } },
      data: { status: 'in_progress', answeredAt: NOW },
    });
    expect(slots.extend).toHaveBeenCalledWith(ORG, 'ccid-1');
    expect(prisma.lead.update).toHaveBeenCalledWith({ where: { id: LEAD }, data: { lastContactAt: NOW, firstResponseAt: NOW } });
  });

  it('a hang-up after an answer completes the call', async () => {
    const { activity, prisma, slots } = setup({ id: 'call-1', orgId: ORG, leadId: LEAD, status: 'in_progress' }, { ended: 'completed' });
    await activity.onCallHangup('ccid-1', { hangup_cause: 'normal_clearing' });
    expect(slots.release).toHaveBeenCalledWith(ORG, 'ccid-1');
    expect(prisma.$queryRaw).toHaveBeenCalledOnce();
    expect(prisma.lead.updateMany).not.toHaveBeenCalled();
  });

  it('a hang-up before any answer is no answer, busy included', async () => {
    const { activity, prisma } = setup({ id: 'call-1', orgId: ORG, leadId: LEAD, status: 'ringing' }, { ended: 'no_answer' });
    await activity.onCallHangup('ccid-1', { hangup_cause: 'user_busy' });
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({ where: { id: LEAD }, data: { aiSummary: 'No answer on the last call (user_busy)', lastContactAt: NOW } });
  });

  it('a call that could not be placed is recorded as failed', async () => {
    const { activity, prisma } = setup(null);
    await activity.recordCallFailed(ORG, LEAD, 'invalid number');
    expect(prisma.call.create).toHaveBeenCalledWith({ data: { orgId: ORG, leadId: LEAD, provider: 'telnyx', status: 'failed', startedAt: NOW, endedAt: NOW } });
  });
});

describe('ActivityService events out of order or repeated', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.unstubAllGlobals();
  });

  it('a second hang-up for a call already over changes nothing: no second row move, no lead note', async () => {
    const { activity, prisma } = setup({ id: 'call-1', orgId: ORG, leadId: LEAD, status: 'completed' }, { ended: null });
    await activity.onCallHangup('ccid-1', { hangup_cause: 'normal_clearing' });
    expect(prisma.lead.updateMany).not.toHaveBeenCalled();
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });

  it('an answer that arrives after the hang-up is ignored: the row stays as it ended and nothing attaches to the dead call', async () => {
    const actions = stubActions();
    const { activity, prisma, slots } = setup({ id: 'call-1', orgId: ORG, leadId: LEAD, status: 'no_answer' }, { creds: { apiKey: 'KEY', assistantId: 'a-1' } });
    prisma.call.updateMany.mockResolvedValue({ count: 0 });
    await activity.onCallAnswered('ccid-1');
    expect(slots.extend).not.toHaveBeenCalled();
    expect(prisma.lead.update).not.toHaveBeenCalled();
    expect(actions).toEqual([]);
  });
});

describe('ActivityService hang-up causes (Telnyx call.hangup: hangup_cause + sip_hangup_cause)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.unstubAllGlobals();
  });
  const ringing = { id: 'call-1', orgId: ORG, leadId: LEAD, status: 'ringing' };
  const invalidated = (prisma: ReturnType<typeof setup>['prisma']) =>
    prisma.lead.updateMany.mock.calls.some(([arg]: any[]) => arg?.data?.status === 'invalid');
  /** The end reason the row was given, from the hang-up's one update. */
  const reasonWritten = (prisma: ReturnType<typeof setup>['prisma']) => prisma.$queryRaw.mock.calls[0].find((v: unknown) => typeof v === 'string' && v.length < 40);

  it.each([
    ['not_found', 'unspecified'],
    ['unspecified', '404'],
    ['unspecified', '410'],
    ['unspecified', '484'],
  ])('a dead number (%s, SIP %s) marks the lead invalid', async (hangup_cause, sip_hangup_cause) => {
    const { activity, prisma } = setup(ringing, { ended: 'no_answer' });
    await activity.onCallHangup('ccid-1', { hangup_cause, sip_hangup_cause } as any);
    expect(invalidated(prisma)).toBe(true);
  });

  it('busy, declined and no answer are kept as the reason the call ended, and never mark the lead invalid', async () => {
    for (const [hangup_cause, sip_hangup_cause, reason] of [
      ['user_busy', '486', 'user_busy'],
      ['call_rejected', '603', 'call_rejected'],
      ['timeout', 'unspecified', 'timeout'],
      ['unspecified', '486', 'user_busy'],
    ]) {
      const { activity, prisma } = setup(ringing, { ended: 'no_answer' });
      await activity.onCallHangup('ccid-1', { hangup_cause, sip_hangup_cause } as any);
      expect(reasonWritten(prisma)).toBe(reason);
      expect(invalidated(prisma)).toBe(false);
    }
  });
});

describe('ActivityService answering machine detection', () => {
  const live = { id: 'call-1', orgId: ORG, leadId: LEAD, status: 'in_progress' };
  const creds = { apiKey: 'KEY', assistantId: 'a-1' };
  const strategy = (voicemail: Record<string, unknown>) => ({ name: 'S', guardrails: { voicemail }, steps: [] });
  const names = (actions: { name: string }[]) => actions.map((a) => a.name);

  beforeEach(() => vi.unstubAllGlobals());

  it.each([
    ['machine', 'machine'],
    ['silence', 'machine'],
    ['fax_detected', 'machine'],
    ['human_residence', 'human'],
    ['human_business', 'human'],
    ['not_sure', 'human'],
  ])('premium detection "%s" is kept as answered by %s', async (result, by) => {
    const { activity, prisma } = setup(live);
    await activity.onMachineDetection('ccid-1', { result });
    expect(prisma.call.update).toHaveBeenCalledWith({ where: { id: 'call-1' }, data: { answeredBy: by } });
  });

  it('not sure is a person: the assistant carries on and nothing is done to the call', async () => {
    const actions = stubActions();
    const { activity } = setup(live, { creds, strategy: strategy({ detect: true, action: 'hangup' }) });
    await activity.onMachineDetection('ccid-1', { result: 'not_sure' });
    expect(actions).toEqual([]);
  });

  it('a machine with "hang up": the assistant is stopped and the call hung up', async () => {
    const actions = stubActions();
    const { activity } = setup(live, { creds, strategy: strategy({ detect: true, action: 'hangup' }) });
    await activity.onMachineDetection('ccid-1', { result: 'machine' });
    expect(names(actions)).toEqual(['ai_assistant_stop', 'hangup']);
  });

  it('a machine with "leave a short voicemail": the message, variables filled, is spoken after the beep, then the call hangs up', async () => {
    const actions = stubActions();
    const { activity } = setup(live, {
      creds,
      strategy: strategy({ detect: true, action: 'leave_message', message: 'Hi {{firstName}}, {{brokerage}} here. Expect a text.' }),
    });
    await activity.onMachineDetection('ccid-1', { result: 'machine' });
    expect(names(actions)).toEqual(['ai_assistant_stop']);
    await activity.onMachineGreetingEnded('ccid-1', { result: 'beep_detected' });
    expect(names(actions)).toEqual(['ai_assistant_stop', 'speak']);
    expect(actions[1].body).toEqual(expect.objectContaining({ payload: 'Hi Asha, Acme Realty here. Expect a text.' }));
    await activity.onSpeakEnded('ccid-1');
    expect(names(actions)).toEqual(['ai_assistant_stop', 'speak', 'hangup']);
  });

  it('the beep heard before the verdict still gets the message; no beep at all hangs up', async () => {
    const actions = stubActions();
    const { activity } = setup(live, { creds, strategy: strategy({ detect: true, action: 'leave_message' }) });
    await activity.onMachineGreetingEnded('ccid-1', { result: 'beep_detected' });
    await activity.onMachineDetection('ccid-1', { result: 'machine' });
    expect(names(actions)).toEqual(['ai_assistant_stop', 'speak']);
    // The default message with the office's name and the lead's first name filled in.
    expect(actions[1].body.payload).toBe("Hi Asha, this is Acme Realty calling about your home search. We'll send you a quick text.");

    const quiet = stubActions();
    const second = setup(live, { creds, strategy: strategy({ detect: true, action: 'leave_message' }) });
    await second.activity.onMachineDetection('ccid-2', { result: 'machine' });
    await second.activity.onMachineGreetingEnded('ccid-2', { result: 'no_beep_detected' });
    expect(names(quiet)).toEqual(['ai_assistant_stop', 'hangup']);
  });
});
