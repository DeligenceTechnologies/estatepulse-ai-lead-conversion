import { describe, expect, it, vi } from 'vitest';
import { LeadStateService } from '@/lead/lead-state.service';
import { InboundSmsService } from './inbound-sms.service';

function setup(start: { status: string; dncStatus: boolean; takenOverById?: string | null }, opts: { ai?: boolean; intent?: string } = {}) {
  const lead = { id: 'lead-1', orgId: 'org-1', firstResponseAt: null, takenOverById: null, ...start };
  const prisma = {
    message: {
      findFirst: vi.fn(async () => null as unknown),
      findMany: vi.fn(async () => [{ direction: 'inbound', body: 'latest' }]),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
    },
    lead: {
      findFirst: vi.fn(async () => ({ ...lead })),
      findUnique: vi.fn(async () => ({ ...lead })),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async ({ data }: any) => {
        if (data?.status) lead.status = data.status;
        return { count: 1 };
      }),
    },
    leadEvent: { create: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(prisma)),
  };
  const creds = { orgForNumber: vi.fn(async () => 'org-1') };
  const followup = { pauseForLead: vi.fn(), stopForLead: vi.fn() };
  const engine = { setStatus: vi.fn(async () => true) };
  const conversations = {
    isEnabled: vi.fn(async () => Boolean(opts.ai)),
    appendToChat: vi.fn(async () => undefined),
    pauseAi: vi.fn(async () => true),
  };
  const intents = { classify: vi.fn(async () => ({ intent: opts.intent ?? 'continue', reason: 'test' })) };
  const textBacks = { onLeadTexted: vi.fn(async () => undefined) };
  const callTools = { ensure: vi.fn(async () => undefined) };
  const bus = { publish: vi.fn() };
  const service = new InboundSmsService(
    prisma as any,
    creds as any,
    followup as any,
    new LeadStateService(prisma as any),
    engine as any,
    conversations as any,
    intents as any,
    textBacks as any,
    callTools as any,
    bus as any,
  );
  const receive = (text: string) =>
    service.onMessageReceived({ id: 'm-1', text, from: { phone_number: '+12899174129' }, to: [{ phone_number: '+17427245092' }] });
  const events = () => prisma.leadEvent.create.mock.calls.map((c: any[]) => c[0].data.type);
  const optedIn = () => prisma.lead.update.mock.calls.some((c: any[]) => c[0]?.data?.consentStatus === 'granted');
  const finalize = (id: string, status = 'delivered', text = 'Great, when are you hoping to move?') =>
    service.onMessageFinalized('org-1', { id, text, from: { phone_number: '+17427245092' }, to: [{ phone_number: '+12899174129', status }] });
  return { receive, finalize, service, prisma, followup, engine, intents, lead, events, optedIn, textBacks, callTools, conversations, bus };
}

