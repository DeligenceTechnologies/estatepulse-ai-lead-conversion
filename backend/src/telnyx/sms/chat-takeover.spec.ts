import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { ChatTakeoverService, DEFAULT_TAKEOVER_GREETING } from './chat-takeover.service';

const auth = { userId: 'agent-1', organizationId: 'org-1', sessionId: 's-1', roleIds: [], permissions: [] };
const PHONE = '+12895550100';

function setup(
  opts: { locked?: object | null; isAgent?: boolean; telnyxDown?: boolean; lead?: object | null; smsDown?: boolean; duplicate?: object | null; greeting?: object | null } = {},
) {
  const locked =
    opts.locked === undefined ? { phone: PHONE, dnc_status: false, taken_over_by_id: null, taken_over_at: null, assigned_to_id: 'agent-1' } : opts.locked;
  const lead =
    opts.lead === undefined
      ? { phone: PHONE, dncStatus: false, takenOverById: 'agent-1', assignedTo: { firstName: 'Priya', lastName: 'Shah', email: 'priya@x.test' } }
      : opts.lead;
  const prisma: any = {
    $queryRaw: vi.fn(async () => (locked ? [locked] : [])),
    user: { findFirst: vi.fn(async () => (opts.isAgent === false ? null : { firstName: 'Priya', lastName: 'Shah', email: 'priya@x.test' })) },
    organizationSetting: {
      findUnique: vi.fn(async () => ({ chatTakeover: opts.greeting ?? null })),
      upsert: vi.fn(async () => ({})),
    },
    lead: { update: vi.fn(async () => ({})), findFirst: vi.fn(async () => lead) },
    message: {
      create: vi.fn(async ({ data }: any) => {
        if (opts.duplicate !== undefined) throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });
        return { ...data, createdAt: new Date(), sentAt: null, deliveredAt: null, failedAt: null, providerMessageId: null };
      }),
      update: vi.fn(async ({ where, data }: any) => ({ id: where.id, direction: 'outbound', senderType: 'user', channel: 'sms', body: 'x', createdAt: new Date(), sentAt: null, deliveredAt: null, failedAt: null, ...data })),
      findFirst: vi.fn(async () => opts.duplicate ?? null),
    },
  };
  prisma.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma));
  const state = { record: vi.fn(async () => undefined) };
  const audit = { record: vi.fn(async () => undefined) };
  const followup = { stopForLead: vi.fn(async () => 0) };
  const engine = { stopStrategy: vi.fn() };
  const sms = { sendSms: vi.fn(async () => (opts.smsDown ? Promise.reject(new Error('carrier said no')) : { id: 'tx-msg-1' })) };
  const conversations = {
    pauseAi: vi.fn(async () => (opts.telnyxDown ? Promise.reject(new Error('Telnyx 503')) : true)),
    appendToChat: vi.fn(async () => undefined),
  };
  const bus = { publish: vi.fn() };
  const activity = { leadVariables: vi.fn(async () => ({ firstName: 'Tara', brokerage: 'DeligenceDT' })) };
  const svc = new ChatTakeoverService(prisma, state as any, audit as any, followup as any, engine as any, sms as any, conversations as any, bus as any, activity as any);
  const events = () => state.record.mock.calls.map((c: any[]) => c[0].type);
  return { svc, prisma, state, audit, followup, engine, sms, conversations, bus, events };
}

