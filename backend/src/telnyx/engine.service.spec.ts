import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SMS_READY } from '@/calling/calling-providers';
import { LeadStateService } from '@/lead/lead-state.service';
import { EngineService, remainingSteps } from './engine.service';
import type { Strategy, StrategyStep } from './strategy-store.service';

const ORG = 'org-1';
const LEAD = 'lead-1';
const MIN = 60_000;

const sms = (id: string, minutes: number, message = `text ${id}`): StrategyStep => ({ id, channel: 'sms', after: { value: minutes, unit: 'minutes' }, message });
const voice = (id: string, minutes: number): StrategyStep => ({ id, channel: 'voice', after: { value: minutes, unit: 'minutes' } });

/** The strategy from the screenshot: SMS at once, a call 5 min later, an SMS 5 min after that. */
const SCREENSHOT: StrategyStep[] = [sms('s1', 0), voice('s2', 5), sms('s3', 5, 'just tried you with a call')];

interface CallRow {
  status: string;
  durationSeconds: number | null;
  extractedIntel: unknown;
  createdAt: Date;
  disposition?: string | null;
  endedAt?: Date | null;
}

/** `sms` false: the organization calls through a provider without SMS (Retell). */
function setup(steps: StrategyStep[] = SCREENSHOT, guardrails: Record<string, unknown> = {}, sms = true) {
  const lead = { id: LEAD, orgId: ORG, firstName: 'Ana', phone: '+12895550100', status: 'new', dncStatus: false, automationPaused: false };
  const calls: CallRow[] = [];
  const texts: { direction: 'inbound' | 'outbound'; createdAt: Date }[] = [];
  const since = (where: { createdAt?: { gte: Date } }) => calls.filter((c) => !where.createdAt || c.createdAt >= where.createdAt.gte);
  const prisma = {
    lead: {
      findFirst: vi.fn(async () => ({ ...lead })),
      findUnique: vi.fn(async () => ({ ...lead })),
      update: vi.fn(async () => ({})),
      // Applies a status move to the lead, as the database would.
      updateMany: vi.fn(async ({ data }: any) => {
        if (data?.status) lead.status = data.status;
        return { count: 1 };
      }),
    },
    leadEvent: { create: vi.fn(async () => ({})) },
    call: {
      count: vi.fn(async ({ where }: any) => since(where).length),
      findFirst: vi.fn(async ({ where }: any) => since(where).at(-1) ?? null),
    },
    message: {
      count: vi.fn(async () => 0),
      // Texts of the lead's chat, newest last; inbound ones are the lead's.
      findFirst: vi.fn(async ({ where }: any) => {
        const rows = texts.filter((t) => (!where.direction || t.direction === where.direction) && t.createdAt >= (where.createdAt?.gte ?? new Date(0)));
        const last = rows.at(-1);
        return last ? { id: 'msg', createdAt: last.createdAt } : null;
      }),
    },
    organization: { findUnique: vi.fn(async () => ({ name: 'Acme Realty', settings: { timezone: 'UTC' } })) },
    calendarMeeting: { count: vi.fn(async () => 0) },
    $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(prisma)),
  };
  const strategy: Strategy = { name: 'Test', guardrails: { respectQuietHours: false, ...guardrails }, steps };
  const strategies = { getStrategy: vi.fn(async () => strategy) };
  const smsService = { sendSms: vi.fn(async () => ({ id: 'msg-1' })) };
  const queue = { enqueue: vi.fn(async () => 'job-1') };
  const activity = { recordSms: vi.fn(), recordCallFailed: vi.fn(), exitStrategy: vi.fn(), leadVariables: vi.fn(async () => ({ firstName: 'Ana' })) };
  const followup = {
    sequenceForTrigger: vi.fn(async () => undefined),
    enroll: vi.fn(),
    stopForLead: vi.fn(),
    contactSlot: vi.fn(async (..._args: unknown[]) => ({ at: new Date(Date.now()), reason: null as string | null })),
  };
  const state = new LeadStateService(prisma as any);
  const conversations = { appendOurMessage: vi.fn(async () => undefined) };
  const provider = {
    name: sms ? 'telnyx' : 'retell',
    capabilities: { sms: true },
    smsCapability: vi.fn(async () => (sms ? SMS_READY : { available: false, state: 'not_configured', reason: 'SMS is not set up on Retell yet', deliveryReports: false })),
    sendSms: smsService.sendSms,
  };
  const providers = { for: vi.fn(async () => provider), nameFor: vi.fn(async () => provider.name) };
  const engine = new EngineService(prisma as any, strategies as any, providers as any, queue as any, activity as any, followup as any, state, conversations as any);
  const text = (direction: 'inbound' | 'outbound') => texts.push({ direction, createdAt: new Date() });
  const dial = (status: string, durationSeconds: number | null = null, disposition?: string) => {
    const ended = !['ringing', 'in_progress', 'queued'].includes(status);
    const row: CallRow = { status, durationSeconds, extractedIntel: null, createdAt: new Date(), disposition: disposition ?? null, endedAt: ended ? new Date() : null };
    calls.push(row);
    return row;
  };
  return { engine, lead, prisma, conversations, text, smsService, queue, activity, followup, dial, texts: () => smsService.sendSms.mock.calls.map((c: unknown[]) => c[2]) };
}

