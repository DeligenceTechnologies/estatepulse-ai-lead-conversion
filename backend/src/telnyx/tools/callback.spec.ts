import { describe, expect, it, vi } from 'vitest';
import { CallbackService, LATER_MS, resolveCallback } from './callback.service';
import { DEFAULT_RETRY_ATTEMPTS, DEFAULT_RETRY_MINUTES } from './call-tools';

const TZ = 'Asia/Kolkata';
const QUIET = { start: '21:00', end: '08:00' };
// Tue 27 Oct 2026, 11:00 in Kolkata.
const NOW = new Date('2026-10-27T05:30:00.000Z');

describe('resolveCallback', () => {
  it('"call me later" with no time: three hours from now', () => {
    const r = resolveCallback({}, NOW, TZ, QUIET);
    expect(r).toEqual({ ok: true, at: new Date(NOW.getTime() + LATER_MS) });
  });

  it('"later" that lands in quiet hours moves to the start of the calling window', () => {
    const evening = new Date('2026-10-27T14:30:00.000Z'); // 20:00 Kolkata; +3 h is 23:00
    const r = resolveCallback({}, evening, TZ, QUIET);
    expect(r).toEqual({ ok: true, at: new Date('2026-10-28T02:30:00.000Z') }); // 08:00 next day
  });

  it('a time today, tomorrow, or on a weekday, in the organization time zone', () => {
    expect(resolveCallback({ time: '17:00' }, NOW, TZ, QUIET)).toEqual({ ok: true, at: new Date('2026-10-27T11:30:00.000Z') });
    expect(resolveCallback({ day: 'tomorrow', time: '17:00' }, NOW, TZ, QUIET)).toEqual({ ok: true, at: new Date('2026-10-28T11:30:00.000Z') });
    expect(resolveCallback({ day: 'friday', time: '09:30' }, NOW, TZ, QUIET)).toEqual({ ok: true, at: new Date('2026-10-30T04:00:00.000Z') });
  });

  it('a delay ("call me after 5 min"): that many minutes from now, at least two so this call can end', () => {
    expect(resolveCallback({ inMinutes: 5 }, NOW, TZ, QUIET)).toEqual({ ok: true, at: new Date(NOW.getTime() + 5 * 60_000) });
    expect(resolveCallback({ inMinutes: 60 }, NOW, TZ, QUIET)).toEqual({ ok: true, at: new Date(NOW.getTime() + 60 * 60_000) });
    expect(resolveCallback({ inMinutes: 1 }, NOW, TZ, QUIET)).toEqual({ ok: true, at: new Date(NOW.getTime() + 2 * 60_000) });
  });

  it('a delay into quiet hours, or more than two weeks, is refused', () => {
    const evening = new Date('2026-10-27T15:00:00.000Z'); // 20:30 Kolkata
    expect(resolveCallback({ inMinutes: 60 }, evening, TZ, QUIET)).toEqual({ ok: false, reason: 'outside_hours', suggested: new Date('2026-10-28T02:30:00.000Z') });
    expect(resolveCallback({ inMinutes: 15 * 24 * 60 }, NOW, TZ, QUIET)).toEqual({ ok: false, reason: 'too_far' });
  });

  it('a clock time wins over a delay given with it', () => {
    expect(resolveCallback({ time: '17:00', inMinutes: 5 }, NOW, TZ, QUIET)).toEqual({ ok: true, at: new Date('2026-10-27T11:30:00.000Z') });
  });

  it('a day without a time asks for the time', () => {
    expect(resolveCallback({ day: 'tomorrow' }, NOW, TZ, QUIET)).toEqual({ ok: false, reason: 'time_needed' });
    expect(resolveCallback({ day: 'tomorrow', time: '5pm' }, NOW, TZ, QUIET)).toEqual({ ok: false, reason: 'time_needed' });
  });

  it('refuses a time that has passed, one too far ahead, and a day it cannot read', () => {
    expect(resolveCallback({ time: '10:00' }, NOW, TZ, QUIET)).toEqual({ ok: false, reason: 'in_the_past' });
    expect(resolveCallback({ day: '2026-12-01', time: '10:00' }, NOW, TZ, QUIET)).toEqual({ ok: false, reason: 'too_far' });
    expect(resolveCallback({ day: 'someday', time: '10:00' }, NOW, TZ, QUIET)).toEqual({ ok: false, reason: 'bad_day' });
  });

  it('a time inside quiet hours is refused with the first time it could be', () => {
    const r = resolveCallback({ day: 'tomorrow', time: '22:00' }, NOW, TZ, QUIET);
    expect(r).toEqual({ ok: false, reason: 'outside_hours', suggested: new Date('2026-10-29T02:30:00.000Z') });
  });

  it('with quiet hours off, any time is fine', () => {
    expect(resolveCallback({ day: 'tomorrow', time: '22:00' }, NOW, TZ)).toEqual({ ok: true, at: new Date('2026-10-28T16:30:00.000Z') });
  });
});

