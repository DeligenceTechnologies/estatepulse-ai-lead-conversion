import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SMS_PROMPT, OPENING_VARIABLE, REGISTRATION_NOTE, RetellSmsService } from './retell-sms.service';

const ORG = 'org-1';
const LEAD = 'lead-1';
const BASE = { id: 'row-1', apiKey: 'key_api', webhookKey: 'key_hook', agentId: 'agent_1', llmId: 'llm_1', smsAgentId: 'sms_agent_1', smsLlmId: 'sms_llm_1', fromNumber: '+12025550100', active: true };

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const sent = (i = 0) => {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit];
  return { url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined };
};

/** A Retell-Twilio US number with the SMS agent bound both ways, unless `over` says otherwise. */
const number = (over: Record<string, unknown> = {}) => ({
  phone_number: '+12025550100',
  phone_number_type: 'retell-twilio',
  inbound_sms_agents: [{ agent_id: 'sms_agent_1', weight: 1 }],
  outbound_sms_agents: [{ agent_id: 'sms_agent_1', weight: 1 }],
  inbound_sms_webhook_url: 'https://api.example.com/webhooks/retell/sms-inbound',
  ...over,
});

function setup(creds: Record<string, unknown> | null = BASE, opts: { chats?: Record<string, unknown>[]; settings?: Record<string, unknown> } = {}) {
  const saved: Record<string, unknown>[] = [];
  let current = creds;
  const credsSvc = {
    getCreds: vi.fn(async () => current),
    save: vi.fn(async (_org: string, patch: Record<string, unknown>) => {
      saved.push(patch);
      current = { ...(current ?? BASE), ...patch };
      return current;
    }),
  };
  const prisma = {
    smsChat: { findMany: vi.fn(async () => opts.chats ?? []), upsert: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 1 })) },
    lead: { findFirst: vi.fn(async () => ({ id: LEAD })) },
    organizationSetting: { findUnique: vi.fn(async () => ({ callRecordingEnabled: true, inCallBooking: null, callTools: null, ...(opts.settings ?? {}) })) },
  };
  const activity = { leadVariables: vi.fn(async () => ({ firstName: 'Asha', leadId: LEAD })) };
  const tools = { ensure: vi.fn(async () => undefined), provisionNow: vi.fn(async () => undefined) };
  const svc = new RetellSmsService(prisma as any, credsSvc as any, activity as any, tools as any, { get: () => 'https://api.example.com/' } as any);
  return { svc, prisma, credsSvc, tools, saved };
}

