import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RetellWebhookController, hangupOf } from './retell-webhook.controller';

const ORG = '01a1813b-315d-77f1-8ca8-d30b03faf515';
const LEAD = '01a17814-1da6-79f0-9b9c-dda4ed09c775';
const KEY = 'key_webhook';
const API_KEY = 'key_api';

function request(body: unknown, key = KEY) {
  const raw = JSON.stringify(body);
  const ts = Date.now();
  const signature = `v=${ts},d=${createHmac('sha256', key).update(raw + ts).digest('hex')}`;
  return { header: (name: string) => (name === 'x-retell-signature' ? signature : undefined), rawBody: Buffer.from(raw) } as any;
}

function setup(call: Record<string, unknown> | null = {}, opts: { record?: boolean; chat?: Record<string, unknown> | null; lead?: Record<string, unknown> | null; active?: boolean } = {}) {
  const row = call && { id: 'call-1', orgId: ORG, leadId: LEAD, provider: 'retell', providerCallId: 'call_abc', status: 'ringing', endedAt: null, disposition: null, extractedIntel: null, ...call };
  const chatRow = opts.chat === undefined ? { id: 'chat-row', orgId: ORG, leadId: LEAD, providerChatId: 'chat_1', status: 'ongoing' } : opts.chat;
  const prisma = {
    call: { findFirst: vi.fn().mockResolvedValue(row), update: vi.fn() },
    lead: { findFirst: vi.fn().mockResolvedValue(opts.lead === undefined ? { id: LEAD, dncStatus: false } : opts.lead) },
    organizationSetting: { findUnique: vi.fn().mockResolvedValue({ callRecordingEnabled: opts.record ?? true }) },
  };
  const creds = {
    getCreds: vi.fn().mockResolvedValue({ apiKey: API_KEY, webhookKey: KEY, smsAgentId: 'sms_agent_1', fromNumber: '+12025550100', active: opts.active ?? true }),
    orgForNumber: vi.fn(async (n: string) => (n === '+12025550100' ? ORG : null)),
  };
  const activity = { onCallAnswered: vi.fn(), onCallHangup: vi.fn(), leadVariables: vi.fn().mockResolvedValue({ firstName: 'Asha' }) };
  const scoring = { onProviderAnalysis: vi.fn() };
  const engine = { setStatus: vi.fn().mockResolvedValue(undefined) };
  const callbacks = { onCallEnded: vi.fn().mockResolvedValue(undefined) };
  const chats = {
    byChatId: vi.fn().mockResolvedValue(chatRow),
    register: vi.fn(async (ref: any) => ({ id: 'chat-row', orgId: ref.orgId, leadId: ref.leadId, providerChatId: ref.chatId, status: 'ongoing' })),
    onChatEvent: vi.fn().mockResolvedValue(undefined),
  };
  const state = { quietly: vi.fn() };
  const controller = new RetellWebhookController(prisma as any, creds as any, activity as any, scoring as any, engine as any, callbacks as any, chats as any, state as any);
  const send = (event: string, payload: Record<string, unknown> = {}, key = KEY) => {
    const body = { event, call: { call_id: 'call_abc', ...payload } };
    return controller.receive(body, request(body, key));
  };
  const sendChat = (event: string, chat: Record<string, unknown> = {}, key = KEY) => {
    const body = { event, chat: { chat_id: 'chat_1', agent_id: 'sms_agent_1', chat_status: 'ongoing', ...chat } };
    return controller.receive(body, request(body, key));
  };
  const inbound = (over: Record<string, unknown> = {}, key = KEY) => {
    const body = { event: 'chat_inbound', chat_inbound: { chat_id: 'chat_in', agent_id: 'sms_agent_1', from_number: '+12895550111', to_number: '+12025550100', ...over } };
    return controller.smsInbound(body, request(body, key));
  };
  return { send, sendChat, inbound, prisma, activity, scoring, engine, callbacks, chats, state };
}

const analysis = { call_summary: 'Wants a 3-bed.', custom_analysis_data: { timeline: 'within_30_days', pre_approved: true } };

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