describe('InboundSmsService', () => {
  it('treats "Yes" as a reply: the lead is engaged and a person must see it, not an opt-in', async () => {
    const s = setup({ status: 'contacting', dncStatus: false });
    await s.receive('Yes');
    expect(s.lead.status).toBe('engaged');
    expect(s.prisma.lead.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ automationPaused: true }) }));
    expect(s.followup.pauseForLead).toHaveBeenCalledWith('org-1', 'lead-1');
    expect(s.optedIn()).toBe(false);
  });

  it('reopens a lead that had gone silent when it finally replies', async () => {
    const s = setup({ status: 'unresponsive', dncStatus: false });
    await s.receive('Sorry, was travelling. Still looking!');
    expect(s.lead.status).toBe('engaged');
  });

  it('lets START lift an opt-out and park the lead for a person', async () => {
    const s = setup({ status: 'not_interested', dncStatus: true });
    await s.receive('START');
    expect(s.optedIn()).toBe(true);
    expect(s.lead.status).toBe('follow_up');
    expect(s.events()).toEqual(['status_changed', 'opted_in']);
    expect(s.followup.pauseForLead).not.toHaveBeenCalled();
  });

  it('reads START from a lead who never opted out as an ordinary reply', async () => {
    const s = setup({ status: 'contacting', dncStatus: false });
    await s.receive('start');
    expect(s.optedIn()).toBe(false);
    expect(s.followup.pauseForLead).toHaveBeenCalledOnce();
  });

  it('honours STOP at once: DNC, not interested, sequences stopped, all logged', async () => {
    const s = setup({ status: 'follow_up', dncStatus: false });
    await s.receive('STOP');
    expect(s.prisma.lead.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ dncStatus: true }) }));
    expect(s.lead.status).toBe('not_interested');
    expect(s.events()).toEqual(['status_changed', 'opted_out']);
    expect(s.followup.stopForLead).toHaveBeenCalledWith('org-1', 'lead-1', 'opted_out', s.prisma);
  });

  it('keeps a booked lead booked on STOP: texts stop, the meeting stands', async () => {
    const s = setup({ status: 'appointment_booked', dncStatus: false });
    await s.receive('STOP');
    expect(s.lead.status).toBe('appointment_booked');
    expect(s.prisma.lead.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ dncStatus: true }) }));
    expect(s.events()).toEqual(['opted_out']);
  });

  describe('when the AI answers texts', () => {
    it('keeps the lead in automation: engaged, not paused, nothing paused for a person', async () => {
      const s = setup({ status: 'contacting', dncStatus: false }, { ai: true });
      await s.receive('Yes, looking in Austin');
      expect(s.lead.status).toBe('engaged');
      expect(s.prisma.lead.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ automationPaused: true }) }));
      expect(s.followup.pauseForLead).not.toHaveBeenCalled();
      expect(s.engine.setStatus).not.toHaveBeenCalled();
    });

    it('records a clear no as not interested', async () => {
      const s = setup({ status: 'contacting', dncStatus: false }, { ai: true, intent: 'not_interested' });
      await s.receive('No thanks, we already bought a place');
      expect(s.engine.setStatus).toHaveBeenCalledWith('org-1', 'lead-1', 'not_interested', expect.stringContaining('already bought'), { source: 'sms_reply' });
    });

    it('records a wrong number as invalid', async () => {
      const s = setup({ status: 'contacting', dncStatus: false }, { ai: true, intent: 'wrong_number' });
      await s.receive('Who is this? I never asked about a house');
      expect(s.engine.setStatus).toHaveBeenCalledWith('org-1', 'lead-1', 'invalid', expect.any(String), { source: 'sms_reply' });
    });

    it('treats "stop texting me" in other words as an opt-out', async () => {
      const s = setup({ status: 'engaged', dncStatus: false }, { ai: true, intent: 'opt_out' });
      await s.receive('please remove me from your list');
      expect(s.prisma.lead.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ dncStatus: true }) }));
      expect(s.lead.status).toBe('not_interested');
    });

    it('stores the AI\'s reply from its delivery report, once', async () => {
      const s = setup({ status: 'engaged', dncStatus: false }, { ai: true });
      await s.finalize('ai-msg-1');
      expect(s.prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ senderType: 'ai', direction: 'outbound', body: 'Great, when are you hoping to move?', deliveryStatus: 'delivered' }),
      });
    });
  });

  it('marks a text we sent as delivered or failed from its delivery report', async () => {
    const s = setup({ status: 'contacting', dncStatus: false });
    s.prisma.message.findFirst.mockResolvedValueOnce({ id: 'row-1' });
    await s.finalize('our-msg-1', 'delivery_failed');
    expect(s.prisma.message.update).toHaveBeenCalledWith({ where: { id: 'row-1' }, data: expect.objectContaining({ deliveryStatus: 'failed' }) });
    expect(s.prisma.message.create).not.toHaveBeenCalled();
  });

  it('does not store texts it did not send when the AI is not answering', async () => {
    const s = setup({ status: 'contacting', dncStatus: false });
    await s.finalize('someone-else');
    expect(s.prisma.message.create).not.toHaveBeenCalled();
  });

  it("dates a text by when Telnyx got it, and reads the intent from the texts before it, not the AI's answer to it", async () => {
    const s = setup({ status: 'engaged', dncStatus: false }, { ai: true });
    const receivedAt = '2026-10-28T11:36:20.259+00:00';
    await s.service.onMessageReceived({ id: 'm-2', text: 'message me after 2 mins', received_at: receivedAt, from: { phone_number: '+12899174129' }, to: [{ phone_number: '+17427245092' }] });
    expect(s.prisma.message.create).toHaveBeenCalledWith({ data: expect.objectContaining({ direction: 'inbound', sentAt: new Date(receivedAt), createdAt: new Date(receivedAt) }) });
    expect(s.prisma.message.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ createdAt: { lt: new Date(receivedAt) } }) }));
  });

  describe('in a chat an agent has taken over', () => {
    it('leaves the reply to the agent: no intent check, no status move, and the text goes into the paused AI chat', async () => {
      const s = setup({ status: 'appointment_booked', dncStatus: false, takenOverById: 'agent-1' }, { ai: true, intent: 'not_interested' });
      await s.receive('Can we move it to Friday?');
      expect(s.intents.classify).not.toHaveBeenCalled();
      expect(s.engine.setStatus).not.toHaveBeenCalled();
      expect(s.lead.status).toBe('appointment_booked');
      expect(s.conversations.appendToChat).toHaveBeenCalledWith('org-1', '+12899174129', 'user', 'Can we move it to Friday?', expect.any(Date));
      expect(s.bus.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'conversation.updated', leadId: 'lead-1' }));
    });

    it('still honours STOP', async () => {
      const s = setup({ status: 'engaged', dncStatus: false, takenOverById: 'agent-1' }, { ai: true });
      await s.receive('STOP');
      expect(s.prisma.lead.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ dncStatus: true }) }));
      expect(s.followup.stopForLead).toHaveBeenCalled();
    });

    it('pauses the AI again when a reply from it gets through', async () => {
      const s = setup({ status: 'engaged', dncStatus: false, takenOverById: 'agent-1' }, { ai: true });
      await s.finalize('ai-msg-2');
      expect(s.prisma.message.create).toHaveBeenCalledWith({ data: expect.objectContaining({ senderType: 'ai' }) });
      expect(s.conversations.pauseAi).toHaveBeenCalledWith('org-1', '+12899174129', true);
    });
  });

  it('lets a text the lead asked for know they texted again, and makes sure the AI has its tools in a chat', async () => {
    const s = setup({ status: 'engaged', dncStatus: false }, { ai: true });
    await s.receive('ok I am free now');
    expect(s.textBacks.onLeadTexted).toHaveBeenCalledWith('org-1', 'lead-1');
    expect(s.callTools.ensure).toHaveBeenCalledWith('org-1');
  });
});
