import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_INTERVAL_MS, MIN_INTERVAL_MS, RetellChatSyncService, chatMetadata } from './retell-chat-sync.service';

const ORG = '01a1813b-315d-77f1-8ca8-d30b03faf515';
const LEAD = '01a17814-1da6-79f0-9b9c-dda4ed09c775';
const T0 = 1_790_000_000_000;

function setup(opts: { existing?: string[]; placeholder?: boolean; analysis?: unknown; interval?: number } = {}) {
  const existing = new Set(opts.existing ?? []);
  const created: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];
  const prisma = {
    message: {
      findFirst: vi.fn(async ({ where }: any) => {
        if (where.providerMessageId?.endsWith(':opening')) return opts.placeholder && !existing.has('claimed') ? { id: 'msg-placeholder' } : null;
        return existing.has(where.providerMessageId) ? { id: 'seen' } : null;
      }),
      create: vi.fn(async ({ data }: any) => {
        created.push(data);
        existing.add(data.providerMessageId);
        return data;
      }),
      update: vi.fn(async ({ data }: any) => {
        existing.add('claimed');
        updated.push(data);
        return data;
      }),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    lead: { update: vi.fn(async () => ({})), findFirst: vi.fn(async () => ({ dncStatus: false, status: 'engaged' })) },
    smsChat: { update: vi.fn(async () => ({})), upsert: vi.fn(async ({ create }: any) => ({ id: 'row-1', ...create })), findFirst: vi.fn(async () => null) },
  };
  const creds = { getCreds: vi.fn(async () => ({ apiKey: 'key_api' })) };
  const sms = { endChat: vi.fn(async () => undefined) };
  const inbound = { onProviderText: vi.fn(async (_o: string, _l: string, text: string) => (text.trim().toLowerCase() === 'stop' ? 'opt_out' : 'reply')) };
  const engine = { setStatus: vi.fn(async () => true) };
  const outcomes = { record: vi.fn(async () => ({ ok: true })) };
  const state = { quietly: vi.fn() };
  const config = { get: vi.fn((key: string) => ({ RETELL_ENABLED: true, STRATEGY_ENGINE: false })[key]) };
  const svc = new RetellChatSyncService(prisma as any, creds as any, sms as any, inbound as any, engine as any, outcomes as any, state as any, config as any);
  const row = { id: 'row-1', orgId: ORG, leadId: LEAD, provider: 'retell', providerChatId: 'chat_1', status: 'ongoing', lastMessageAt: null, syncIntervalMs: opts.interval ?? 30_000, analysis: opts.analysis ?? null, agentId: 'sms_agent_1' } as any;
  const apply = (chat: Record<string, unknown>) => svc.onChatEvent(row, { chat_id: 'chat_1', chat_status: 'ongoing', ...chat });
  const rowUpdate = () => (prisma.smsChat.update.mock.calls.at(-1) as any[])[0].data;
  return { svc, apply, prisma, created, updated, inbound, sms, engine, outcomes, state, rowUpdate };
}

const msg = (role: string, content: string, id: string, at = T0) => ({ role, content, message_id: id, created_timestamp: at });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(T0 + 60_000));
});
afterEach(() => vi.useRealTimers());