describe('remainingSteps', () => {
  const none = new Set<string>();

  it('matches the steps the strategy logged as run, by id, and is due at the sum of the waits up to the next one', () => {
    const start = 1_000_000;
    expect(remainingSteps(SCREENSHOT, { stepIds: none, calls: 0, texts: 0 }, start)).toEqual({ remaining: SCREENSHOT, dueAt: start });
    expect(remainingSteps(SCREENSHOT, { stepIds: new Set(['s1']), calls: 0, texts: 0 }, start)).toEqual({ remaining: SCREENSHOT.slice(1), dueAt: start + 5 * MIN });
    // A chat with the AI leaves many outbound texts on record; the log still knows s3 has not run.
    expect(remainingSteps(SCREENSHOT, { stepIds: new Set(['s1', 's2']), calls: 1, texts: 6 }, start)).toEqual({
      remaining: SCREENSHOT.slice(2),
      dueAt: start + 10 * MIN,
    });
  });

  it('falls back to counting calls and texts for a lead from before the log', () => {
    const start = 1_000_000;
    expect(remainingSteps(SCREENSHOT, { stepIds: none, calls: 0, texts: 1 }, start)).toEqual({ remaining: SCREENSHOT.slice(1), dueAt: start + 5 * MIN });
    expect(remainingSteps(SCREENSHOT, { stepIds: none, calls: 1, texts: 2 }, start).remaining).toEqual([]);
  });
});