describe('hangupOf', () => {
  it('maps Retell’s reasons onto the dispositions the activity service reads', () => {
    expect(hangupOf('voicemail_reached')).toEqual({ hangup_cause: 'voicemail_reached', machine: true });
    expect(hangupOf('machine_detected')).toEqual({ hangup_cause: 'machine_detected', machine: true });
    expect(hangupOf('ivr_reached')).toEqual({ hangup_cause: 'ivr_reached', machine: true });
    expect(hangupOf('invalid_destination')).toEqual({ hangup_cause: 'not_found' });
    expect(hangupOf('dial_busy')).toEqual({ hangup_cause: 'user_busy' });
    expect(hangupOf('user_declined')).toEqual({ hangup_cause: 'call_rejected' });
    expect(hangupOf('dial_no_answer')).toEqual({ hangup_cause: 'dial_no_answer' });
    expect(hangupOf('user_hangup')).toEqual({ hangup_cause: 'user_hangup' });
  });

  it('a dial Retell or its carrier could not place is a failed call, not the lead not answering', () => {
    for (const reason of ['dial_failed', 'telephony_provider_permission_denied', 'telephony_provider_unavailable', 'sip_routing_error', 'concurrency_limit_reached', 'no_valid_payment', 'error_llm_websocket_open', 'error_unknown']) {
      expect(hangupOf(reason)).toEqual({ hangup_cause: 'unspecified', sip_hangup_cause: '503' });
    }
  });
});