describe('RetellChatSyncService.apply', () => {
  it('files each message once, by Retell’s id: the lead’s as inbound, the agent’s as sent (never delivered), with Retell’s times', async () => {
    const s = setup();
    const chat = { message_with_tool_calls: [msg('agent', 'Hi Asha!', 'm1', T0), msg('user', 'Hello', 'm2', T0 + 1000), { role: 'tool_call_invocation', name: 'x', arguments: '{}', tool_call_id: 't' }] };
    await s.apply(chat);
    expect(s.created.map((m) => [m.direction, m.senderType, m.body, m.providerMessageId, m.deliveryStatus])).toEqual([
      ['outbound', 'ai', 'Hi Asha!', 'chat_1:m1', 'sent'],
      ['inbound', 'lead', 'Hello', 'chat_1:m2', 'delivered'],
    ]);
    expect(s.created[1]).toMatchObject({ createdAt: new Date(T0 + 1000), sentAt: new Date(T0 + 1000) });
    expect(s.inbound.onProviderText).toHaveBeenCalledWith(ORG, LEAD, 'Hello');
    await s.apply(chat);
    expect(s.created).toHaveLength(2);
    expect(s.inbound.onProviderText).toHaveBeenCalledTimes(1);
  });

  it('gives our opening text, recorded under a placeholder when the chat was created, Retell’s id instead of filing it twice', async () => {
    const s = setup({ placeholder: true });
    await s.apply({ message_with_tool_calls: [msg('agent', 'Hi Asha!', 'm1'), msg('agent', 'Still there?', 'm2')] });
    expect(s.updated).toEqual([{ providerMessageId: 'chat_1:m1', sentAt: new Date(T0) }]);
    expect(s.created.map((m) => m.providerMessageId)).toEqual(['chat_1:m2']);
  });

  it('a STOP from the lead opts them out and ends the chat on Retell, so its agent answers nothing more', async () => {
    const s = setup();
    await s.apply({ message_with_tool_calls: [msg('agent', 'Hi', 'm1'), msg('user', 'STOP', 'm2')] });
    expect(s.sms.endChat).toHaveBeenCalledWith({ apiKey: 'key_api' }, 'chat_1');
    expect(s.rowUpdate()).toMatchObject({ nextSyncAt: null });
  });

  it('looks again soon after something new, less and less often while the chat is quiet, and not at all once it has ended', async () => {
    const busy = setup({ interval: 60_000 });
    await busy.apply({ message_with_tool_calls: [msg('user', 'Hi', 'm1')] });
    expect(busy.rowUpdate()).toMatchObject({ status: 'ongoing', syncIntervalMs: MIN_INTERVAL_MS, nextSyncAt: new Date(T0 + 60_000 + MIN_INTERVAL_MS) });

    const quiet = setup({ existing: ['chat_1:m1'], interval: 60_000 });
    await quiet.apply({ message_with_tool_calls: [msg('user', 'Hi', 'm1')] });
    expect(quiet.rowUpdate()).toMatchObject({ syncIntervalMs: 120_000 });
    const capped = setup({ interval: MAX_INTERVAL_MS });
    await capped.apply({});
    expect(capped.rowUpdate()).toMatchObject({ syncIntervalMs: MAX_INTERVAL_MS });

    const ended = setup();
    await ended.apply({ chat_status: 'ended', end_timestamp: T0 + 5000 });
    expect(ended.rowUpdate()).toMatchObject({ status: 'ended', endedAt: new Date(T0 + 5000), nextSyncAt: null });
  });

  it('a chat that errored before its agent ever spoke marks our opening text as failed', async () => {
    const s = setup({ placeholder: true });
    await s.apply({ chat_status: 'error' });
    expect(s.prisma.message.updateMany).toHaveBeenCalledWith({ where: { providerMessageId: 'chat_1:opening', direction: 'outbound', deliveryStatus: 'sent' }, data: expect.objectContaining({ deliveryStatus: 'failed' }) });
    const spoke = setup();
    await spoke.apply({ chat_status: 'error', message_with_tool_calls: [msg('agent', 'Hi', 'm1')] });
    expect(spoke.prisma.message.updateMany).not.toHaveBeenCalled();
  });

  it('acts on the post-chat analysis once, only when the lead took part: do-not-contact, a wrong number or a clear no end the outreach', async () => {
    const dnc = setup();
    await dnc.apply({ chat_status: 'ended', message_with_tool_calls: [msg('user', 'Leave me alone', 'm1')], chat_analysis: { chat_summary: 'Asked us to stop.', custom_analysis_data: { do_not_contact: true } } });
    expect(dnc.outcomes.record).toHaveBeenCalledWith({ orgId: ORG, leadId: LEAD, callId: null, provider: 'retell' }, { outcome: 'do_not_contact', note: 'Found in the text chat analysis' });
    expect(dnc.state.quietly).toHaveBeenCalledWith(expect.objectContaining({ type: 'sms_intent', payload: { intent: 'opt_out', from: 'retell_chat_analysis' } }));
    expect(dnc.rowUpdate()).toMatchObject({ analysis: expect.objectContaining({ chat_summary: 'Asked us to stop.' }) });

    const wrong = setup();
    await wrong.apply({ chat_status: 'ended', message_with_tool_calls: [msg('user', 'Who?', 'm1')], chat_analysis: { custom_analysis_data: { invalid_lead: true } } });
    expect(wrong.engine.setStatus).toHaveBeenCalledWith(ORG, LEAD, 'invalid', expect.stringContaining('Wrong number'), { source: 'sms_reply' });

    const no = setup();
    await no.apply({ chat_status: 'ended', message_with_tool_calls: [msg('user', 'No thanks', 'm1')], chat_analysis: { custom_analysis_data: { not_interested: true } } });
    expect(no.engine.setStatus).toHaveBeenCalledWith(ORG, LEAD, 'not_interested', expect.stringContaining('Not interested'), { source: 'sms_reply' });

    const mixed = setup();
    await mixed.apply({ chat_status: 'ended', message_with_tool_calls: [msg('user', 'Not now, call me Friday', 'm1')], chat_analysis: { custom_analysis_data: { not_interested: true, callback_requested: true } } });
    expect(mixed.engine.setStatus).not.toHaveBeenCalled();

    const silent = setup();
    await silent.apply({ chat_status: 'ended', message_with_tool_calls: [msg('agent', 'Hi', 'm1')], chat_analysis: { custom_analysis_data: { not_interested: true } } });
    expect(silent.engine.setStatus).not.toHaveBeenCalled();

    const already = setup({ analysis: { chat_summary: 'seen' } });
    await already.apply({ chat_status: 'ended', message_with_tool_calls: [msg('user', 'No', 'm1')], chat_analysis: { custom_analysis_data: { not_interested: true } } });
    expect(already.engine.setStatus).not.toHaveBeenCalled();
  });

  it('registers a chat once, under the lead the webhook resolved', async () => {
    const s = setup();
    await s.svc.register({ orgId: ORG, leadId: LEAD, chatId: 'chat_9', direction: 'inbound' });
    expect(s.prisma.smsChat.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { provider_providerChatId: { provider: 'retell', providerChatId: 'chat_9' } }, update: {} }));
  });
});

describe('chatMetadata', () => {
  it('reads only well-formed ids, never trusting anything else in the payload', () => {
    expect(chatMetadata({ metadata: { orgId: ORG, leadId: LEAD, source: 'inbound' } })).toEqual({ orgId: ORG, leadId: LEAD, source: 'inbound' });
    expect(chatMetadata({ metadata: { orgId: 'org-1', leadId: LEAD } })).toBeNull();
    expect(chatMetadata({ metadata: 'x' })).toBeNull();
    expect(chatMetadata({})).toBeNull();
  });
});

describe('RetellChatSyncService polling', () => {
  it('polls only where Retell and the strategy engine are on', () => {
    const on = { get: (key: string) => ({ RETELL_ENABLED: true, STRATEGY_ENGINE: true })[key] };
    const off = { get: (key: string) => ({ RETELL_ENABLED: false, STRATEGY_ENGINE: true })[key] };
    const a = new RetellChatSyncService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, on as any);
    const b = new RetellChatSyncService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, off as any);
    a.onModuleInit();
    b.onModuleInit();
    expect((a as any).timer).toBeDefined();
    expect((b as any).timer).toBeUndefined();
    a.onModuleDestroy();
  });
});
