import { describe, expect, it, vi } from 'vitest';
import { LeadStateService } from '@/lead/lead-state.service';
import { INTENT_UNCHECKED_REVIEW, InboundSmsService } from './inbound-sms.service';
import { PERSON_REPLY_REVIEW } from '@/sms-agent/sms-agent';
import { OptOutService } from './opt-out.service';

const PHONE = '+12899174129';
const OUR_NUMBER = '+17427245092';

type TestLead = { id: string; orgId: string; status: string; dncStatus: boolean; normalizedPhone: string; firstResponseAt: Date | null; takenOverById: string | null; reviewReasons: string[] };

function setup(
  start: { status: string; dncStatus: boolean; takenOverById?: string | null },
  opts: {
    ai?: boolean;
    engine?: 'telnyx' | 'estatepulse';
    intent?: string;
    classify?: () => Promise<unknown>;
    siblings?: Partial<TestLead>[];
    stranger?: boolean;
    details?: Record<string, string>;
    queueDown?: boolean;
  } = {},
) {
  const lead: TestLead = { id: 'lead-1', orgId: 'org-1', normalizedPhone: PHONE, firstResponseAt: null, takenOverById: null, reviewReasons: [], ...start };
  const leads: TestLead[] = [lead, ...(opts.siblings ?? []).map((l, i) => ({ ...lead, id: `lead-${i + 2}`, ...l }))];
  const byId = (id: string) => leads.find((l) => l.id === id);
  const suppressed = new Set<string>();
  const prisma = {
    message: {
      findFirst: vi.fn(async () => null as unknown),
      findMany: vi.fn(async () => [{ direction: 'inbound', body: 'latest' }]),
      create: vi.fn(async (_args?: any) => ({ id: 'in-1' })),
      update: vi.fn(async () => ({})),
    },
    lead: {
      findFirst: vi.fn(async () => (opts.stranger ? null : { ...lead })),
      findUnique: vi.fn(async ({ where }: any) => {
        const found = byId(where.id);
        return found ? { ...found } : null;
      }),
      findMany: vi.fn(async ({ where }: any) =>
        leads.filter((l) => (where.dncStatus === undefined || l.dncStatus === where.dncStatus) && (opts.stranger ? false : true)).map((l) => ({ id: l.id })),
      ),
      update: vi.fn(async ({ where, data }: any) => {
        const found = byId(where.id);
        if (found && typeof data?.dncStatus === 'boolean') found.dncStatus = data.dncStatus;
        return {};
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const found = byId(where.id);
        if (found && data?.status) found.status = data.status;
        return { count: found ? 1 : 0 };
      }),
      count: vi.fn(async ({ where }: any) => leads.filter((l) => !where.takenOverById || l.takenOverById).length),
    },
    leadEvent: { create: vi.fn(async () => ({})) },
    contactSuppression: {
      findMany: vi.fn(async ({ where }: any) => (where.normalizedPhone.in as string[]).filter((p) => suppressed.has(p)).map((normalizedPhone) => ({ normalizedPhone }))),
      upsert: vi.fn(async ({ create }: any) => suppressed.add(create.normalizedPhone)),
      deleteMany: vi.fn(async ({ where }: any) => suppressed.delete(where.normalizedPhone)),
    },
    organization: { findUnique: vi.fn(async () => ({ name: 'Skyline Realty' })) },
    organizationSetting: { findUnique: vi.fn(async () => ({ businessDetails: opts.details ?? null })) },
    $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(prisma)),
  };
  const creds = { orgForNumber: vi.fn(async () => 'org-1') };
  const followup = { pauseForLead: vi.fn(), stopForLead: vi.fn() };
  const engineMock = { setStatus: vi.fn(async () => true) };
  const engine = opts.engine ?? 'telnyx';
  const conversations = {
    isEnabled: vi.fn(async () => Boolean(opts.ai)),
    replyEngine: vi.fn(async () => engine),
    repliesHere: vi.fn(async () => Boolean(opts.ai) && engine === 'estatepulse'),
    appendToChat: vi.fn(async () => undefined),
    pauseAi: vi.fn(async () => true),
  };
  const intents = { classify: vi.fn(opts.classify ?? (async () => ({ intent: opts.intent ?? 'continue', reason: 'test' }))) };
  const textBacks = { onLeadTexted: vi.fn(async () => undefined) };
  const callTools = { ensure: vi.fn(async () => undefined) };
  const bus = { publish: vi.fn() };
  const memory = { onLeadText: vi.fn() };
  const sms = { sendSms: vi.fn(async (_org: string, _to: string, text: string) => ({ id: 'sent-1', text })) };
  const replies = { add: vi.fn(async () => (opts.queueDown ? Promise.reject(new Error('Redis down')) : {})) };
  const state = new LeadStateService(prisma as any);
  const service = new InboundSmsService(
    prisma as any,
    creds as any,
    followup as any,
    state,
    engineMock as any,
    conversations as any,
    intents as any,
    textBacks as any,
    callTools as any,
    bus as any,
    memory as any,
    new OptOutService(prisma as any, state, followup as any),
    sms as any,
    replies as any,
  );
  const receive = (text: string, extra: Record<string, unknown> = {}) =>
    service.onMessageReceived({ id: 'm-1', text, from: { phone_number: PHONE }, to: [{ phone_number: OUR_NUMBER }], ...extra });
  const events = () => prisma.leadEvent.create.mock.calls.map((c: any[]) => c[0].data.type);
  const optedIn = () => prisma.lead.update.mock.calls.some((c: any[]) => c[0]?.data?.consentStatus === 'granted');
  const optedOut = () => leads.filter((l) => l.dncStatus).map((l) => l.id);
  /** The texts we sent that the rules require (a confirmation, a HELP answer). */
  const notices = () => sms.sendSms.mock.calls.map((c: any[]) => c[2] as string);
  const finalize = (id: string, status = 'delivered', text = 'Great, when are you hoping to move?') =>
    service.onMessageFinalized('org-1', { id, text, from: { phone_number: OUR_NUMBER }, to: [{ phone_number: PHONE, status }] });
  const flaggedForPerson = () =>
    prisma.lead.update.mock.calls.some((c: any[]) => c[0]?.data?.needsReview === true && (c[0]?.data?.reviewReasons?.push === PERSON_REPLY_REVIEW || lead.reviewReasons.includes(PERSON_REPLY_REVIEW)));
  return { receive, finalize, service, prisma, followup, engine: engineMock, intents, lead, leads, events, optedIn, optedOut, notices, suppressed, sms, textBacks, callTools, conversations, bus, memory, replies, flaggedForPerson };
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
    expect(s.prisma.message.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ direction: 'inbound', sentAt: new Date(receivedAt), createdAt: new Date(receivedAt) }) }));
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
      // The agent answers, and the lead memory still learns what the lead said.
      expect(s.memory.onLeadText).toHaveBeenCalledWith('org-1', 'lead-1');
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

  it("remembers what the lead texts, whoever answers it", async () => {
    for (const ai of [true, false]) {
      const s = setup({ status: 'contacting', dncStatus: false }, { ai });
      await s.receive('A flat in Noida please');
      expect(s.memory.onLeadText).toHaveBeenCalledWith('org-1', 'lead-1');
    }
  });

  it('does not read a STOP or a START into the lead memory', async () => {
    const stop = setup({ status: 'contacting', dncStatus: false });
    await stop.receive('STOP');
    const start = setup({ status: 'not_interested', dncStatus: true });
    await start.receive('START');
    expect(stop.memory.onLeadText).not.toHaveBeenCalled();
    expect(start.memory.onLeadText).not.toHaveBeenCalled();
  });

  describe('opt-outs in other words (SMS02)', () => {
    it('honours "Stop please" with the AI off: DNC at once, and our one confirmation', async () => {
      const s = setup({ status: 'contacting', dncStatus: false });
      await s.receive('Stop please');
      expect(s.optedOut()).toEqual(['lead-1']);
      expect(s.lead.status).toBe('not_interested');
      expect(s.intents.classify).not.toHaveBeenCalled();
      expect(s.notices()).toEqual(["You're unsubscribed from Skyline Realty and won't get more messages from us. Reply START to resubscribe."]);
      expect(s.sms.sendSms).toHaveBeenCalledWith('org-1', PHONE, expect.any(String), { evenIfOptedOut: true });
    });

    it.each(['STOP ALL', 'Opt out', 'opt-out.', 'stop texting me', 'Please remove me from your list', 'UNSUBSCRIBE!'])('honours "%s"', async (text) => {
      const s = setup({ status: 'follow_up', dncStatus: false });
      await s.receive(text);
      expect(s.optedOut()).toEqual(['lead-1']);
      expect(s.followup.stopForLead).toHaveBeenCalledWith('org-1', 'lead-1', 'opted_out', s.prisma);
    });

    it('sends no confirmation of its own for a word Telnyx answered itself', async () => {
      for (const text of ['STOP ALL', 'cancel', 'Quit']) {
        const s = setup({ status: 'contacting', dncStatus: false });
        await s.receive(text);
        expect(s.optedOut()).toEqual(['lead-1']);
        expect(s.notices()).toEqual([]);
      }
    });

    it("trusts Telnyx's own verdict on a text it blocked", async () => {
      const s = setup({ status: 'contacting', dncStatus: false });
      await s.receive('please no more', { autoresponse_type: 'STOP' });
      expect(s.optedOut()).toEqual(['lead-1']);
      expect(s.notices()).toEqual([]);
    });

    it('answers ARRÊT in French', async () => {
      const s = setup({ status: 'contacting', dncStatus: false });
      await s.receive('ARRÊT');
      expect(s.optedOut()).toEqual(['lead-1']);
      expect(s.notices()[0]).toContain('Vous êtes désabonné(e) des messages de Skyline Realty');
    });

    it('lets the AI confirm in a chat it holds, and stops it answering the number', async () => {
      const s = setup({ status: 'engaged', dncStatus: false }, { ai: true });
      await s.receive('stop please');
      expect(s.optedOut()).toEqual(['lead-1']);
      expect(s.notices()).toEqual([]);
      expect(s.conversations.pauseAi).toHaveBeenCalledWith('org-1', PHONE, true);
    });

    it('confirms itself in a chat an agent holds, since the AI is paused there', async () => {
      const s = setup({ status: 'engaged', dncStatus: false, takenOverById: 'agent-1' }, { ai: true });
      await s.receive('stop please');
      expect(s.notices()).toHaveLength(1);
    });

    it("confirms itself when an agent holds an older lead's chat with the number: the AI is paused for the number", async () => {
      const s = setup({ status: 'contacting', dncStatus: false }, { ai: true, siblings: [{ status: 'appointment_booked', takenOverById: 'agent-1' }] });
      await s.receive('stop please');
      expect(s.optedOut()).toEqual(['lead-1', 'lead-2']);
      expect(s.notices()).toHaveLength(1);
    });

    it('reads a question about stopping by as an ordinary reply', async () => {
      const s = setup({ status: 'contacting', dncStatus: false });
      await s.receive('Can I stop by the open house?');
      expect(s.optedOut()).toEqual([]);
      expect(s.followup.pauseForLead).toHaveBeenCalled();
    });

    it('lets START from an opted-out lead turn the AI back on for the number', async () => {
      const s = setup({ status: 'not_interested', dncStatus: true }, { ai: true });
      s.suppressed.add(PHONE);
      await s.receive('START');
      expect(s.optedIn()).toBe(true);
      expect(s.suppressed.has(PHONE)).toBe(false);
      expect(s.conversations.pauseAi).toHaveBeenCalledWith('org-1', PHONE, false);
    });
  });

  describe('HELP (SMS02)', () => {
    it('answers HELP with who we are, a way to reach a person and how to stop, then treats it as a reply', async () => {
      const s = setup({ status: 'contacting', dncStatus: false });
      await s.receive('HELP');
      expect(s.notices()).toEqual([
        `Skyline Realty: texts about your home search. Msg frequency varies; msg & data rates may apply. For help, call or text (742) 724-5092. Reply STOP to opt out.`,
      ]);
      expect(s.prisma.message.create).toHaveBeenCalledWith({ data: expect.objectContaining({ direction: 'outbound', body: expect.stringContaining('Reply STOP') }) });
      expect(s.optedOut()).toEqual([]);
      expect(s.followup.pauseForLead).toHaveBeenCalled();
    });

    it('adds the mailing address and website the organization gave, and its legal name', async () => {
      const s = setup(
        { status: 'contacting', dncStatus: false },
        { details: { legalName: 'Skyline Realty Group Inc.', mailingAddress: '100 King St W, Toronto ON M5X 1A9', website: 'skylinerealty.ca' } },
      );
      await s.receive('help');
      expect(s.notices()[0]).toBe(
        'Skyline Realty (Skyline Realty Group Inc.): texts about your home search. Msg frequency varies; msg & data rates may apply. ' +
          'For help, call or text (742) 724-5092 or skylinerealty.ca. Mail: 100 King St W, Toronto ON M5X 1A9. Reply STOP to opt out.',
      );
    });

    it('answers AIDE in French', async () => {
      const s = setup({ status: 'contacting', dncStatus: false });
      await s.receive('aide');
      expect(s.notices()[0]).toContain('Répondez ARRET pour vous désabonner');
    });
  });

  describe('one phone, several leads (SMS04)', () => {
    it('opts out every lead with the number, each logged, and suppresses the number', async () => {
      const s = setup({ status: 'follow_up', dncStatus: false }, { siblings: [{ status: 'contacting' }, { status: 'appointment_booked' }] });
      await s.receive('STOP');
      expect(s.optedOut()).toEqual(['lead-1', 'lead-2', 'lead-3']);
      expect(s.suppressed.has(PHONE)).toBe(true);
      expect(s.leads.map((l) => l.status)).toEqual(['not_interested', 'not_interested', 'appointment_booked']);
      for (const id of ['lead-1', 'lead-2', 'lead-3']) expect(s.followup.stopForLead).toHaveBeenCalledWith('org-1', id, 'opted_out', s.prisma);
      expect(s.events().filter((t: string) => t === 'opted_out')).toHaveLength(3);
    });

    it('lets START back in every lead with the number', async () => {
      const s = setup({ status: 'not_interested', dncStatus: true }, { siblings: [{ status: 'not_interested', dncStatus: true }] });
      s.suppressed.add(PHONE);
      await s.receive('start');
      expect(s.optedOut()).toEqual([]);
      expect(s.leads.map((l) => l.status)).toEqual(['follow_up', 'follow_up']);
    });

    it('treats START as an opt-in when only the number opted out, on another lead', async () => {
      const s = setup({ status: 'contacting', dncStatus: false });
      s.suppressed.add(PHONE);
      await s.receive('START');
      expect(s.suppressed.has(PHONE)).toBe(false);
      expect(s.followup.pauseForLead).not.toHaveBeenCalled();
    });
  });

  describe('a number no lead has', () => {
    it('still records an opt-out, so a lead created with the number later starts do-not-contact', async () => {
      const s = setup({ status: 'new', dncStatus: false }, { stranger: true });
      await s.receive('STOP');
      expect(s.suppressed.has(PHONE)).toBe(true);
      expect(s.prisma.message.create).not.toHaveBeenCalled();
      expect(s.notices()).toEqual([]);
    });

    it('confirms an opt-out in other words, and answers HELP', async () => {
      const stop = setup({ status: 'new', dncStatus: false }, { stranger: true });
      await stop.receive('please stop texting me');
      expect(stop.suppressed.has(PHONE)).toBe(true);
      expect(stop.notices()).toHaveLength(1);
      const help = setup({ status: 'new', dncStatus: false }, { stranger: true });
      await help.receive('HELP');
      expect(help.notices()[0]).toContain('Reply STOP to opt out');
    });
  });

  describe('the intent check (SMS03)', () => {
    const failing = () => async () => {
      throw new Error('Telnyx unreachable');
    };

    it('runs with the AI off too, and acts on an opt-out it finds', async () => {
      const s = setup({ status: 'contacting', dncStatus: false }, { intent: 'opt_out' });
      await s.receive("I'd rather you didn't message me anymore");
      expect(s.intents.classify).toHaveBeenCalledOnce();
      expect(s.optedOut()).toEqual(['lead-1']);
      expect(s.notices()).toHaveLength(1);
    });

    it('leaves a "no thanks" to the person reading it when the AI is off', async () => {
      const s = setup({ status: 'contacting', dncStatus: false }, { intent: 'not_interested' });
      await s.receive('No thanks');
      expect(s.engine.setStatus).not.toHaveBeenCalled();
      expect(s.optedOut()).toEqual([]);
    });

    it('never fails open: two failed checks pause automation and flag the lead for a person', async () => {
      const s = setup({ status: 'engaged', dncStatus: false }, { ai: true, classify: failing() });
      await s.receive('ugh enough already');
      expect(s.intents.classify).toHaveBeenCalledTimes(2);
      expect(s.prisma.lead.update).toHaveBeenCalledWith({
        where: { id: 'lead-1' },
        data: { automationPaused: true, needsReview: true, reviewReasons: { push: INTENT_UNCHECKED_REVIEW } },
      });
      expect(s.followup.pauseForLead).toHaveBeenCalledWith('org-1', 'lead-1');
      expect(s.events()).toContain('sms_intent_failed');
    });

    it('flags the lead once, however many texts fail the check', async () => {
      const s = setup({ status: 'engaged', dncStatus: false }, { ai: true, classify: failing() });
      s.lead.reviewReasons = [INTENT_UNCHECKED_REVIEW];
      await s.receive('ugh');
      expect(s.prisma.lead.update).toHaveBeenCalledWith({ where: { id: 'lead-1' }, data: { automationPaused: true, needsReview: true } });
    });

    it('flags the lead with the AI off as well', async () => {
      const s = setup({ status: 'contacting', dncStatus: false }, { classify: failing() });
      await s.receive('hmm');
      expect(s.events()).toContain('sms_intent_failed');
    });

    it('gets over one failed try', async () => {
      let calls = 0;
      const s = setup(
        { status: 'engaged', dncStatus: false },
        {
          ai: true,
          classify: async () => {
            calls += 1;
            if (calls === 1) throw new Error('Telnyx POST /ai/chat/completions failed 503');
            return { intent: 'continue', reason: 'a question' };
          },
        },
      );
      await s.receive('What areas do you cover?');
      expect(s.intents.classify).toHaveBeenCalledTimes(2);
      expect(s.events()).not.toContain('sms_intent_failed');
      expect(s.followup.pauseForLead).not.toHaveBeenCalled();
    });
  });

  describe('when this server writes the AI replies (SMS05)', () => {
    const D = { ai: true, engine: 'estatepulse' as const };

    it("queues the AI's reply to an active lead's text, a moment later, once per text", async () => {
      const s = setup({ status: 'contacting', dncStatus: false }, D);
      await s.receive('What areas do you cover?', { received_at: '2026-11-04T10:00:00.000Z' });
      expect(s.replies.add).toHaveBeenCalledWith(
        'reply',
        { orgId: 'org-1', leadId: 'lead-1', inboundId: 'in-1', receivedAt: '2026-11-04T10:00:00.000Z' },
        { jobId: 'reply-in-1', delay: 2000 },
      );
      expect(s.flaggedForPerson()).toBe(false);
    });

    it.each(['interested', 'appointment_requested', 'follow_up', 'unresponsive', 'new', 'engaged'])('lets the AI answer a lead that is %s', async (status) => {
      const s = setup({ status, dncStatus: false }, D);
      await s.receive('Is Saturday ok?');
      expect(s.replies.add).toHaveBeenCalledOnce();
    });

    it.each(['appointment_booked', 'closed', 'not_interested', 'invalid'])('leaves a lead that is %s to a person, flagged once', async (status) => {
      const s = setup({ status, dncStatus: false }, D);
      await s.receive('Can we move the meeting to Friday?');
      expect(s.replies.add).not.toHaveBeenCalled();
      expect(s.prisma.lead.update).toHaveBeenCalledWith({ where: { id: 'lead-1' }, data: { needsReview: true, reviewReasons: { push: PERSON_REPLY_REVIEW } } });
      expect(s.events()).toContain('needs_person');
    });

    it('does not flag twice for the same reason', async () => {
      const s = setup({ status: 'appointment_booked', dncStatus: false }, D);
      s.lead.reviewReasons = [PERSON_REPLY_REVIEW];
      await s.receive('hello?');
      expect(s.prisma.lead.update).toHaveBeenCalledWith({ where: { id: 'lead-1' }, data: { needsReview: true } });
    });

    it('leaves an opted-out lead that texts again to a person', async () => {
      const s = setup({ status: 'not_interested', dncStatus: true }, D);
      await s.receive('why did you text me?');
      expect(s.replies.add).not.toHaveBeenCalled();
      expect(s.events()).toContain('needs_person');
    });

    it('leaves a chat an agent holds to the agent', async () => {
      const s = setup({ status: 'engaged', dncStatus: false, takenOverById: 'agent-1' }, D);
      await s.receive('Thanks!');
      expect(s.replies.add).not.toHaveBeenCalled();
      expect(s.conversations.appendToChat).toHaveBeenCalled();
    });

    it('answers HELP with our text only, not a second one from the AI', async () => {
      const s = setup({ status: 'contacting', dncStatus: false }, D);
      await s.receive('HELP');
      expect(s.notices()).toHaveLength(1);
      expect(s.replies.add).not.toHaveBeenCalled();
    });

    it('confirms an opt-out itself, since its AI never answers an opted-out lead', async () => {
      const s = setup({ status: 'engaged', dncStatus: false }, D);
      await s.receive('stop please');
      expect(s.optedOut()).toEqual(['lead-1']);
      expect(s.notices()).toEqual(["You're unsubscribed from Skyline Realty and won't get more messages from us. Reply START to resubscribe."]);
      expect(s.replies.add).not.toHaveBeenCalled();
    });

    it('confirms an opt-out the intent check found, too', async () => {
      const s = setup({ status: 'engaged', dncStatus: false }, { ...D, intent: 'opt_out' });
      await s.receive("I'd rather you didn't message me");
      expect(s.optedOut()).toEqual(['lead-1']);
      expect(s.notices()).toHaveLength(1);
    });

    it('flags the lead for a person when the reply cannot be queued', async () => {
      const s = setup({ status: 'contacting', dncStatus: false }, { ...D, queueDown: true });
      await s.receive('Hi');
      expect(s.events()).toContain('needs_person');
    });

    it('stores no reply Telnyx did not send, since Telnyx writes none', async () => {
      const s = setup({ status: 'engaged', dncStatus: false }, D);
      await s.finalize('someone-else');
      expect(s.prisma.message.create).not.toHaveBeenCalled();
    });

    it('queues nothing on Telnyx replies, as before', async () => {
      const s = setup({ status: 'contacting', dncStatus: false }, { ai: true });
      await s.receive('What areas do you cover?');
      expect(s.replies.add).not.toHaveBeenCalled();
    });
  });
});