describe('EngineService strategy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T10:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('skips SMS steps for a provider without SMS (Retell), logs them as skipped, and still places the calls', async () => {
    const s = setup(SCREENSHOT, {}, false);
    await s.engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.smsService.sendSms).not.toHaveBeenCalled();
    expect(s.activity.recordSms).not.toHaveBeenCalled();
    expect(JSON.stringify(s.prisma.leadEvent.create.mock.calls)).toContain('step_skipped');

    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(s.queue.enqueue).toHaveBeenCalledOnce();
  });

  it('counts each wait from the step before, so the SMS after a call never goes out with it', async () => {
    const s = setup();
    await s.engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.texts()).toEqual(['text s1']);

    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(s.queue.enqueue).toHaveBeenCalledOnce();
    expect(s.texts()).toEqual(['text s1']);

    s.dial('no_answer', 30);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(s.texts()).toEqual(['text s1', 'just tried you with a call']);
  });

  it('holds the SMS while the call is still queued, ringing or live, and sends it once the call ends unanswered', async () => {
    const s = setup();
    await s.engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(s.queue.enqueue).toHaveBeenCalledOnce();

    // Still waiting for a slot: no call on record yet.
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(s.texts()).toEqual(['text s1']);

    const call = s.dial('ringing');
    await vi.advanceTimersByTimeAsync(2 * MIN);
    call.status = 'in_progress';
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(s.texts()).toEqual(['text s1']);

    call.status = 'no_answer';
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.texts()).toEqual(['text s1', 'just tried you with a call']);
  });

  it('treats a pick-up shorter than a conversation as unanswered', async () => {
    const s = setup();
    await s.engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    s.dial('completed', 2);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(s.texts()).toEqual(['text s1', 'just tried you with a call']);
  });

  it('skips what is left after the lead talked, and closes only once that call is scored', async () => {
    const s = setup();
    await s.engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    const call = s.dial('completed', 240);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(s.texts()).toEqual(['text s1']);

    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(s.activity.exitStrategy).not.toHaveBeenCalled();

    // The analysis says a person was there: the rest is skipped, and the strategy closes.
    call.extractedIntel = { qualification: { temperature: 'warm' } };
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(s.texts()).toEqual(['text s1']);
    expect(s.activity.exitStrategy).toHaveBeenCalledOnce();
  });

  it('waits for the call analysis after a pick-up: one that reached no one gets the tried-calling text', async () => {
    const s = setup();
    await s.engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    const call = s.dial('completed', 40, 'connected');
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(s.texts()).toEqual(['text s1']);
    expect((s.prisma.leadEvent.create.mock.calls as any[]).some((c) => c[0].data.type === 'step_held' && /call analysis/.test(c[0].data.reason))).toBe(true);

    // A voicemail the detection missed: the analysis turns the pick-up into a not-answered call.
    call.disposition = 'voicemail';
    call.extractedIntel = { qualification: { temperature: 'cold' } };
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.texts()).toEqual(['text s1', 'just tried you with a call']);
  });

  it('does not close the strategy while its last call is live', async () => {
    const s = setup([sms('s1', 0), voice('s2', 1)]);
    await s.engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(1 * MIN);
    const call = s.dial('in_progress');
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(s.activity.exitStrategy).not.toHaveBeenCalled();

    call.status = 'no_answer';
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.activity.exitStrategy).toHaveBeenCalledOnce();
  });

  it('skips canned texts while the lead texts with the AI, and calls only once the chat has been quiet for the wait', async () => {
    const s = setup();
    await s.engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.conversations.appendOurMessage).toHaveBeenCalledWith(ORG, '+12895550100', 'text s1');

    // The lead replies a minute in and chats with the AI until minute 4.
    await vi.advanceTimersByTimeAsync(1 * MIN);
    s.text('inbound');
    s.text('outbound');
    await vi.advanceTimersByTimeAsync(3 * MIN);
    s.text('inbound');
    s.text('outbound');

    // The call step was due at minute 5: the chat moved at minute 4, so it waits until minute 9.
    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(s.queue.enqueue).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1 * MIN + 1_000);
    expect(s.queue.enqueue).toHaveBeenCalledOnce();

    // The "tried calling" text after it is skipped: the lead is in a chat.
    s.dial('no_answer', 30);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(s.texts()).toEqual(['text s1']);
    expect(s.prisma.leadEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'step_skipped', reason: 'The lead is texting with the AI' }),
    });
  });

  it('stops before the next step once the lead booked', async () => {
    const s = setup();
    await s.engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(0);
    s.prisma.lead.findUnique.mockResolvedValue({ ...s.lead, status: 'appointment_booked' });
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(s.queue.enqueue).not.toHaveBeenCalled();
    expect(s.texts()).toEqual(['text s1']);
    expect(s.engine.isRunning(LEAD)).toBe(false);
  });
});