describe('ChatTakeoverService.takeOver', () => {
  it('stops everything for the lead in one transaction, then the AI for this chat only', async () => {
    const s = setup();
    const r = await s.svc.takeOver(auth, 'lead-1');
    expect(r).toMatchObject({ leadId: 'lead-1', takenOverById: 'agent-1' });
    expect(s.prisma.lead.update).toHaveBeenCalledWith({
      where: { id: 'lead-1' },
      data: expect.objectContaining({ takenOverById: 'agent-1', automationPaused: true, callbackAt: null, textBackAt: null }),
    });
    expect(s.followup.stopForLead).toHaveBeenCalledWith('org-1', 'lead-1', 'agent_takeover', s.prisma);
    expect(s.events()).toEqual(['chat_taken_over']);
    expect(s.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'lead.chat_taken_over', actorId: 'agent-1' }), s.prisma);
    expect(s.conversations.pauseAi).toHaveBeenCalledWith('org-1', PHONE, true);
    expect(s.engine.stopStrategy).toHaveBeenCalledWith('org-1', 'lead-1', 'agent', expect.any(String));
    expect(s.bus.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'conversation.updated', leadId: 'lead-1' }));
  });

  it('looks only at a lead in the agent\'s organization that is assigned to them', async () => {
    const s = setup({ locked: null });
    await expect(s.svc.takeOver(auth, 'lead-9')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const sql = s.prisma.$queryRaw.mock.calls[0];
    expect(sql[0].join('?')).toContain('assigned_to_id = ?');
    expect(sql.slice(1)).toEqual(['lead-9', 'org-1', 'agent-1']);
    expect(s.conversations.pauseAi).not.toHaveBeenCalled();
  });

  it('refuses someone who no longer holds an active Agent role', async () => {
    const s = setup({ isAgent: false });
    await expect(s.svc.takeOver(auth, 'lead-1')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(s.prisma.lead.update).not.toHaveBeenCalled();
  });

  it('texts the lead the greeting from the agent, after the takeover is in', async () => {
    const s = setup();
    await s.svc.takeOver(auth, 'lead-1');
    const greeting = "Hi Tara, this is Priya from DeligenceDT. I'm taking over from our assistant and will reply to you personally from here.";
    expect(s.sms.sendSms).toHaveBeenCalledWith('org-1', PHONE, greeting);
    expect(s.prisma.message.create).toHaveBeenCalledWith({ data: expect.objectContaining({ senderType: 'user', senderUserId: 'agent-1', body: greeting }) });
    expect(s.conversations.appendToChat).toHaveBeenCalledWith('org-1', PHONE, 'assistant', `[Agent Priya Shah] ${greeting}`, expect.any(Date));
  });

  it('no greeting when the organization turned it off, or to a lead who opted out', async () => {
    const off = setup({ greeting: { enabled: false } });
    await off.svc.takeOver(auth, 'lead-1');
    expect(off.sms.sendSms).not.toHaveBeenCalled();
    const dnc = setup({ locked: { phone: PHONE, dnc_status: true, taken_over_by_id: null, taken_over_at: null } });
    await dnc.svc.takeOver(auth, 'lead-1');
    expect(dnc.sms.sendSms).not.toHaveBeenCalled();
    expect(dnc.conversations.pauseAi).toHaveBeenCalled();
  });

  it('a greeting the carrier refused is kept as failed; the takeover stands', async () => {
    const s = setup({ smsDown: true, greeting: { enabled: true, message: 'Hi {{firstName}}, {{agentName}} here.' } });
    await expect(s.svc.takeOver(auth, 'lead-1')).resolves.toMatchObject({ takenOverById: 'agent-1' });
    expect(s.sms.sendSms).toHaveBeenCalledWith('org-1', PHONE, 'Hi Tara, Priya Shah here.');
    expect(s.prisma.message.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ deliveryStatus: 'failed' }) }));
  });

  it('a second click changes nothing', async () => {
    const at = new Date('2026-10-30T06:00:00Z');
    const s = setup({ locked: { phone: PHONE, taken_over_by_id: 'agent-1', taken_over_at: at } });
    const r = await s.svc.takeOver(auth, 'lead-1');
    expect(r.takenOverAt).toBe(at.toISOString());
    expect(s.prisma.lead.update).not.toHaveBeenCalled();
    expect(s.conversations.pauseAi).not.toHaveBeenCalled();
    expect(s.bus.publish).not.toHaveBeenCalled();
    expect(s.sms.sendSms).not.toHaveBeenCalled();
  });

  it('when Telnyx will not pause the AI, the transaction fails and nothing is taken over', async () => {
    const s = setup({ telnyxDown: true });
    await expect(s.svc.takeOver(auth, 'lead-1')).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
    expect(s.engine.stopStrategy).not.toHaveBeenCalled();
    expect(s.bus.publish).not.toHaveBeenCalled();
  });
});

describe('ChatTakeoverService.handBack', () => {
  it('lets the AI answer again; automation stays paused', async () => {
    const s = setup({ locked: { phone: PHONE, taken_over_by_id: 'agent-1', taken_over_at: new Date() } });
    await s.svc.handBack(auth, 'lead-1');
    expect(s.prisma.lead.update).toHaveBeenCalledWith({ where: { id: 'lead-1' }, data: { takenOverById: null, takenOverAt: null } });
    expect(s.events()).toEqual(['chat_handed_back']);
    expect(s.conversations.pauseAi).toHaveBeenCalledWith('org-1', PHONE, false);
  });

  it('handing back a chat nobody holds changes nothing', async () => {
    const s = setup();
    await s.svc.handBack(auth, 'lead-1');
    expect(s.prisma.lead.update).not.toHaveBeenCalled();
    expect(s.conversations.pauseAi).not.toHaveBeenCalled();
  });
});