function setup(
  opts: {
    status?: string;
    dnc?: boolean;
    moved?: boolean;
    callbackAt?: Date | null;
    disposition?: string;
    setHere?: boolean;
    missed?: number;
    confirmSms?: boolean;
    retryMinutes?: number;
    retryAttempts?: number;
  } = {},
) {
  const prisma = {
    lead: {
      findFirst: vi.fn(async () => ({ status: opts.status ?? 'contacting', dncStatus: opts.dnc ?? false })),
      findUnique: vi.fn(async () => ({ callbackAt: opts.callbackAt === undefined ? null : opts.callbackAt, phone: '+12899174129', dncStatus: opts.dnc ?? false })),
      update: vi.fn(async () => ({})),
    },
    call: { findFirst: vi.fn(async () => ({ id: 'call-1', orgId: 'org-1', leadId: 'lead-1', disposition: opts.disposition ?? 'no_answer' })) },
    leadEvent: {
      findFirst: vi.fn(async (args: any) => (args.where.callId ? (opts.setHere ? { id: 'e1' } : null) : { createdAt: new Date('2026-10-27T05:00:00.000Z') })),
      count: vi.fn(async () => opts.missed ?? 0),
    },
  };
  const state = { move: vi.fn(async () => ({ moved: opts.moved ?? true, from: opts.status ?? 'contacting' })), quietly: vi.fn() };
  const followup = {
    guardrailsFor: vi.fn(async () => ({ timeZone: TZ, quiet: QUIET })),
    stopForLead: vi.fn(async () => 1),
    sequenceForTrigger: vi.fn(async () => 'no-answer-seq'),
    enroll: vi.fn(async () => true),
  };
  const engine = { stopStrategy: vi.fn() };
  const calls = { schedule: vi.fn(async () => 'job-1') };
  const sms = { sendSms: vi.fn(async () => ({ id: 'msg-1' })) };
  const activity = { leadVariables: vi.fn(async () => ({ firstName: 'Ana' })), recordSms: vi.fn(async () => undefined) };
  const conversations = { appendOurMessage: vi.fn(async () => undefined) };
  const tools = {
    settings: vi.fn(async () => ({
      confirmSms: opts.confirmSms ?? true,
      confirmMessage: "Thanks {{firstName}}! I'll call you on {{callbackTime}}.",
      retryMinutes: opts.retryMinutes ?? DEFAULT_RETRY_MINUTES,
      retryAttempts: opts.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS,
    })),
  };
  const service = new CallbackService(
    prisma as any,
    state as any,
    followup as any,
    engine as any,
    calls as any,
    sms as any,
    activity as any,
    conversations as any,
    tools as any,
  );
  return { service, prisma, state, followup, engine, calls, sms, activity };
}

const ON_CALL = { orgId: 'org-1', leadId: 'lead-1', callId: 'call-1' };

