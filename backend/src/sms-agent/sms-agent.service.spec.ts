import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OptedOutError } from '@/telnyx/sms.service';
import { AI_REPLY_CAPPED_REVIEW, AI_REPLY_FAILED_REVIEW } from './sms-agent';
import { AI_REPLIES_PER_HOUR, SmsAgentService, type SmsReplyJobData } from './sms-agent.service';

const JOB: SmsReplyJobData = { orgId: 'org-1', leadId: 'lead-1', inboundId: 'in-1', receivedAt: '2026-11-04T10:00:00.000Z' };

const ASSISTANT = {
  model: 'moonshotai/Kimi-K2.6',
  instructions: '# Role\nYou text for {{brokerage}}. Channel {{telnyx_conversation_channel}}.\nKnown: {{knownInfo}}',
  tools: [
    { type: 'hangup', hangup: {} },
    ...['schedule_callback', 'schedule_text', 'record_outcome', 'check_availability', 'book_appointment'].map((name) => ({
      type: 'webhook',
      webhook: { name, description: `${name} tool`, body_parameters: { type: 'object', properties: {} } },
    })),
  ],
};

type Reply = { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } | Error;
const call = (name: string, args: Record<string, unknown>, id = `call-${name}`) => ({ id, function: { name, arguments: JSON.stringify(args) } });