describe('EngineService journey rules', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T10:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  const missedOnly = (id: string, minutes: number, message: string): StrategyStep => ({ ...sms(id, minutes, message), onlyIf: { lastCallMissed: true } });

  it('"only if the last call was not answered": the tried-calling text goes after a voicemail', async () => {
    const s = setup([sms('s1', 0), voice('s2', 5), missedOnly('s3', 5, 'just tried you')]);
    await s.engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    s.dial('completed', 34, 'voicemail');
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(s.texts()).toEqual(['text s1', 'just tried you']);
  });

  it('…and is skipped, never sent untrue, when no call was made', async () => {
    const s = setup([sms('s1', 0), missedOnly('s2', 5, 'just tried you'), sms('s3', 5, 'last')]);
    await s.engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(s.texts()).toEqual(['text s1', 'last']);
    expect((s.prisma.leadEvent.create.mock.calls as any[]).some((c) => c[0].data.type === 'step_skipped' && /no call has ended/.test(c[0].data.reason))).toBe(true);
  });

  it('a condition is about the step before: a skipped call does not let an older missed one say "tried you again"', async () => {
    const steps = [voice('s1', 0), missedOnly('s2', 5, 'tried you'), voice('s3', 60), missedOnly('s4', 5, 'tried you again')];
    const s = setup(steps, { maxVoiceAttempts: 1 });
    await s.engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(0);
    s.dial('no_answer', 30, 'no_answer');
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(s.texts()).toEqual(['tried you']);
    // The second call is over the call limit and skipped, so the text about it is skipped too.
    await vi.advanceTimersByTimeAsync(65 * MIN);
    expect(s.queue.enqueue).toHaveBeenCalledOnce();
    expect(s.texts()).toEqual(['tried you']);
    expect((s.prisma.leadEvent.create.mock.calls as any[]).some((c) => c[0].data.type === 'step_skipped' && /step before/.test(c[0].data.reason))).toBe(true);
  });

  it('"only if they have not replied": a call is skipped once the lead texted back', async () => {
    const s = setup([sms('s1', 0), { ...voice('s2', 5), onlyIf: { noReply: true } }]);
    await s.engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(MIN);
    s.text('inbound');
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(s.queue.enqueue).not.toHaveBeenCalled();
  });

  it('a daily limit holds the step until the slot it is given, then sends it', async () => {
    const s = setup([sms('s1', 0), sms('s2', 1, 'second')]);
    const later = new Date(Date.now() + 2 * 60 * MIN);
    s.followup.contactSlot.mockImplementation(async () =>
      Date.now() >= later.getTime() || s.texts().length === 0 ? { at: new Date(Date.now()), reason: null } : { at: later, reason: 'Daily limit of 1 texts reached' },
    );
    await s.engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(MIN);
    expect(s.texts()).toEqual(['text s1']);
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(s.texts()).toEqual(['text s1']);
    await vi.advanceTimersByTimeAsync(61 * MIN);
    expect(s.texts()).toEqual(['text s1', 'second']);
  });

  it("a call step's voicemail choice and context go with the call", async () => {
    const s = setup([{ ...voice('s1', 0), voicemail: 'leave', context: 'They asked about 3-bed homes in Austin' }]);
    await s.engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'strategy', voicemail: 'leave', context: 'They asked about 3-bed homes in Austin' }),
      expect.anything(),
    );
  });
});