describe('CallbackService.schedule', () => {
  it('parks the lead with the time, stops the strategy and every sequence, and queues the call for then', async () => {
    const s = setup();
    const r = await s.service.schedule(ON_CALL, { day: 'tomorrow', time: '17:00', note: 'driving' }, NOW);
    const at = new Date('2026-10-28T11:30:00.000Z');

    expect(r).toMatchObject({ ok: true, scheduled: true, at: at.toISOString(), spoken: 'Wednesday, October 28 at 5:00 PM' });
    expect(s.state.move).toHaveBeenCalledWith('lead-1', 'follow_up', expect.objectContaining({
      source: 'call',
      callId: 'call-1',
      data: expect.objectContaining({ callbackAt: at, followUpReason: 'callback_requested' }),
    }));
    expect(s.engine.stopStrategy).toHaveBeenCalledWith('org-1', 'lead-1', 'call', 'Callback requested');
    expect(s.followup.stopForLead).toHaveBeenCalledWith('org-1', 'lead-1', 'callback_requested');
    expect(s.calls.schedule).toHaveBeenCalledWith(
      { orgId: 'org-1', leadId: 'lead-1', source: 'callback', callbackAt: at.toISOString() },
      at,
      `callback:lead-1:${at.getTime()}`,
    );
    expect(s.state.quietly).toHaveBeenCalledWith(expect.objectContaining({ type: 'callback_scheduled', callId: 'call-1', reason: 'driving' }));
  });

  it('a hot lead keeps its status; only the time is set', async () => {
    const s = setup({ status: 'interested' });
    const r = await s.service.schedule(ON_CALL, { time: '17:00' }, NOW);
    expect(r.ok).toBe(true);
    expect(s.state.move).not.toHaveBeenCalled();
    expect(s.prisma.lead.update).toHaveBeenCalledWith({ where: { id: 'lead-1' }, data: { callbackAt: new Date('2026-10-27T11:30:00.000Z') } });
    expect(s.calls.schedule).toHaveBeenCalled();
  });

  it('never for a booked lead, a do-not-contact one, or a wrong number', async () => {
    for (const opts of [{ status: 'appointment_booked' }, { dnc: true }, { status: 'invalid' }, { status: 'closed' }]) {
      const s = setup(opts);
      const r = await s.service.schedule(ON_CALL, { time: '17:00' }, NOW);
      expect(r.ok).toBe(false);
      expect(s.calls.schedule).not.toHaveBeenCalled();
      expect(s.followup.stopForLead).not.toHaveBeenCalled();
    }
  });

  it('a refused time changes nothing and tells the AI what to offer', async () => {
    const s = setup();
    const r = await s.service.schedule(ON_CALL, { day: 'tomorrow', time: '22:00' }, NOW);
    expect(r).toMatchObject({ ok: false, reason: 'outside_hours', suggested: { spoken: 'Thursday, October 29 at 8:00 AM' } });
    expect(r.say).toContain('between 08:00 and 21:00');
    expect(s.state.move).not.toHaveBeenCalled();
    expect(s.calls.schedule).not.toHaveBeenCalled();
  });

  it('in a text chat the AI confirms in its reply', async () => {
    const s = setup();
    const r = await s.service.schedule({ ...ON_CALL, callId: null }, { time: '17:00' }, NOW);
    expect(r.ok && r.say).toContain('in your reply');
    expect(s.state.move).toHaveBeenCalledWith('lead-1', 'follow_up', expect.objectContaining({ source: 'sms_chat', channel: 'sms' }));
  });
});