describe('RetellSmsService.capability', () => {
  it('is unavailable until Retell is connected, in use, with a number and an SMS agent', async () => {
    expect(await setup(null).svc.capability(ORG)).toMatchObject({ available: false, state: 'unavailable' });
    expect(await setup({ ...BASE, active: false }).svc.capability(ORG)).toMatchObject({ available: false, state: 'unavailable', reason: expect.stringContaining('not this organization') });
    expect(await setup({ ...BASE, fromNumber: '' }).svc.capability(ORG)).toMatchObject({ available: false, state: 'no_number' });
    expect(await setup({ ...BASE, smsAgentId: '' }).svc.capability(ORG)).toMatchObject({ available: false, state: 'not_configured', reason: expect.stringContaining('set up the SMS agent') });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a number Retell cannot text from is unsupported, with why: Telnyx SIP, Retell-Telnyx, non-US or toll-free', async () => {
    const check = async (from: string, n: Record<string, unknown>) => {
      fetchMock.mockResolvedValueOnce(json(number(n)));
      return setup({ ...BASE, fromNumber: from }).svc.capability(ORG);
    };
    expect(await check('+17427245092', { phone_number_type: 'custom', sip_outbound_trunk_config: { termination_uri: 'sip.telnyx.com' } })).toMatchObject({
      available: false,
      state: 'unsupported_number',
      reason: expect.stringContaining('brought in from Telnyx'),
    });
    expect(await check('+12025550100', { phone_number_type: 'retell-telnyx' })).toMatchObject({ state: 'unsupported_number', reason: expect.stringContaining('Retell-Telnyx') });
    expect(await check('+442071234567', { phone_number_type: 'retell-twilio' })).toMatchObject({ state: 'unsupported_number', reason: expect.stringContaining('US numbers only') });
    expect(await check('+18005550100', { phone_number_type: 'retell-twilio' })).toMatchObject({ state: 'unsupported_number', reason: expect.stringContaining('toll-free') });
  });

  it('a number without the SMS agent bound both ways is not configured', async () => {
    fetchMock.mockResolvedValueOnce(json(number({ outbound_sms_agents: [] })));
    expect(await setup().svc.capability(ORG)).toMatchObject({ available: false, state: 'not_configured', reason: expect.stringContaining('not bound') });
  });

  it('a Retell-Twilio US number with the agent bound can text, but its A2P registration cannot be verified through the API', async () => {
    fetchMock.mockResolvedValueOnce(json(number()));
    expect(await setup().svc.capability(ORG)).toEqual({ available: true, state: 'unverified', reason: REGISTRATION_NOTE, deliveryReports: false });
  });

  it('a custom number that is not from Telnyx may have Retell’s own-Twilio SMS function: left to the send to tell', async () => {
    fetchMock.mockResolvedValueOnce(json(number({ phone_number_type: 'custom', sip_outbound_trunk_config: { termination_uri: 'example.pstn.twilio.com' } })));
    expect(await setup().svc.capability(ORG)).toMatchObject({ available: true, state: 'unverified' });
  });

  it('a number Retell cannot describe is unavailable, with Retell’s message, and the number is asked for once per few minutes', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"message":"Cannot find requested asset"}', { status: 422 }));
    const { svc } = setup();
    expect(await svc.capability(ORG)).toMatchObject({ available: false, state: 'unavailable', reason: expect.stringContaining('Cannot find requested asset') });
    fetchMock.mockResolvedValueOnce(json(number()));
    await svc.capability(ORG);
    await svc.capability(ORG);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('RetellSmsService.setup', () => {
  it('creates the SMS LLM and chat agent once, keeps their ids as they appear, binds the number both ways and puts the tools on', async () => {
    fetchMock
      .mockResolvedValueOnce(json(number({ inbound_sms_agents: [], outbound_sms_agents: [], inbound_sms_webhook_url: null })))
      .mockResolvedValueOnce(json({ llm_id: 'sms_llm_1' }, 201))
      .mockResolvedValueOnce(json({ agent_id: 'sms_agent_1' }, 201))
      .mockResolvedValueOnce(json(number()))
      .mockResolvedValueOnce(json(number()));
    const { svc, saved, tools } = setup({ ...BASE, smsAgentId: '', smsLlmId: '' });
    const status = await svc.setup(ORG);

    const llm = sent(1);
    expect(llm.url).toBe('https://api.retellai.com/create-retell-llm');
    expect(llm.body).toMatchObject({ begin_message: `{{${OPENING_VARIABLE}}}`, start_speaker: 'agent', general_tools: [], default_dynamic_variables: { [OPENING_VARIABLE]: '' } });
    expect(llm.body.general_prompt).toBe(DEFAULT_SMS_PROMPT);
    const agent = sent(2);
    expect(agent.url).toBe('https://api.retellai.com/create-chat-agent');
    expect(agent.body).toMatchObject({
      response_engine: { type: 'retell-llm', llm_id: 'sms_llm_1' },
      webhook_url: 'https://api.example.com/webhooks/retell',
      webhook_events: ['chat_started', 'chat_ended', 'chat_analyzed'],
      data_storage_setting: 'everything',
    });
    expect(agent.body.post_chat_analysis_data).toHaveLength(19);
    const bind = sent(3);
    expect(bind.url).toBe('https://api.retellai.com/update-phone-number/%2B12025550100');
    expect(bind.body).toEqual({
      inbound_sms_agents: [{ agent_id: 'sms_agent_1', weight: 1 }],
      outbound_sms_agents: [{ agent_id: 'sms_agent_1', weight: 1 }],
      inbound_sms_webhook_url: 'https://api.example.com/webhooks/retell/sms-inbound',
    });
    expect(saved).toEqual([{ smsLlmId: 'sms_llm_1' }, { smsAgentId: 'sms_agent_1' }]);
    expect(tools.provisionNow).toHaveBeenCalledWith(ORG);
    expect(status.capability.state).toBe('unverified');
  });

  it('run again with the agent already there, creates nothing twice: only the webhook and the binding are checked', async () => {
    fetchMock
      .mockResolvedValueOnce(json(number()))
      .mockResolvedValueOnce(json({ agent_id: 'sms_agent_1', webhook_url: 'https://old-tunnel.example/webhooks/retell' }))
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json(number()))
      .mockResolvedValueOnce(json(number()));
    const { svc, saved } = setup();
    await svc.setup(ORG);
    expect(fetchMock.mock.calls.map((c) => String(c[0]).replace('https://api.retellai.com', ''))).toEqual([
      '/get-phone-number/%2B12025550100',
      '/get-chat-agent/sms_agent_1',
      '/update-chat-agent/sms_agent_1',
      '/update-phone-number/%2B12025550100',
      '/get-phone-number/%2B12025550100',
    ]);
    expect(sent(2).body).toMatchObject({ webhook_url: 'https://api.example.com/webhooks/retell' });
    expect(saved).toEqual([]);
  });

  it('refuses a number Retell cannot text from before creating anything', async () => {
    fetchMock.mockResolvedValueOnce(json(number({ phone_number_type: 'custom', sip_outbound_trunk_config: { termination_uri: 'sip.telnyx.com' } })));
    const { svc } = setup({ ...BASE, smsAgentId: '', smsLlmId: '' });
    await expect(svc.setup(ORG)).rejects.toThrow('brought in from Telnyx');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('needs the account, the voice agent and the number first', async () => {
    await expect(setup(null).svc.setup(ORG)).rejects.toThrow('Connect a Retell account first.');
    await expect(setup({ ...BASE, agentId: '' }).svc.setup(ORG)).rejects.toThrow('Create the Retell agent first.');
    await expect(setup({ ...BASE, fromNumber: '' }).svc.setup(ORG)).rejects.toThrow('Choose the Retell number');
  });

  it('disable unbinds the agent from the number and keeps the agent for a later setup', async () => {
    fetchMock.mockResolvedValueOnce(json({})).mockResolvedValueOnce(json(number({ inbound_sms_agents: [], outbound_sms_agents: [] })));
    const { svc, saved } = setup();
    const status = await svc.disable(ORG);
    expect(sent(0).body).toEqual({ inbound_sms_agents: null, outbound_sms_agents: null, inbound_sms_webhook_url: null });
    expect(status.capability.state).toBe('not_configured');
    expect(saved).toEqual([]);
  });
});

describe('RetellSmsService.sendSms', () => {
  it('opens an SMS chat whose opening message is exactly the text, filed under the lead, and names the chat and message in the id', async () => {
    fetchMock
      .mockResolvedValueOnce(json(number()))
      .mockResolvedValueOnce(json({ chat_id: 'chat_1', chat_status: 'ongoing', message_with_tool_calls: [{ role: 'agent', content: 'Hi Asha!', message_id: 'msg_1' }] }, 201));
    const { svc, prisma, tools } = setup();
    const res = await svc.sendSms(ORG, '+12895550111', 'Hi Asha!', { leadId: LEAD });
    expect(res).toEqual({ id: 'chat_1:msg_1' });
    const create = sent(1);
    expect(create.url).toBe('https://api.retellai.com/create-sms-chat');
    expect(create.body).toEqual({
      from_number: '+12025550100',
      to_number: '+12895550111',
      override_agent_id: 'sms_agent_1',
      metadata: { orgId: ORG, leadId: LEAD, source: 'outbound' },
      retell_llm_dynamic_variables: { firstName: 'Asha', leadId: LEAD, [OPENING_VARIABLE]: 'Hi Asha!' },
      honor_internal_dnc: true,
    });
    expect(prisma.smsChat.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ orgId: ORG, leadId: LEAD, providerChatId: 'chat_1', direction: 'outbound', status: 'ongoing' }) }));
    expect(tools.ensure).toHaveBeenCalledWith(ORG);
  });

  it('a chat whose opening message Retell has not numbered yet gets a placeholder id the sync replaces', async () => {
    fetchMock.mockResolvedValueOnce(json(number())).mockResolvedValueOnce(json({ chat_id: 'chat_2', chat_status: 'ongoing' }, 201));
    expect(await setup().svc.sendSms(ORG, '+12895550111', 'Hi', { leadId: LEAD })).toEqual({ id: 'chat_2:opening' });
  });

  it('refuses, with the reason, when the number cannot text; nothing is sent and nothing falls back to Telnyx', async () => {
    const { svc } = setup({ ...BASE, smsAgentId: '' });
    await expect(svc.sendSms(ORG, '+12895550111', 'Hi', { leadId: LEAD })).rejects.toThrow('SMS is not set up on Retell yet');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ends the lead’s chat still open before opening the next, so the agent runs one conversation per person', async () => {
    fetchMock
      .mockResolvedValueOnce(json(number()))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({ chat_id: 'chat_3', chat_status: 'ongoing' }, 201));
    const { svc, prisma } = setup(BASE, { chats: [{ providerChatId: 'chat_old' }] });
    await svc.sendSms(ORG, '+12895550111', 'Hi', { leadId: LEAD });
    expect(sent(1)).toMatchObject({ url: 'https://api.retellai.com/end-chat/chat_old', method: 'PATCH' });
    expect(prisma.smsChat.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { provider: 'retell', providerChatId: 'chat_old', status: 'ongoing' } }));
  });

  it('a chat Retell could not start, or refused (429, DNC), is an error the step records as failed', async () => {
    fetchMock.mockResolvedValueOnce(json(number())).mockResolvedValueOnce(json({ chat_id: 'chat_4', chat_status: 'error' }, 201));
    await expect(setup().svc.sendSms(ORG, '+12895550111', 'Hi', { leadId: LEAD })).rejects.toThrow('could not start the SMS chat');
    fetchMock.mockResolvedValueOnce(json(number())).mockResolvedValueOnce(new Response('{"message":"Account rate limited"}', { status: 429 }));
    await expect(setup().svc.sendSms(ORG, '+12895550111', 'Hi', { leadId: LEAD })).rejects.toThrow('Retell POST /create-sms-chat failed 429: Account rate limited');
  });
});