describe('EngineService safety and recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T10:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  const eventOf = (s: ReturnType<typeof setup>, type: string) =>
    (s.prisma.leadEvent.create.mock.calls as any[]).map((c) => c[0].data).find((d) => d.type === type);

  it('a meeting on the calendar ends the strategy before the next step, and the lead is marked booked', async () => {
    const s = setup();
    await s.engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.texts()).toEqual(['text s1']);
    s.prisma.calendarMeeting.count.mockResolvedValue(1);
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(s.queue.enqueue).not.toHaveBeenCalled();
    expect(s.lead.status).toBe('appointment_booked');
    expect(s.followup.stopForLead).toHaveBeenCalledWith(ORG, LEAD, 'appointment_booked');
    expect(s.engine.isRunning(LEAD)).toBe(false);
  });

  it('looks at the lead once more right before sending: a pause that came in meanwhile stops the text', async () => {
    const s = setup([sms('s1', 0)]);
    s.prisma.lead.findUnique.mockResolvedValueOnce({ ...s.lead }).mockResolvedValueOnce({ ...s.lead, automationPaused: true });
    await s.engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.texts()).toEqual([]);
    expect(s.engine.isRunning(LEAD)).toBe(false);
  });

  it('a step that throws is tried again with backoff, and sends once it gets through', async () => {
    const s = setup([sms('s1', 0)]);
    s.followup.contactSlot.mockRejectedValueOnce(new Error('connection reset')).mockRejectedValueOnce(new Error('connection reset'));
    await s.engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.texts()).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.texts()).toEqual([]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(s.texts()).toEqual(['text s1']);
  });

  it('never sends a text twice when the error came after it went out', async () => {
    const s = setup([sms('s1', 0), sms('s2', 1)]);
    s.activity.recordSms.mockRejectedValueOnce(new Error('db down')).mockRejectedValueOnce(new Error('db down'));
    await s.engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000 + MIN);
    expect(s.texts()).toEqual(['text s1', 'text s2']);
  });

  it('after the last try the lead is parked for follow-up and flagged for review, not left hanging', async () => {
    const s = setup([sms('s1', 0)]);
    s.followup.contactSlot.mockRejectedValue(new Error('connection refused'));
    s.prisma.lead.findUnique.mockImplementation((async (args: any) => (args?.select?.reviewReasons ? { reviewReasons: [] } : { ...s.lead })) as any);
    await s.engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(s.texts()).toEqual([]);
    expect(s.activity.exitStrategy).toHaveBeenCalledWith(LEAD, expect.stringContaining('kept failing'));
    expect(s.prisma.lead.update).toHaveBeenCalledWith({
      where: { id: LEAD },
      data: { needsReview: true, reviewReasons: { push: 'Outreach stopped: a strategy step kept failing' } },
    });
    expect(eventOf(s, 'strategy_stopped')?.reason).toMatch(/kept failing/);
    expect(s.engine.isRunning(LEAD)).toBe(false);
  });

  it('a wait longer than one timer can hold fires when it is due, not at once', async () => {
    const s = setup([sms('s1', 0), { ...sms('s2', 0, 'a month on'), after: { value: 30, unit: 'days' } }]);
    await s.engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(MIN);
    expect(s.texts()).toEqual(['text s1']);
    await vi.advanceTimersByTimeAsync(29 * 24 * 60 * MIN);
    expect(s.texts()).toEqual(['text s1']);
    await vi.advanceTimersByTimeAsync(24 * 60 * MIN);
    expect(s.texts()).toEqual(['text s1', 'a month on']);
  });

  it('does not resume a lead that left the strategy and came back to an in-strategy status', async () => {
    const s = setup();
    s.prisma.lead.findFirst.mockResolvedValue({ ...s.lead, status: 'engaged', firstContactAt: new Date(Date.now() - 60 * MIN), callbackAt: null } as any);
    (s.prisma.leadEvent as any).findFirst = vi.fn(async () => ({ id: 'ev-1' }));
    expect(await s.engine.resume(ORG, LEAD)).toBe(false);
    expect(s.engine.isRunning(LEAD)).toBe(false);
  });
});

describe('EngineService outcomes', () => {
  it('marks a booking even after the lead was closed out, and stops their follow-ups', async () => {
    const s = setup();
    Object.assign(s.lead, { status: 'not_interested', dncStatus: true });
    await s.engine.appointmentBooked(ORG, LEAD);
    expect(s.lead.status).toBe('appointment_booked');
    expect(s.prisma.leadEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'status_changed', fromStatus: 'not_interested', toStatus: 'appointment_booked', source: 'calendar' }),
    });
    expect(s.followup.stopForLead).toHaveBeenCalledWith(ORG, LEAD, 'appointment_booked');
  });

  it('leaves a wrong number alone when a booking comes in', async () => {
    const s = setup();
    s.lead.status = 'invalid';
    await s.engine.appointmentBooked(ORG, LEAD);
    expect(s.lead.status).toBe('invalid');
    expect(s.followup.stopForLead).not.toHaveBeenCalled();
  });

  it('stops follow-ups when a lead is set to an out-of-pipeline status', async () => {
    const s = setup();
    s.lead.status = 'contacting';
    expect(await s.engine.setStatus(ORG, LEAD, 'not_interested' as any, 'Said no on the call', { source: 'scoring' })).toBe(true);
    expect(s.followup.stopForLead).toHaveBeenCalledWith(ORG, LEAD, 'lead_not_interested', s.prisma);
  });

  it('refuses automation a move the rules do not allow, but lets a person make it', async () => {
    const s = setup();
    s.lead.status = 'appointment_booked';
    expect(await s.engine.setStatus(ORG, LEAD, 'follow_up' as any, 'scored again', { source: 'scoring' })).toBe(false);
    expect(s.lead.status).toBe('appointment_booked');

    expect(await s.engine.setStatus(ORG, LEAD, 'follow_up' as any, 'Meeting fell through', { actor: { type: 'user', id: 'user-1' } })).toBe(true);
    expect(s.lead.status).toBe('follow_up');
    expect(s.prisma.leadEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ fromStatus: 'appointment_booked', toStatus: 'follow_up', source: 'agent', actorType: 'user', actorId: 'user-1' }),
    });
  });
});