describe('CallbackService.onCallEnded', () => {
  const DUE = new Date('2026-10-27T05:00:00.000Z');

  it('after the call that set it: the lead gets the time by SMS', async () => {
    const s = setup({ callbackAt: new Date('2026-10-28T11:30:00.000Z'), setHere: true });
    await s.service.onCallEnded('cc-1', NOW);
    expect(s.sms.sendSms).toHaveBeenCalledWith('org-1', '+12899174129', "Thanks Ana! I'll call you on Wednesday, October 28 at 5:00 PM.");
    expect(s.activity.recordSms).toHaveBeenCalledWith('org-1', 'lead-1', expect.any(String), true, 'msg-1');
    expect(s.calls.schedule).not.toHaveBeenCalled();
  });

  it('no SMS when the organization turned the confirmation off', async () => {
    const s = setup({ callbackAt: new Date('2026-10-28T11:30:00.000Z'), setHere: true, confirmSms: false });
    await s.service.onCallEnded('cc-1', NOW);
    expect(s.sms.sendSms).not.toHaveBeenCalled();
  });

  it('nothing for a call placed before the callback was due', async () => {
    const s = setup({ callbackAt: new Date('2026-10-28T11:30:00.000Z') });
    await s.service.onCallEnded('cc-1', NOW);
    expect(s.prisma.lead.update).not.toHaveBeenCalled();
    expect(s.state.quietly).not.toHaveBeenCalled();
  });

  it('the callback call connected: done, the time is cleared', async () => {
    const s = setup({ callbackAt: DUE, disposition: 'connected' });
    await s.service.onCallEnded('cc-1', NOW);
    expect(s.prisma.lead.update).toHaveBeenCalledWith({ where: { id: 'lead-1' }, data: { callbackAt: null } });
    expect(s.state.quietly).toHaveBeenCalledWith(expect.objectContaining({ type: 'callback_done' }));
  });

  it('missed once: tried again in 15 minutes', async () => {
    const s = setup({ callbackAt: DUE, disposition: 'voicemail', missed: 0 });
    await s.service.onCallEnded('cc-1', NOW);
    const retry = new Date(NOW.getTime() + 15 * 60_000);
    expect(s.prisma.lead.update).toHaveBeenCalledWith({ where: { id: 'lead-1' }, data: { callbackAt: retry } });
    expect(s.calls.schedule).toHaveBeenCalledWith(expect.objectContaining({ source: 'callback', callbackAt: retry.toISOString() }), retry, expect.any(String));
    expect(s.followup.enroll).not.toHaveBeenCalled();
  });

  it('missed twice: the callback is dropped and the lead goes to the no-answer follow-up', async () => {
    const s = setup({ callbackAt: DUE, disposition: 'no_answer', missed: 1 });
    await s.service.onCallEnded('cc-1', NOW);
    expect(s.prisma.lead.update).toHaveBeenCalledWith({ where: { id: 'lead-1' }, data: { callbackAt: null } });
    expect(s.state.move).toHaveBeenCalledWith('lead-1', 'follow_up', expect.objectContaining({ onlyFrom: ['follow_up'], data: { followUpReason: 'no_answer' } }));
    expect(s.followup.enroll).toHaveBeenCalledWith('org-1', 'lead-1', 'no-answer-seq');
    expect(s.calls.schedule).not.toHaveBeenCalled();
  });

  it("the organization's own retry: how long after a miss, and how many times", async () => {
    const later = setup({ callbackAt: DUE, disposition: 'no_answer', missed: 1, retryMinutes: 60, retryAttempts: 2 });
    await later.service.onCallEnded('cc-1', NOW);
    const retry = new Date(NOW.getTime() + 60 * 60_000);
    expect(later.calls.schedule).toHaveBeenCalledWith(expect.objectContaining({ callbackAt: retry.toISOString() }), retry, expect.any(String));

    const none = setup({ callbackAt: DUE, disposition: 'no_answer', missed: 0, retryAttempts: 0 });
    await none.service.onCallEnded('cc-1', NOW);
    expect(none.calls.schedule).not.toHaveBeenCalled();
    expect(none.followup.enroll).toHaveBeenCalledWith('org-1', 'lead-1', 'no-answer-seq');
  });

  it('missed twice by a hot lead: it stays with its agent, no sequence', async () => {
    const s = setup({ callbackAt: DUE, disposition: 'no_answer', missed: 1, moved: false });
    await s.service.onCallEnded('cc-1', NOW);
    expect(s.followup.enroll).not.toHaveBeenCalled();
  });
});