function setup(opts: { replies?: Reply[]; lead?: Record<string, unknown>; fresh?: Record<string, unknown>; newer?: boolean[]; repliesHere?: boolean[]; answered?: boolean; repliesLastHour?: number; booking?: boolean } = {}) {
  const lead = { id: 'lead-1', phone: '+12895550100', normalizedPhone: '+12895550100', dncStatus: false, takenOverById: null, reviewReasons: [] as string[], ...opts.lead };
  const newer = [...(opts.newer ?? [false, false])];
  const here = [...(opts.repliesHere ?? [true, true])];
  const prisma = {
    lead: {
      findFirst: vi.fn(async () => lead),
      findUnique: vi.fn(async (_args: any): Promise<any> => ({ dncStatus: false, takenOverById: null, reviewReasons: lead.reviewReasons, ...opts.fresh })),
      update: vi.fn(async () => ({})),
    },
    leadEvent: {
      count: vi.fn(async ({ where }: any) => (where.payload ? (opts.answered ? 1 : 0) : (opts.repliesLastHour ?? 0))),
    },
    message: {
      findFirst: vi.fn(async () => (newer.shift() ? { id: 'newer' } : null)),
      findMany: vi.fn(async () => [
        { direction: 'inbound', senderType: 'lead', body: 'What areas do you cover?', senderUser: null },
        { direction: 'outbound', senderType: 'ai', body: 'Hi Ana, thanks for reaching out!', senderUser: null },
      ]),
      create: vi.fn(async () => ({})),
    },
    organizationSetting: { findUnique: vi.fn(async () => ({ timezone: 'America/Toronto' })) },
  };
  const creds = { getCreds: vi.fn(async () => ({ apiKey: 'KEY', assistantId: 'assistant-1', fromNumber: '+17427245092' })) };
  const conversations = { repliesHere: vi.fn(async () => (here.length ? here.shift()! : true)) };
  const activity = { leadVariables: vi.fn(async () => ({ firstName: 'Ana', brokerage: 'Skyline Realty', knownInfo: '- Budget: 500k' })) };
  const sms = { sendSms: vi.fn(async (_org: string, _to: string, text: string, _opts?: unknown) => ({ id: 'sms-1', text })) };
  const state = { quietly: vi.fn() };
  const events = { publish: vi.fn() };
  const outcomes = { record: vi.fn(async () => ({ ok: true, recorded: 'do_not_contact', say: 'Confirm they will not be contacted again.' })) };
  const callbacks = { schedule: vi.fn(async () => ({ ok: true, scheduled: true, at: '2026-11-04T10:05:00Z', spoken: 'today at 10:05 AM', say: 'Tell them.' })) };
  const textBacks = { schedule: vi.fn(async () => ({ ok: true, scheduled: true, at: '2026-11-04T10:10:00Z', spoken: 'today at 10:10 AM', say: 'Tell them.' })) };
  const booking = {
    availability: vi.fn(async () => ({ ok: true, timezone: 'America/Toronto', today: '2026-11-04', requestedTimeAvailable: null, slots: [] })),
    book: vi.fn(async () => ({ ok: true, booked: true, agentName: 'Priya', spoken: 'Sat 10 AM', say: 'Confirm. Details: https://calendly.com/m/abc' })),
  };
  const bookingSettings = { activeConfig: vi.fn(async () => (opts.booking === false ? null : { tokenHash: 'h', eventTypeUri: 'uri' })) };

  const replies = [...(opts.replies ?? [{ content: 'We cover the whole metro area. Which part of town?' }])];
  const completions: any[] = [];
  const fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (url.endsWith('/ai/assistants/assistant-1')) return new Response(JSON.stringify({ data: ASSISTANT }), { status: 200 });
    if (url.endsWith('/ai/chat/completions')) {
      completions.push(JSON.parse(init!.body!));
      const next = replies.shift() ?? { content: '' };
      if (next instanceof Error) return new Response(next.message, { status: 500 });
      return new Response(JSON.stringify({ choices: [{ message: next }], usage: { prompt_tokens: 3000, completion_tokens: 40 } }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetch);

  const service = new SmsAgentService(
    prisma as any,
    creds as any,
    conversations as any,
    activity as any,
    sms as any,
    state as any,
    events as any,
    outcomes as any,
    callbacks as any,
    textBacks as any,
    booking as any,
    bookingSettings as any,
  );
  const events_ = () => state.quietly.mock.calls.map((c: any[]) => c[0]);
  return { service, prisma, sms, state, events, outcomes, callbacks, textBacks, booking, completions, fetch, lead, events_ };
}

describe('SmsAgentService.answer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe('a plain reply', () => {
    it("writes it from the assistant's own instructions, model and tools, the lead's details and the chat, then sends and records it", async () => {
      const s = setup();
      expect(await s.service.answer(JOB)).toBe('sent');

      const body = s.completions[0];
      expect(body.model).toBe('moonshotai/Kimi-K2.6');
      expect(body.messages[0].role).toBe('system');
      expect(body.messages[0].content).toContain('You text for Skyline Realty. Channel sms_chat.\nKnown: - Budget: 500k');
      expect(body.messages[0].content).toMatch(/It is now .+ \(America\/Toronto\)\.$/);
      // Oldest first: the history was read newest first.
      expect(body.messages.slice(1)).toEqual([
        { role: 'assistant', content: 'Hi Ana, thanks for reaching out!' },
        { role: 'user', content: 'What areas do you cover?' },
      ]);
      expect(body.tools.map((t: any) => t.function.name)).toEqual(['schedule_callback', 'schedule_text', 'record_outcome', 'check_availability', 'book_appointment']);

      expect(s.sms.sendSms).toHaveBeenCalledWith('org-1', '+12895550100', 'We cover the whole metro area. Which part of town?', { evenIfOptedOut: false });
      expect(s.prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ leadId: 'lead-1', senderType: 'ai', direction: 'outbound', providerMessageId: 'sms-1', deliveryStatus: 'sent' }),
      });
      expect(s.events_()).toContainEqual(
        expect.objectContaining({ type: 'ai_reply', payload: { inboundId: 'in-1', tools: [], model: 'moonshotai/Kimi-K2.6', usage: { prompt_tokens: 3000, completion_tokens: 40 } } }),
      );
      expect(s.events.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'conversation.updated', leadId: 'lead-1' }));
    });

    it('tells the AI where the lead stands when it answers outside the usual chat', async () => {
      const no = setup();
      await no.service.answer({ ...JOB, status: 'not_interested' as any });
      expect(no.completions[0].messages[0].content).toContain('About this lead: Earlier this lead told us they were not interested.');

      const stranger = setup();
      await stranger.service.answer({ ...JOB, status: 'new' as any, stranger: true });
      expect(stranger.completions[0].messages[0].content).toContain('About this lead: This number is not one of our leads yet.');

      const active = setup();
      await active.service.answer({ ...JOB, status: 'engaged' as any });
      expect(active.completions[0].messages[0].content).not.toContain('About this lead');
    });

    it('reads the assistant once a minute, not on every text', async () => {
      const s = setup({ replies: [{ content: 'One.' }, { content: 'Two.' }] });
      await s.service.answer(JOB);
      await s.service.answer({ ...JOB, inboundId: 'in-2' });
      expect(s.fetch.mock.calls.filter((c: any[]) => String(c[0]).endsWith('/ai/assistants/assistant-1'))).toHaveLength(1);
    });

    it('takes out a link the model made up', async () => {
      const s = setup({ replies: [{ content: 'See https://evil.example/x for listings!' }] });
      await s.service.answer(JOB);
      expect(s.sms.sendSms.mock.calls[0][2]).toBe('See for listings!');
    });
  });

  describe('tools', () => {
    it('runs a callback in process, with the chat as the caller, and answers with what it did', async () => {
      const s = setup({ replies: [{ content: '', tool_calls: [call('schedule_callback', { in_minutes: '5', note: 'busy' })] }, { content: "Sure, I'll call you at 10:05." }] });
      expect(await s.service.answer(JOB)).toBe('sent');
      expect(s.callbacks.schedule).toHaveBeenCalledWith({ orgId: 'org-1', leadId: 'lead-1', callId: null }, { day: undefined, time: undefined, inMinutes: 5, note: 'busy' });
      const second = s.completions[1].messages;
      expect(second.at(-2)).toEqual({ role: 'assistant', content: '', tool_calls: [call('schedule_callback', { in_minutes: '5', note: 'busy' })] });
      expect(second.at(-1)).toEqual({ role: 'tool', tool_call_id: 'call-schedule_callback', content: expect.stringContaining('"ok":true') });
      expect(s.events_()).toContainEqual(expect.objectContaining({ type: 'ai_reply', payload: expect.objectContaining({ tools: ['schedule_callback'] }) }));
    });

    it('books with the organization\'s booking settings, and may repeat the link the booking returned', async () => {
      const s = setup({
        replies: [
          { content: '', tool_calls: [call('book_appointment', { start_time: '2026-11-07T15:00:00Z', email: 'ana@x.com' })] },
          { content: "You're booked with Priya, Sat 10 AM. Details: https://calendly.com/m/abc" },
        ],
      });
      await s.service.answer(JOB);
      expect(s.booking.book).toHaveBeenCalledWith(
        { orgId: 'org-1', leadId: 'lead-1', callId: null, config: { tokenHash: 'h', eventTypeUri: 'uri' } },
        { start_time: '2026-11-07T15:00:00Z', email: 'ana@x.com', name: undefined },
      );
      expect(s.sms.sendSms.mock.calls[0][2]).toContain('https://calendly.com/m/abc');
    });

    it('tells the model booking is off when the organization has no booking', async () => {
      const s = setup({ booking: false, replies: [{ content: '', tool_calls: [call('check_availability', { day: 'tomorrow' })] }, { content: 'An agent will reach out to schedule.' }] });
      await s.service.answer(JOB);
      expect(s.booking.availability).not.toHaveBeenCalled();
      expect(s.completions[1].messages.at(-1).content).toContain('booking_off');
    });

    it('turns a tool that throws, an unknown tool and bad arguments into results the model can act on', async () => {
      const s = setup({
        replies: [
          { content: '', tool_calls: [call('schedule_text', {}, 'a'), call('hangup', {}, 'b'), { id: 'c', function: { name: 'record_outcome', arguments: '{not json' } }] },
          { content: 'Someone from the team will follow up.' },
        ],
      });
      s.textBacks.schedule.mockRejectedValueOnce(new Error('db down'));
      expect(await s.service.answer(JOB)).toBe('sent');
      const results = s.completions[1].messages.filter((m: any) => m.role === 'tool').map((m: any) => JSON.parse(m.content).reason);
      expect(results).toEqual(['error', 'unknown_tool', 'bad_arguments']);
    });

    it("sends the AI's opt-out confirmation although the lead is now do-not-contact", async () => {
      const s = setup({
        replies: [{ content: '', tool_calls: [call('record_outcome', { outcome: 'do_not_contact' })] }, { content: "You're unsubscribed. Sorry for the bother." }],
        fresh: { dncStatus: true },
      });
      expect(await s.service.answer(JOB)).toBe('sent');
      expect(s.sms.sendSms).toHaveBeenCalledWith('org-1', '+12895550100', "You're unsubscribed. Sorry for the bother.", { evenIfOptedOut: true });
    });

    it('stops after four rounds of tools without words, and leaves the lead to a person', async () => {
      const loop = { content: '', tool_calls: [call('check_availability', { day: 'today' })] };
      const s = setup({ replies: [loop, loop, loop, loop, loop] });
      expect(await s.service.answer(JOB)).toBe('failed');
      expect(s.completions).toHaveLength(4);
    });
  });

  describe('a reply that must not go', () => {
    it('is skipped when the organization went back to Telnyx replies', async () => {
      const s = setup({ repliesHere: [false] });
      expect(await s.service.answer(JOB)).toBe('engine_off');
      expect(s.completions).toHaveLength(0);
    });

    it('is not sent twice when the job runs again', async () => {
      const s = setup({ answered: true });
      expect(await s.service.answer(JOB)).toBe('answered');
      expect(s.sms.sendSms).not.toHaveBeenCalled();
    });

    it("leaves a text the lead followed with another to that one's job", async () => {
      const s = setup({ newer: [true] });
      expect(await s.service.answer(JOB)).toBe('newer_text');
      expect(s.completions).toHaveLength(0);
    });

    it('drops a reply when the lead texted again while it was written, unless it did something', async () => {
      const idle = setup({ newer: [false, true] });
      expect(await idle.service.answer(JOB)).toBe('newer_text');
      expect(idle.sms.sendSms).not.toHaveBeenCalled();

      const acted = setup({ newer: [false, true], replies: [{ content: '', tool_calls: [call('schedule_callback', { in_minutes: 5 })] }, { content: 'Calling you at 10:05.' }] });
      expect(await acted.service.answer(JOB)).toBe('sent');
    });

    it('drops a reply when an agent took the chat over or the lead opted out meanwhile', async () => {
      const taken = setup({ fresh: { takenOverById: 'agent-1' } });
      expect(await taken.service.answer(JOB)).toBe('taken_over');
      const optedOut = setup({ fresh: { dncStatus: true } });
      expect(await optedOut.service.answer(JOB)).toBe('opted_out');
      expect(taken.sms.sendSms).not.toHaveBeenCalled();
      expect(optedOut.sms.sendSms).not.toHaveBeenCalled();
    });

    it('is not written for a lead an agent holds or who opted out', async () => {
      expect(await setup({ lead: { takenOverById: 'agent-1' } }).service.answer(JOB)).toBe('taken_over');
      expect(await setup({ lead: { dncStatus: true } }).service.answer(JOB)).toBe('opted_out');
    });

    it('stops answering a number that texts without end, flagging it once', async () => {
      const s = setup({ repliesLastHour: AI_REPLIES_PER_HOUR });
      expect(await s.service.answer(JOB)).toBe('capped');
      expect(s.prisma.lead.update).toHaveBeenCalledWith({ where: { id: 'lead-1' }, data: { needsReview: true, reviewReasons: { push: AI_REPLY_CAPPED_REVIEW } } });
      const again = setup({ repliesLastHour: AI_REPLIES_PER_HOUR, lead: { reviewReasons: [AI_REPLY_CAPPED_REVIEW] } });
      await again.service.answer(JOB);
      expect(again.prisma.lead.update).not.toHaveBeenCalled();
    });
  });

  describe('when nobody can answer', () => {
    it('flags the lead for a person when the model fails twice', async () => {
      const s = setup({ replies: [new Error('upstream'), new Error('upstream')] });
      expect(await s.service.answer(JOB)).toBe('failed');
      expect(s.prisma.lead.update).toHaveBeenCalledWith({ where: { id: 'lead-1' }, data: { needsReview: true, reviewReasons: { push: AI_REPLY_FAILED_REVIEW } } });
      expect(s.events_()).toContainEqual(expect.objectContaining({ type: 'ai_reply_failed' }));
      expect(s.sms.sendSms).not.toHaveBeenCalled();
    });

    it('gets over one failed model call', async () => {
      const s = setup({ replies: [new Error('upstream'), { content: 'Hello!' }] });
      expect(await s.service.answer(JOB)).toBe('sent');
    });

    it('flags the lead when the model says nothing', async () => {
      const s = setup({ replies: [{ content: '   ' }] });
      expect(await s.service.answer(JOB)).toBe('failed');
    });

    it('tries a send that failed for a passing reason twice more, and flags the lead when it never goes', async () => {
      vi.useFakeTimers();
      const s = setup();
      const busy = new Error('Telnyx POST /messages failed 503: {}');
      s.sms.sendSms.mockRejectedValueOnce(busy).mockRejectedValueOnce(busy);
      const done = s.service.answer(JOB);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await done).toBe('sent');
      expect(s.sms.sendSms).toHaveBeenCalledTimes(3);

      const down = setup();
      down.sms.sendSms.mockRejectedValue(busy);
      const failed = down.service.answer(JOB);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await failed).toBe('failed');
    });

    it('drops a reply quietly when the number opted out on our list meanwhile', async () => {
      const s = setup();
      s.sms.sendSms.mockRejectedValueOnce(new OptedOutError('This number asked not to be contacted'));
      expect(await s.service.answer(JOB)).toBe('opted_out');
      expect(s.prisma.lead.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ needsReview: true }) }));
    });
  });
});

beforeEach(() => vi.clearAllMocks());