describe('RetellSmsService agent and URLs', () => {
  it('replaces the SMS prompt, keeping the booking section when booking is on for Retell and the tools section once the tools are on this LLM', async () => {
    fetchMock.mockResolvedValueOnce(json({})).mockResolvedValueOnce(json({ general_prompt: 'saved' }));
    const { svc } = setup(BASE, {
      settings: { inCallBooking: { provider: 'retell', tokenHash: 'h', eventTypeName: 'Consultation', durationMinutes: 30 }, callTools: { enabled: true, retell: { tokenHash: 'h', llmIds: ['llm_1', 'sms_llm_1'] } } },
    });
    await svc.updateAgent(ORG, { prompt: 'Be brief.' });
    const prompt = sent(0).body.general_prompt as string;
    expect(prompt.startsWith('Be brief.')).toBe(true);
    expect(prompt).toContain('appointment booking');
    expect(prompt).toContain('callbacks and outcomes');
  });

  it('points the chat agent and the number’s inbound SMS webhook at this server only when they name another address', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ webhook_url: 'https://api.example.com/webhooks/retell' }))
      .mockResolvedValueOnce(json(number({ inbound_sms_webhook_url: 'https://old-tunnel.example/webhooks/retell/sms-inbound' })))
      .mockResolvedValueOnce(json({}));
    const { svc } = setup();
    await svc.refreshUrls(BASE as any);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sent(2)).toMatchObject({ url: 'https://api.retellai.com/update-phone-number/%2B12025550100', body: { inbound_sms_webhook_url: 'https://api.example.com/webhooks/retell/sms-inbound' } });
  });
});
