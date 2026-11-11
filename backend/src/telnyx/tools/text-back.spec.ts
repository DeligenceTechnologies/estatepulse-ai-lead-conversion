import { DelayedError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TEXT_BACK_MESSAGE } from './call-tools';
import { ACK_WINDOW_MS, TextBackService } from './text-back.service';
import { TextBackWorker } from './text-back.worker';

const TZ = 'Asia/Kolkata';
const QUIET = { start: '21:00', end: '08:00' };
// Tue 27 Oct 2026, 11:00 in Kolkata.
const NOW = new Date('2026-10-27T05:30:00.000Z');
const chat = { orgId: 'org-1', leadId: 'lead-1', callId: null };
/** HH:MM in TZ, `offsetMs` from now. */
const clock = (offsetMs: number) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(Date.now() + offsetMs));

function service(opts: { status?: string; dnc?: boolean; textBack?: boolean; queueDown?: boolean; scheduledAgoMs?: number; textBackAt?: Date | null } = {}) {
  const prisma = {
    lead: {
      findFirst: vi.fn(async () => ({ status: opts.status ?? 'engaged', dncStatus: opts.dnc ?? false, phone: '+12895550100' })),
      findUnique: vi.fn(async () => ({ textBackAt: opts.textBackAt === undefined ? new Date(Date.now() + 10 * 60_000) : opts.textBackAt })),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    leadEvent: {
      findFirst: vi.fn(async () => (opts.scheduledAgoMs === undefined ? null : { createdAt: new Date(Date.now() - opts.scheduledAgoMs) })),
    },
  };
  const state = { quietly: vi.fn() };
  const followup = { guardrailsFor: vi.fn(async () => ({ timeZone: TZ, quiet: QUIET })) };
  const tools = { settings: vi.fn(async () => ({ textBack: opts.textBack ?? true })) };
  const queue = { add: vi.fn(async () => (opts.queueDown ? Promise.reject(new Error('redis down')) : { id: 'job-1' })) };
  const svc = new TextBackService(prisma as any, state as any, followup as any, tools as any, queue as any);
  const events = () => state.quietly.mock.calls.map((c: any[]) => c[0].type);
  return { svc, prisma, state, queue, events };
}

describe('TextBackService.schedule', () => {
  it('"message me after 2 mins" in a chat: the lead is held for a text 2 minutes out, and the AI confirms that time', async () => {
    const s = service();
    const r = await s.svc.schedule(chat, { inMinutes: 2 }, NOW);
    const at = new Date(NOW.getTime() + 2 * 60_000);
    expect(r).toMatchObject({ ok: true, at: at.toISOString() });
    expect(r.say).toContain('Confirm in your reply that you will text them on');
    expect(s.prisma.lead.update).toHaveBeenCalledWith({ where: { id: 'lead-1' }, data: { textBackAt: at } });
    expect(s.queue.add).toHaveBeenCalledWith('text-back', { orgId: 'org-1', leadId: 'lead-1', at: at.toISOString() }, expect.objectContaining({ delay: expect.any(Number) }));
    expect(s.events()).toEqual(['text_back_scheduled']);
  });

  it('on a call it says goodbye after confirming', async () => {
    const r = await service().svc.schedule({ ...chat, callId: 'call-1' }, { day: 'tomorrow', time: '10:00' }, NOW);
    expect(r.ok && r.say).toMatch(/Confirm you will text them on .*, then say goodbye\./);
  });

  it('a time in quiet hours is refused with the first time a text may go', async () => {
    const s = service();
    const r = await s.svc.schedule(chat, { day: 'tomorrow', time: '22:00' }, NOW);
    expect(r).toMatchObject({ ok: false, reason: 'outside_hours', suggested: { at: '2026-10-29T02:30:00.000Z' } });
    expect(r.say).toContain('We only text between 08:00 and 21:00');
    expect(s.queue.add).not.toHaveBeenCalled();
  });

  it('a day with no time asks for the time, naming schedule_text', async () => {
    const r = await service().svc.schedule(chat, { day: 'tomorrow' }, NOW);
    expect(r).toMatchObject({ ok: false, reason: 'time_needed' });
    expect(r.say).toContain('call schedule_text again');
  });

  it('switched off by the organization, the AI asks the lead to text back instead', async () => {
    const s = service({ textBack: false });
    const r = await s.svc.schedule(chat, { inMinutes: 10 }, NOW);
    expect(r).toMatchObject({ ok: false, reason: 'off' });
    expect(s.prisma.lead.update).not.toHaveBeenCalled();
  });

  it('nothing for an opted-out, finished or booked lead', async () => {
    expect(await service({ dnc: true }).svc.schedule(chat, { inMinutes: 10 }, NOW)).toMatchObject({ ok: false, reason: 'not_textable' });
    expect(await service({ status: 'invalid' }).svc.schedule(chat, { inMinutes: 10 }, NOW)).toMatchObject({ ok: false, reason: 'not_textable' });
    expect(await service({ status: 'appointment_booked' }).svc.schedule(chat, { inMinutes: 10 }, NOW)).toMatchObject({ ok: false, reason: 'already_booked' });
    // A hot lead still gets the text.
    expect(await service({ status: 'interested' }).svc.schedule(chat, { inMinutes: 10 }, NOW)).toMatchObject({ ok: true });
  });

  it('when the queue cannot take it, the hold is undone and the AI makes no promise', async () => {
    const s = service({ queueDown: true });
    const r = await s.svc.schedule(chat, { inMinutes: 10 }, NOW);
    expect(r).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(s.prisma.lead.updateMany).toHaveBeenCalledWith({ where: { id: 'lead-1', textBackAt: new Date(NOW.getTime() + 10 * 60_000) }, data: { textBackAt: null } });
    expect(s.events()).toEqual([]);
  });
});

describe('TextBackService.onLeadTexted', () => {
  it('a quick "ok thanks" right after the promise leaves it standing', async () => {
    const s = service({ scheduledAgoMs: ACK_WINDOW_MS - 30_000 });
    await s.svc.onLeadTexted('org-1', 'lead-1');
    expect(s.prisma.lead.updateMany).not.toHaveBeenCalled();
  });

  it('the lead coming back to the chat later cancels it', async () => {
    const s = service({ scheduledAgoMs: ACK_WINDOW_MS + 60_000 });
    await s.svc.onLeadTexted('org-1', 'lead-1');
    expect(s.prisma.lead.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { textBackAt: null } }));
    expect(s.events()).toEqual(['text_back_cancelled']);
  });

  it('nothing to cancel when no text is pending', async () => {
    const s = service({ textBackAt: null, scheduledAgoMs: ACK_WINDOW_MS + 60_000 });
    await s.svc.onLeadTexted('org-1', 'lead-1');
    expect(s.prisma.lead.updateMany).not.toHaveBeenCalled();
  });
});