describe('ChatTakeoverService.send', () => {
  const input = { id: '0193f0aa-0000-7000-8000-000000000001', body: '  Friday at 5 works, see you then  ' };

  it('texts the lead once, stores it as the agent\'s, and gives the AI a marked copy', async () => {
    const s = setup();
    const row = await s.svc.send(auth, 'lead-1', input);
    expect(s.prisma.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ id: input.id, senderType: 'user', senderUserId: 'agent-1', body: 'Friday at 5 works, see you then', deliveryStatus: 'pending' }),
    });
    expect(s.sms.sendSms).toHaveBeenCalledWith('org-1', PHONE, 'Friday at 5 works, see you then');
    expect(s.prisma.message.update).toHaveBeenCalledWith({ where: { id: input.id }, data: expect.objectContaining({ providerMessageId: 'tx-msg-1', deliveryStatus: 'sent' }) });
    expect(s.conversations.appendToChat).toHaveBeenCalledWith('org-1', PHONE, 'assistant', '[Agent Priya Shah] Friday at 5 works, see you then', expect.any(Date));
    expect(row.deliveryStatus).toBe('sent');
  });

  it('a retried send returns the first one and texts nobody', async () => {
    const first = { id: input.id, direction: 'outbound', senderType: 'user', channel: 'sms', body: 'x', deliveryStatus: 'sent', createdAt: new Date(), sentAt: null, deliveredAt: null, failedAt: null };
    const s = setup({ duplicate: first });
    const row = await s.svc.send(auth, 'lead-1', input);
    expect(row.id).toBe(input.id);
    expect(s.sms.sendSms).not.toHaveBeenCalled();
    expect(s.prisma.message.findFirst).toHaveBeenCalledWith({ where: { id: input.id, orgId: 'org-1', leadId: 'lead-1', senderUserId: 'agent-1' } });
  });

  it('an id that belongs to someone else\'s message is refused', async () => {
    const s = setup({ duplicate: null });
    await expect(s.svc.send(auth, 'lead-1', input)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(s.sms.sendSms).not.toHaveBeenCalled();
  });

  it('only while this agent holds the chat, and never to an opted-out lead', async () => {
    await expect(setup({ lead: null }).svc.send(auth, 'lead-1', input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(setup({ lead: { phone: PHONE, dncStatus: false, takenOverById: null } }).svc.send(auth, 'lead-1', input)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(setup({ lead: { phone: PHONE, dncStatus: true, takenOverById: 'agent-1' } }).svc.send(auth, 'lead-1', input)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('a text the carrier refused is kept as failed, and the AI is not told about it', async () => {
    const s = setup({ smsDown: true });
    const row = await s.svc.send(auth, 'lead-1', input);
    expect(row.deliveryStatus).toBe('failed');
    expect(s.conversations.appendToChat).not.toHaveBeenCalled();
  });
});

describe('ChatTakeoverService.releaseIfReassigned', () => {
  it('ends the previous agent\'s takeover and lets the AI answer', async () => {
    const s = setup({ locked: { phone: PHONE, taken_over_by_id: 'agent-1', taken_over_at: new Date(), assigned_to_id: 'agent-2' } });
    await s.svc.releaseIfReassigned('org-1', 'lead-1');
    expect(s.prisma.lead.update).toHaveBeenCalledWith({ where: { id: 'lead-1' }, data: { takenOverById: null, takenOverAt: null } });
    expect(s.state.record).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat_handed_back', actor: { type: 'system' } }), s.prisma);
    expect(s.conversations.pauseAi).toHaveBeenCalledWith('org-1', PHONE, false);
  });

  it('leaves a takeover the new assignee holds, and never throws', async () => {
    const s = setup({ locked: { phone: PHONE, taken_over_by_id: 'agent-2', taken_over_at: new Date(), assigned_to_id: 'agent-2' } });
    await s.svc.releaseIfReassigned('org-1', 'lead-1');
    expect(s.prisma.lead.update).not.toHaveBeenCalled();
    s.prisma.$transaction.mockRejectedValueOnce(new Error('db down'));
    await expect(s.svc.releaseIfReassigned('org-1', 'lead-1')).resolves.toBeUndefined();
  });
});

describe('ChatTakeoverService greeting settings', () => {
  it('on with the default text until the organization changes it; an empty text restores the default, which is never stored', async () => {
    const s = setup();
    expect(await s.svc.greeting('org-1')).toMatchObject({ enabled: true, message: DEFAULT_TAKEOVER_GREETING });
    await s.svc.updateGreeting('org-1', { message: '  ' });
    expect(s.prisma.organizationSetting.upsert).toHaveBeenLastCalledWith(expect.objectContaining({ update: { chatTakeover: { enabled: true } } }));
    await s.svc.updateGreeting('org-1', { enabled: false, message: 'Hola {{firstName}}, soy {{agentFirstName}}.' });
    expect(s.prisma.organizationSetting.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({ update: { chatTakeover: { enabled: false, message: 'Hola {{firstName}}, soy {{agentFirstName}}.' } } }),
    );
  });
});