describe('RetellWebhookController calls', () => {
  it('answers 404 for a call we have no record of yet, so Retell retries', async () => {
    const { send, activity } = setup(null);
    await expect(send('call_started')).rejects.toMatchObject({ status: 404 });
    expect(activity.onCallAnswered).not.toHaveBeenCalled();
  });

  it('refuses a delivery not signed with the workspace webhook key', async () => {
    const { send, activity } = setup();
    await expect(send('call_started', {}, 'some_other_key')).rejects.toMatchObject({ status: 401 });
    expect(activity.onCallAnswered).not.toHaveBeenCalled();
  });

  it('looks the call up as a Retell call', async () => {
    const { send, prisma } = setup();
    await send('call_started');
    expect(prisma.call.findFirst).toHaveBeenCalledWith({ where: { providerCallId: 'call_abc', provider: 'retell' }, orderBy: { createdAt: 'desc' } });
  });

  it('call_started marks the call answered, once', async () => {
    const first = setup();
    await first.send('call_started');
    expect(first.activity.onCallAnswered).toHaveBeenCalledWith('call_abc');
    const retried = setup({ status: 'in_progress' });
    await retried.send('call_started');
    const late = setup({ status: 'completed', endedAt: new Date() });
    await late.send('call_started');
    expect(retried.activity.onCallAnswered).not.toHaveBeenCalled();
    expect(late.activity.onCallAnswered).not.toHaveBeenCalled();
  });

  it('call_ended hangs up with Retell’s reason as the cause, once, and lets the callback service see the call', async () => {
    const { send, activity, callbacks } = setup({ status: 'in_progress' });
    await send('call_ended', { disconnection_reason: 'dial_no_answer' });
    expect(activity.onCallHangup).toHaveBeenCalledWith('call_abc', { hangup_cause: 'dial_no_answer' });
    expect(callbacks.onCallEnded).toHaveBeenCalledWith('call_abc');
    const retried = setup({ status: 'completed', endedAt: new Date() });
    await retried.send('call_ended', { disconnection_reason: 'user_hangup' });
    expect(retried.activity.onCallHangup).not.toHaveBeenCalled();
  });

  it('a voicemail Retell detected ends as a machine pick-up, never a conversation', async () => {
    const { send, activity } = setup({ status: 'in_progress' });
    await send('call_ended', { disconnection_reason: 'voicemail_reached' });
    expect(activity.onCallHangup).toHaveBeenCalledWith('call_abc', { hangup_cause: 'voicemail_reached', machine: true });
  });

  it('a lead who asked on the call not to be contacted goes on our DNC', async () => {
    const { send, engine } = setup({ status: 'in_progress' });
    await send('call_ended', { disconnection_reason: 'user_requested_dnc' });
    expect(engine.setStatus).toHaveBeenCalledWith(ORG, LEAD, 'not_interested', expect.any(String), { optOut: true });
  });

  it('call_analyzed keeps the recording and transcript and scores a connected call from the structured analysis', async () => {
    const { send, prisma, scoring } = setup({ status: 'completed', endedAt: new Date() });
    await send('call_analyzed', { recording_url: 'https://rec/1.wav', transcript: 'Agent: hi\nUser: hello', call_analysis: analysis });
    expect(prisma.call.update).toHaveBeenCalledWith({ where: { id: 'call-1' }, data: { recordingUrl: 'https://rec/1.wav', transcript: 'Agent: hi\nUser: hello' } });
    expect(scoring.onProviderAnalysis).toHaveBeenCalledWith('call-1', expect.objectContaining({ timeline: 'within_30_days', pre_approved: true, summary: 'Wants a 3-bed.' }), 'retell_analysis');
  });

  it('with recording off, stores neither recording nor transcript, but still scores', async () => {
    const { send, prisma, scoring } = setup({ status: 'completed', endedAt: new Date() }, { record: false });
    await send('call_analyzed', { recording_url: 'https://rec/1.wav', transcript: 'Agent: hi', call_analysis: analysis });
    expect(prisma.call.update).not.toHaveBeenCalled();
    expect(scoring.onProviderAnalysis).toHaveBeenCalled();
  });

  it('does not score a call that never connected, nor a detected voicemail, nor a call scored already', async () => {
    const never = setup({ status: 'no_answer', endedAt: new Date() });
    await never.send('call_analyzed', { call_analysis: analysis });
    const machine = setup({ status: 'completed', endedAt: new Date(), disposition: 'voicemail' });
    await machine.send('call_analyzed', { call_analysis: analysis });
    const scored = setup({ status: 'completed', endedAt: new Date(), extractedIntel: { qualification: { score: 50 } } });
    await scored.send('call_analyzed', { call_analysis: analysis });
    expect(never.scoring.onProviderAnalysis).not.toHaveBeenCalled();
    expect(machine.scoring.onProviderAnalysis).not.toHaveBeenCalled();
    expect(scored.scoring.onProviderAnalysis).not.toHaveBeenCalled();
  });

  it('Retell’s in_voicemail verdict on a call we took for a conversation counts it as reaching no one', async () => {
    const { send, scoring } = setup({ status: 'completed', endedAt: new Date(), disposition: 'connected' });
    await send('call_analyzed', { call_analysis: { in_voicemail: true, call_summary: 'Voicemail greeting.', custom_analysis_data: { pre_approved: true } } });
    expect(scoring.onProviderAnalysis).toHaveBeenCalledWith('call-1', expect.objectContaining({ reached_person: false, pre_approved: false, summary: 'Voicemail greeting.' }), 'retell_analysis');
  });

  it('analysis without our fields: asks Retell to re-run it once, then marks the call as not scorable rather than scoring a guess', async () => {
    const first = setup({ status: 'completed', endedAt: new Date() });
    await first.send('call_analyzed', { call_analysis: { call_summary: 'Nothing structured.' } });
    expect(first.scoring.onProviderAnalysis).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith('https://api.retellai.com/rerun-call-analysis/call_abc', expect.objectContaining({ method: 'PUT' }));
    expect(first.prisma.call.update).toHaveBeenCalledWith({ where: { id: 'call-1' }, data: { extractedIntel: expect.objectContaining({ analysis: expect.objectContaining({ status: 'unavailable', rerunRequested: true }) }) } });

    fetchMock.mockClear();
    const again = setup({ status: 'completed', endedAt: new Date(), extractedIntel: { analysis: { status: 'unavailable', reason: 'x', at: 'y', rerunRequested: true } } });
    await again.send('call_analyzed', {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(again.prisma.call.update).toHaveBeenCalledWith({ where: { id: 'call-1' }, data: { extractedIntel: expect.objectContaining({ analysis: expect.objectContaining({ status: 'unavailable', reason: 'Retell sent no call analysis' }) }) } });
  });
});

describe('RetellWebhookController inbound SMS', () => {
  it('answers a lead’s text with their details and registers the chat under that lead, found by number inside the organization that owns the number', async () => {
    const { inbound, chats, prisma } = setup();
    const res = await inbound();
    expect(prisma.lead.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { orgId: ORG, normalizedPhone: '+12895550111' } }));
    expect(chats.register).toHaveBeenCalledWith({ orgId: ORG, leadId: LEAD, chatId: 'chat_in', agentId: 'sms_agent_1', direction: 'inbound' });
    expect(res).toEqual({ chat_inbound: { metadata: { orgId: ORG, leadId: LEAD, source: 'inbound' }, dynamic_variables: { firstName: 'Asha', opening_message: '' } } });
  });

  it('refuses a delivery whose signature matches neither of the organization’s keys, and accepts the API key', async () => {
    const bad = setup();
    await expect(bad.inbound({}, 'someone_else')).rejects.toMatchObject({ status: 401 });
    expect(bad.chats.register).not.toHaveBeenCalled();
    const api = setup();
    await expect(api.inbound({}, API_KEY)).resolves.toMatchObject({ chat_inbound: expect.objectContaining({ metadata: expect.anything() }) });
  });

  it('a lead on do-not-contact gets no reply, and the refusal is on the lead’s record', async () => {
    const { inbound, chats, state } = setup({}, { lead: { id: LEAD, dncStatus: true } });
    await expect(inbound()).resolves.toEqual({ chat_inbound: { reject: true } });
    expect(chats.register).not.toHaveBeenCalled();
    expect(state.quietly).toHaveBeenCalledWith(expect.objectContaining({ leadId: LEAD, type: 'sms_rejected' }));
  });

  it('a text to a number no organization texts from, or from a number that is no lead, is left to Retell and not tracked', async () => {
    const unknownNumber = setup();
    await expect(unknownNumber.inbound({ to_number: '+19995550000' })).resolves.toEqual({});
    const unknownLead = setup({}, { lead: null });
    await expect(unknownLead.inbound()).resolves.toEqual({});
    expect(unknownLead.chats.register).not.toHaveBeenCalled();
  });

  it('an organization that no longer calls through Retell gets no Retell chat', async () => {
    const { inbound } = setup({}, { active: false });
    await expect(inbound()).resolves.toEqual({ chat_inbound: { reject: true } });
  });
});