function worker(
  opts: {
    textBackAt?: Date | null;
    status?: string;
    dnc?: boolean;
    paused?: boolean;
    meeting?: number;
    sendFails?: boolean;
    attemptsMade?: number;
    quietNow?: boolean;
    lastCall?: Record<string, unknown> | null;
  } = {},
) {
  const at = '2026-10-27T05:32:00.000Z';
  const prisma = {
    lead: {
      findUnique: vi.fn(async () => ({
        phone: '+12895550100',
        // The lead's own clock is the test's clock, so the quiet-hours cases below read as before.
        timezone: TZ,
        status: opts.status ?? 'engaged',
        dncStatus: opts.dnc ?? false,
        automationPaused: opts.paused ?? false,
        textBackAt: opts.textBackAt === undefined ? new Date(at) : opts.textBackAt,
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    calendarMeeting: { count: vi.fn(async () => opts.meeting ?? 0) },
    call: { findFirst: vi.fn(async () => opts.lastCall ?? null) },
  };
  const config = { get: vi.fn(() => true) };
  // Quiet hours off unless the test puts "now" inside them: a window from a minute ago to an hour from now.
  const followup = {
    guardrailsFor: vi.fn(async () => ({ timeZone: TZ, quiet: opts.quietNow ? { start: clock(-60_000), end: clock(60 * 60_000) } : undefined })),
    holdOnce: vi.fn(async () => undefined),
  };
  const state = { quietly: vi.fn() };
  const tools = { settings: vi.fn(async () => ({ textBackMessage: DEFAULT_TEXT_BACK_MESSAGE })) };
  const sms = { sendSms: vi.fn(async () => (opts.sendFails ? Promise.reject(new Error('Telnyx unreachable')) : { id: 'msg-1' })) };
  const activity = { leadVariables: vi.fn(async () => ({ firstName: 'Ana', brokerage: 'Skyline' })), recordSms: vi.fn(async () => undefined) };
  const conversations = { appendOurMessage: vi.fn(async () => undefined) };
  const w = new TextBackWorker(prisma as any, config as any, followup as any, state as any, tools as any, sms as any, activity as any, conversations as any);
  const job = {
    name: 'text-back',
    data: { orgId: 'org-1', leadId: 'lead-1', at },
    attemptsMade: opts.attemptsMade ?? 0,
    opts: { attempts: 3 },
    moveToDelayed: vi.fn(async () => undefined),
  };
  const events = () => state.quietly.mock.calls.map((c: any[]) => c[0].type);
  return { w, job, prisma, sms, activity, conversations, events };
}

describe('TextBackWorker', () => {
  it('sends the organization message and adds it to the AI chat, keeping the time for the steps after it', async () => {
    const s = worker();
    await s.w.process(s.job as any);
    const text = "Hi Ana, it's Skyline again, following up as you asked. Is now a better time to chat?";
    expect(s.sms.sendSms).toHaveBeenCalledWith('org-1', '+12895550100', text);
    expect(s.activity.recordSms).toHaveBeenCalledWith('org-1', 'lead-1', text, true, 'msg-1');
    expect(s.conversations.appendOurMessage).toHaveBeenCalledWith('org-1', '+12895550100', text);
    expect(s.prisma.lead.updateMany).not.toHaveBeenCalled();
    expect(s.events()).toEqual(['text_back_sent']);
  });

  it('a text moved to another time, or cancelled, is dropped without sending', async () => {
    for (const textBackAt of [null, new Date('2026-10-28T05:00:00.000Z')]) {
      const s = worker({ textBackAt });
      await s.w.process(s.job as any);
      expect(s.sms.sendSms).not.toHaveBeenCalled();
    }
  });

  it('nothing goes to an opted-out, finished or booked lead', async () => {
    for (const opts of [{ dnc: true }, { status: 'not_interested' }, { meeting: 1 }]) {
      const s = worker(opts);
      await s.w.process(s.job as any);
      expect(s.sms.sendSms).not.toHaveBeenCalled();
      expect(s.events()).toEqual(['text_back_dropped']);
    }
  });

  it('promoted before its time, it waits for the hour the lead asked for', async () => {
    // Setting a lead's time zone promotes every delayed job they have; "text me tomorrow at 10" is still tomorrow at 10.
    const at = new Date(Date.now() + 60 * 60_000);
    const s = worker({ textBackAt: at });
    s.job.data.at = at.toISOString();
    await expect(s.w.process(s.job as any)).rejects.toBeInstanceOf(DelayedError);
    expect(s.job.moveToDelayed).toHaveBeenCalledWith(at.getTime(), undefined);
    expect(s.sms.sendSms).not.toHaveBeenCalled();
  });

  it('still keeps the promise to a lead whose automation is paused (after an agent handed the chat back)', async () => {
    const s = worker({ paused: true });
    await s.w.process(s.job as any);
    expect(s.sms.sendSms).toHaveBeenCalledOnce();
  });

  it('waits out quiet hours', async () => {
    const s = worker({ quietNow: true });
    await expect(s.w.process(s.job as any)).rejects.toBeInstanceOf(DelayedError);
    expect(s.job.moveToDelayed).toHaveBeenCalled();
    expect(s.sms.sendSms).not.toHaveBeenCalled();
  });

  it("a text asked for on a call waits until that call's answers are saved, so it knows what the lead said", async () => {
    const live = worker({ lastCall: { status: 'in_progress', disposition: null, endedAt: null, extractedIntel: null } });
    await expect(live.w.process(live.job as any)).rejects.toBeInstanceOf(DelayedError);

    const scoring = worker({ lastCall: { status: 'completed', disposition: 'connected', endedAt: new Date(Date.now() - 30_000), extractedIntel: {} } });
    await expect(scoring.w.process(scoring.job as any)).rejects.toBeInstanceOf(DelayedError);
    expect(scoring.sms.sendSms).not.toHaveBeenCalled();

    const scored = worker({
      lastCall: { status: 'completed', disposition: 'connected', endedAt: new Date(Date.now() - 30_000), extractedIntel: { qualification: { score: 40 } } },
    });
    await scored.w.process(scored.job as any);
    expect(scored.sms.sendSms).toHaveBeenCalled();

    const gaveUp = worker({ lastCall: { status: 'completed', disposition: 'connected', endedAt: new Date(Date.now() - 4 * 60_000), extractedIntel: {} } });
    await gaveUp.w.process(gaveUp.job as any);
    expect(gaveUp.sms.sendSms).toHaveBeenCalled();
  });

  it('a failed send is tried again by the queue; the last failure is recorded and the promise given up', async () => {
    const first = worker({ sendFails: true });
    await expect(first.w.process(first.job as any)).rejects.toThrow('Telnyx unreachable');
    expect(first.activity.recordSms).not.toHaveBeenCalled();

    const last = worker({ sendFails: true, attemptsMade: 2 });
    await last.w.process(last.job as any);
    expect(last.activity.recordSms).toHaveBeenCalledWith('org-1', 'lead-1', expect.any(String), false, 'Telnyx unreachable');
    expect(last.events()).toEqual(['text_back_dropped']);
  });
});