describe('RetellWebhookController chat events', () => {
  it('files a chat event under the registered chat once the signature checks out', async () => {
    const { sendChat, chats } = setup();
    await sendChat('chat_ended', { chat_status: 'ended' });
    expect(chats.onChatEvent).toHaveBeenCalledWith(expect.objectContaining({ providerChatId: 'chat_1' }), expect.objectContaining({ chat_id: 'chat_1', chat_status: 'ended' }));
    const bad = setup();
    await expect(bad.sendChat('chat_ended', {}, 'someone_else')).rejects.toMatchObject({ status: 401 });
    expect(bad.chats.onChatEvent).not.toHaveBeenCalled();
  });

  it('an unregistered chat is accepted only when its metadata names an organization whose SMS agent ran it and whose key signed it', async () => {
    const ours = setup({}, { chat: null });
    await ours.sendChat('chat_started', { metadata: { orgId: ORG, leadId: LEAD, source: 'inbound' } });
    expect(ours.chats.register).toHaveBeenCalledWith({ orgId: ORG, leadId: LEAD, chatId: 'chat_1', agentId: 'sms_agent_1', direction: 'inbound' });
    expect(ours.chats.onChatEvent).toHaveBeenCalled();

    const otherAgent = setup({}, { chat: null });
    await otherAgent.sendChat('chat_started', { agent_id: 'someone_elses_agent', metadata: { orgId: ORG, leadId: LEAD } });
    expect(otherAgent.chats.register).not.toHaveBeenCalled();

    const noMeta = setup({}, { chat: null });
    await noMeta.sendChat('chat_started');
    expect(noMeta.chats.register).not.toHaveBeenCalled();

    const forged = setup({}, { chat: null });
    await expect(forged.sendChat('chat_started', { metadata: { orgId: ORG, leadId: LEAD } }, 'someone_else')).rejects.toMatchObject({ status: 401 });
  });
});
