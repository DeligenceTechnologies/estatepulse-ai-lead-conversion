import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyRetellSignature } from '@/common/utils/crypto';
import { POST_CALL_ANALYSIS_DATA, extractionFromRetell } from './retell-analysis';
import { RetellAccountService } from './retell-account.service';
import { RetellCallingProvider } from './retell-calling.provider';
import { inVoicemail, voicemailExtraction } from './retell-analysis';

const ORG = 'org-1';
const KEY = 'key_webhook_123';
const sign = (body: string, ts: number, key = KEY) => `v=${ts},d=${createHmac('sha256', key).update(body + ts).digest('hex')}`;

describe('verifyRetellSignature', () => {
  const body = '{"event":"call_ended"}';
  const now = 1_790_000_000_000;

  it('accepts HMAC-SHA256 of body + timestamp under the webhook key, within five minutes', () => {
    expect(verifyRetellSignature({ key: KEY, header: sign(body, now), rawBody: Buffer.from(body), nowMs: now + 60_000 })).toBe(true);
  });

  it('refuses another key, a changed body, an old timestamp or a missing header', () => {
    expect(verifyRetellSignature({ key: KEY, header: sign(body, now, 'other'), rawBody: Buffer.from(body), nowMs: now })).toBe(false);
    expect(verifyRetellSignature({ key: KEY, header: sign(body, now), rawBody: Buffer.from(`${body} `), nowMs: now })).toBe(false);
    expect(verifyRetellSignature({ key: KEY, header: sign(body, now), rawBody: Buffer.from(body), nowMs: now + 6 * 60_000 })).toBe(false);
    expect(verifyRetellSignature({ key: KEY, header: undefined, rawBody: Buffer.from(body), nowMs: now })).toBe(false);
    expect(verifyRetellSignature({ key: '', header: sign(body, now, ''), rawBody: Buffer.from(body), nowMs: now })).toBe(false);
  });
});

describe('POST_CALL_ANALYSIS_DATA', () => {
  it('asks Retell for every qualification field, with the same choices the scorer accepts', () => {
    const byName = Object.fromEntries(POST_CALL_ANALYSIS_DATA.map((f) => [f.name, f]));
    expect(POST_CALL_ANALYSIS_DATA).toHaveLength(19);
    expect(byName.reached_person.type).toBe('boolean');
    expect(byName.do_not_contact.type).toBe('boolean');
    expect(byName.timeline).toMatchObject({ type: 'enum', choices: ['within_30_days', '1_3_months', '3_6_months', 'over_6_months', 'unknown'] });
    expect(byName.financing).toMatchObject({ type: 'enum', choices: ['pre_approved', 'cash', 'needs_financing', 'unknown'] });
    expect(byName.pre_approved.type).toBe('boolean');
    expect(byName.budget_min.type).toBe('number');
    expect(byName.bedrooms.type).toBe('number');
    expect(byName.location.type).toBe('string');
    expect(byName.summary.type).toBe('string');
  });
});

describe('extractionFromRetell', () => {
  it('carries the newer verdicts (a person reached, do not contact) only when Retell answered them', () => {
    expect(extractionFromRetell({ custom_analysis_data: { summary: 'x', reached_person: true, do_not_contact: 'false' } })).toMatchObject({ reached_person: true, do_not_contact: false });
    const older = extractionFromRetell({ custom_analysis_data: { summary: 'x' } });
    expect(older?.reached_person).toBeUndefined();
    expect(older?.do_not_contact).toBeUndefined();
  });

  it('reads Retell’s custom analysis as our extraction, filling what was not said', () => {
    const x = extractionFromRetell({
      call_summary: 'Retell summary',
      custom_analysis_data: { timeline: '1_3_months', pre_approved: true, budget_max: '450000', bedrooms: 3.4, location: ' Austin ', financing: 'cash' },
    });
    expect(x).toMatchObject({
      timeline: '1_3_months',
      pre_approved: true,
      budget_identified: false,
      human_requested: false,
      budget_max: 450000,
      bedrooms: 3,
      location: 'Austin',
      financing: 'cash',
      summary: 'Retell summary',
    });
  });

  it('drops values out of range instead of losing the whole call', () => {
    const x = extractionFromRetell({ custom_analysis_data: { timeline: 'soon', bedrooms: 99, budget_min: -5, financing: 'mortgage' } });
    expect(x).toMatchObject({ timeline: 'unknown', bedrooms: null, budget_min: null, financing: null });
  });

  it('is null for calls with no analysis', () => {
    expect(extractionFromRetell({ custom_analysis_data: {} })).toBeNull();
    expect(extractionFromRetell(undefined)).toBeNull();
  });

  it('reads Retell’s own voicemail verdict as a call that reached no one, scoring nothing from the greeting', () => {
    expect(inVoicemail({ in_voicemail: true })).toBe(true);
    expect(inVoicemail({ in_voicemail: false })).toBe(false);
    expect(inVoicemail(undefined)).toBe(false);
    expect(voicemailExtraction({ in_voicemail: true, call_summary: 'Left at the beep.' })).toMatchObject({ reached_person: false, summary: 'Left at the beep.', pre_approved: false, timeline: 'unknown' });
  });

  it('reads a chat’s summary too', () => {
    expect(extractionFromRetell({ chat_summary: 'Texted back.', custom_analysis_data: { not_interested: true } })).toMatchObject({ not_interested: true, summary: 'Texted back.' });
  });
});

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
const json = (data: unknown) => new Response(JSON.stringify(data), { status: 201 });
const sent = (i = 0) => {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit];
  return { url, method: init.method ?? 'GET', auth: (init.headers as Record<string, string>).Authorization, body: init.body ? JSON.parse(String(init.body)) : undefined };
};

describe('RetellCallingProvider', () => {
  const active = { active: true, apiKey: 'key_api', agentId: 'agent_1', fromNumber: '+12025550100' };
  const setup = (c: Record<string, unknown> | null = active) => {
    const activity = { leadVariables: vi.fn().mockResolvedValue({ firstName: 'Asha', leadId: 'lead-1' }) };
    const sms = { capability: vi.fn().mockResolvedValue({ available: false, state: 'not_configured', reason: 'SMS is not set up on Retell yet', deliveryReports: false }), sendSms: vi.fn().mockResolvedValue({ id: 'chat_1:opening' }) };
    const tools = { ensure: vi.fn().mockResolvedValue(undefined) };
    const provider = new RetellCallingProvider({ getCreds: vi.fn().mockResolvedValue(c) } as any, activity as any, sms as any, tools as any);
    return Object.assign(provider, { mocks: { sms, tools } });
  };

  it('can text once its SMS agent is set up, and says why not until then', async () => {
    const p = setup();
    expect(p.capabilities).toEqual({ sms: true });
    expect(await p.smsCapability(ORG)).toMatchObject({ available: false, state: 'not_configured' });
  });

  it('places the call on the organization’s agent with the lead as dynamic variables', async () => {
    fetchMock.mockResolvedValue(json({ call_id: 'call_abc', call_status: 'registered' }));
    const res = await setup().startCall(ORG, '+12895550111', { leadId: 'lead-1', orgId: ORG });
    expect(res).toEqual({ providerCallId: 'call_abc' });
    const s = sent();
    expect(s.url).toBe('https://api.retellai.com/v2/create-phone-call');
    expect(s.method).toBe('POST');
    expect(s.auth).toBe('Bearer key_api');
    expect(s.body).toEqual({
      from_number: '+12025550100',
      to_number: '+12895550111',
      override_agent_id: 'agent_1',
      retell_llm_dynamic_variables: { firstName: 'Asha', leadId: 'lead-1' },
      metadata: { leadId: 'lead-1', orgId: ORG },
      honor_internal_dnc: true,
    });
  });

  it('refuses to dial an inactive or unfinished account', async () => {
    await expect(setup({ ...active, active: false }).startCall(ORG, '+1', { leadId: 'l', orgId: ORG })).rejects.toThrow('No provider connected');
    await expect(setup({ ...active, agentId: '' }).startCall(ORG, '+1', { leadId: 'l', orgId: ORG })).rejects.toThrow('No Retell agent');
    await expect(setup({ ...active, fromNumber: '' }).startCall(ORG, '+1', { leadId: 'l', orgId: ORG })).rejects.toThrow('No from number');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('words a 429 so the call worker waits instead of failing the call', async () => {
    fetchMock.mockResolvedValue(new Response('{"message":"rate limited"}', { status: 429 }));
    await expect(setup().startCall(ORG, '+12895550111', { leadId: 'l', orgId: ORG })).rejects.toThrow('Retell POST /v2/create-phone-call failed 429');
  });

  it('hands a text to the Retell SMS service with the lead it is for, never to Telnyx', async () => {
    const p = setup();
    expect(await p.sendSms(ORG, '+12895550111', 'Hi', { leadId: 'lead-1' })).toEqual({ id: 'chat_1:opening' });
    expect(p.mocks.sms.sendSms).toHaveBeenCalledWith(ORG, '+12895550111', 'Hi', { leadId: 'lead-1' });
  });

  it('makes sure the callback and outcome tools are on the agent before dialing', async () => {
    fetchMock.mockResolvedValue(json({ call_id: 'call_abc' }));
    const p = setup();
    await p.startCall(ORG, '+12895550111', { leadId: 'lead-1', orgId: ORG });
    expect(p.mocks.tools.ensure).toHaveBeenCalledWith(ORG);
  });

  it('reports the workspace concurrency limit', async () => {
    fetchMock.mockResolvedValue(json({ current_concurrency: 2, concurrency_limit: 20 }));
    expect(await setup().providerLimit(ORG)).toBe(20);
  });
});

describe('RetellAccountService', () => {
  const creds = (c: Record<string, unknown> | null = {}) => ({
    getCreds: vi.fn().mockResolvedValue(c && { apiKey: 'key_api', webhookKey: 'key_hook', agentId: '', llmId: '', fromNumber: '', ...c }),
    save: vi.fn().mockResolvedValue({}),
  });
  const prisma = (record = true) => ({
    organizationSetting: {
      findUnique: vi.fn().mockResolvedValue({ callRecordingEnabled: record, callRecordingAnnounce: true, inCallBooking: null }),
      upsert: vi.fn(),
    },
  });
  const config = { get: (key: string) => (key === 'PUBLIC_API_URL' ? 'https://api.example.com/' : false) };
  const slots = { inUse: vi.fn().mockResolvedValue(1) };
  const tools = { provisionNow: vi.fn().mockResolvedValue(undefined), refreshUrls: vi.fn().mockResolvedValue(undefined) };
  const smsSvc = { refreshUrls: vi.fn().mockResolvedValue(undefined), setDataStorage: vi.fn().mockResolvedValue(undefined) };

  it('creates the LLM and the agent, wired for our webhook, scoring fields, DNC and voicemail', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ llm_id: 'llm_1' }))
      .mockResolvedValueOnce(json({ agent_id: 'agent_1' }))
      .mockResolvedValueOnce(json({ voice_id: 'voice_1', language: 'en-US', max_call_duration_ms: 1_800_000, voicemail_option: { action: { type: 'hangup' } } }))
      .mockResolvedValueOnce(json({ general_prompt: 'p', begin_message: 'g' }));
    const c = creds();
    const svc = new RetellAccountService(prisma(false) as any, c as any, config as any, slots as any, tools as any, smsSvc as any);
    await svc.createAgent(ORG, { voiceId: 'voice_1' });

    const llm = sent(0);
    expect(llm.url).toBe('https://api.retellai.com/create-retell-llm');
    expect(llm.body.general_tools).toEqual([expect.objectContaining({ type: 'end_call', name: 'end_call' })]);
    expect(llm.body.start_speaker).toBe('agent');
    expect(llm.body.begin_message).not.toMatch(/recorded/); // recording is off, so no recording notice

    const agent = sent(1);
    expect(agent.url).toBe('https://api.retellai.com/create-agent');
    expect(agent.body).toMatchObject({
      response_engine: { type: 'retell-llm', llm_id: 'llm_1' },
      voice_id: 'voice_1',
      webhook_url: 'https://api.example.com/webhooks/retell',
      webhook_events: ['call_started', 'call_ended', 'call_analyzed'],
      voicemail_option: { action: { type: 'hangup' } },
      enable_dnc_detection: true,
      data_storage_setting: 'basic_attributes_only',
      max_call_duration_ms: 1_800_000,
    });
    expect(agent.body.post_call_analysis_data).toHaveLength(19);
    expect(c.save).toHaveBeenCalledWith(ORG, { agentId: 'agent_1', llmId: 'llm_1' });
  });

  it('removes the LLM again when the agent cannot be created', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ llm_id: 'llm_1' }))
      .mockResolvedValueOnce(new Response('{"message":"bad voice"}', { status: 400 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const svc = new RetellAccountService(prisma() as any, creds() as any, config as any, slots as any, tools as any, smsSvc as any);
    await expect(svc.createAgent(ORG, { voiceId: 'nope' })).rejects.toThrow('failed 400');
    expect(sent(2)).toMatchObject({ url: 'https://api.retellai.com/delete-retell-llm/llm_1', method: 'DELETE' });
  });

  it('refuses keys from two different Retell workspaces', async () => {
    fetchMock.mockResolvedValueOnce(json({ org_id: 'ws_1' })).mockResolvedValueOnce(json({ org_id: 'ws_2' }));
    const svc = new RetellAccountService(prisma() as any, creds(null) as any, config as any, slots as any, tools as any, smsSvc as any);
    await expect(svc.verifyKeys(ORG, { apiKey: 'key_api', webhookKey: 'key_hook' })).rejects.toThrow('different Retell workspaces');
  });

  it('says which key Retell rejected', async () => {
    fetchMock.mockResolvedValueOnce(json({ org_id: 'ws_1' })).mockResolvedValueOnce(new Response('{"message":"invalid"}', { status: 401 }));
    const svc = new RetellAccountService(prisma() as any, creds(null) as any, config as any, slots as any, tools as any, smsSvc as any);
    await expect(svc.verifyKeys(ORG, { apiKey: 'key_api', webhookKey: 'bad' })).rejects.toThrow('Retell rejected the webhook key');
  });

  it('replaces one key at a time once connected, checking it against the key on file; both are needed to connect', async () => {
    fetchMock.mockResolvedValueOnce(json({ org_id: 'ws_1', org_name: 'Acme' })).mockResolvedValueOnce(json({ org_id: 'ws_1' }));
    const svc = new RetellAccountService(prisma() as any, creds() as any, config as any, slots as any, tools as any, smsSvc as any);
    await expect(svc.verifyKeys(ORG, { webhookKey: 'key_hook_new' })).resolves.toEqual({ workspace: 'Acme' });
    expect(fetchMock.mock.calls.map((c) => (c[1] as RequestInit).headers)).toEqual([expect.objectContaining({ Authorization: 'Bearer key_api' }), expect.objectContaining({ Authorization: 'Bearer key_hook_new' })]);
    const fresh = new RetellAccountService(prisma() as any, creds(null) as any, config as any, slots as any, tools as any, smsSvc as any);
    await expect(fresh.verifyKeys(ORG, { apiKey: 'key_api' })).rejects.toThrow('Both the API key and the webhook key are needed');
    await expect(fresh.verifyKeys(ORG, {})).rejects.toThrow('Enter the API key');
  });

  it('lists the workspace’s voice agents, marking the one in use and leaving chat agents out', async () => {
    const agents = [{ agent_id: 'agent_1', agent_name: 'Ours', channel: 'voice' }, { agent_id: 'agent_2', agent_name: 'Theirs', channel: 'voice' }, { agent_id: 'chat_1', agent_name: 'Texter', channel: 'chat' }];
    fetchMock.mockResolvedValueOnce(json({ items: agents, has_more: false }));
    const svc = new RetellAccountService(prisma() as any, creds({ agentId: 'agent_1' }) as any, config as any, slots as any, tools as any, smsSvc as any);
    expect(await svc.listAgents(ORG)).toEqual([
      { agentId: 'agent_1', name: 'Ours', current: true },
      { agentId: 'agent_2', name: 'Theirs', current: false },
    ]);
    expect(sent(0)).toMatchObject({ url: 'https://api.retellai.com/v2/list-agents?limit=200', method: 'POST' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('names the agent as the owner typed it, so several agents can be told apart in the Retell dashboard', async () => {
    // No voice chosen: the first voice on the workspace is used, and changed later on AI settings.
    fetchMock
      .mockResolvedValueOnce(json([{ voice_id: 'voice_1', voice_name: 'Cleo', provider: 'elevenlabs' }]))
      .mockResolvedValueOnce(json({ llm_id: 'llm_1' }))
      .mockResolvedValueOnce(json({ agent_id: 'agent_1' }))
      .mockResolvedValueOnce(json({ agent_name: 'Austin Home Advisors', voice_id: 'voice_1' }))
      .mockResolvedValueOnce(json({ general_prompt: 'p', begin_message: 'g' }));
    const c = creds();
    // The ids saved during creation are what the read afterwards goes by.
    c.save.mockImplementation(async (_org: string, patch: Record<string, string>) => {
      c.getCreds.mockResolvedValue({ apiKey: 'key_api', webhookKey: 'key_hook', fromNumber: '', agentId: patch.agentId ?? '', llmId: patch.llmId ?? '' });
      return {};
    });
    const svc = new RetellAccountService(prisma() as any, c as any, config as any, slots as any, tools as any, smsSvc as any);
    const view = await svc.createAgent(ORG, { name: '  Austin Home Advisors ' });
    expect(sent(2).body).toMatchObject({ agent_name: 'Austin Home Advisors', voice_id: 'voice_1' });
    expect(view.name).toBe('Austin Home Advisors');
  });

  it('adopts an existing single-prompt agent: wired for our webhook and analysis, prompt and voice untouched, tools put on', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ agent_id: 'agent_2', response_engine: { type: 'retell-llm', llm_id: 'llm_2' } }))
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json({ voice_id: 'v', language: 'en-US' }))
      .mockResolvedValueOnce(json({ general_prompt: 'Their prompt', begin_message: 'Hi' }));
    const c = creds({ agentId: 'agent_1', llmId: 'llm_1' });
    const svc = new RetellAccountService(prisma(false) as any, c as any, config as any, slots as any, tools as any, smsSvc as any);
    await svc.useAgent(ORG, 'agent_2');
    const patch = sent(1);
    expect(patch).toMatchObject({ url: 'https://api.retellai.com/update-agent/agent_2', method: 'PATCH' });
    expect(patch.body).toMatchObject({ webhook_url: 'https://api.example.com/webhooks/retell', webhook_events: ['call_started', 'call_ended', 'call_analyzed'], enable_dnc_detection: true, data_storage_setting: 'basic_attributes_only' });
    expect(patch.body.post_call_analysis_data).toHaveLength(19);
    expect(patch.body.general_prompt).toBeUndefined();
    expect(patch.body.voice_id).toBeUndefined();
    expect(c.save).toHaveBeenCalledWith(ORG, { agentId: 'agent_2', llmId: 'llm_2' });
    expect(tools.provisionNow).toHaveBeenCalledWith(ORG);
  });

  it('reads the agent’s tools (ours without their secrets), its default variables and whether Retell analyses calls', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ agent_name: 'Ours', voice_id: 'v', webhook_events: ['call_started', 'call_ended', 'call_analyzed'], post_call_analysis_data: [{ type: 'string', name: 'summary' }] }))
      .mockResolvedValueOnce(
        json({
          general_prompt: 'p',
          default_dynamic_variables: { company_name: 'Acme', hours: '9-5', junk: { nested: true } },
          general_tools: [
            { type: 'end_call', name: 'end_call' },
            { type: 'custom', name: 'record_outcome', url: 'https://api.example.com/tools/outcome/record', headers: { Authorization: 'Bearer secret' } },
            { type: 'custom', name: 'crm_lookup', url: 'https://crm.example/lookup', method: 'GET', headers: { 'X-Key': 'k' }, parameters: { type: 'object', properties: {} } },
          ],
        }),
      );
    const svc = new RetellAccountService(prisma() as any, creds({ agentId: 'agent_1', llmId: 'llm_1' }) as any, config as any, slots as any, tools as any, smsSvc as any);
    const view = (await svc.getAgent(ORG))!;
    expect(view.postCallProcessing).toBe(true);
    expect(view.dynamicVariables).toEqual({ company_name: 'Acme', hours: '9-5' });
    expect(view.tools).toEqual([
      { type: 'end_call', name: 'end_call', managed: false },
      { type: 'custom', name: 'record_outcome', url: 'https://api.example.com/tools/outcome/record', managed: true },
      { type: 'custom', name: 'crm_lookup', url: 'https://crm.example/lookup', method: 'GET', headers: { 'X-Key': 'k' }, parameters: { type: 'object', properties: {} }, managed: false },
    ]);
    expect(JSON.stringify(view)).not.toContain('Bearer secret');
  });

  it('replaces the organization’s own tools on the LLM, keeps ours, and refuses malformed or colliding ones', async () => {
    const llm = { general_prompt: 'p', general_tools: [{ type: 'custom', name: 'record_outcome', url: 'u', headers: { Authorization: 'Bearer secret' } }, { type: 'custom', name: 'old', url: 'https://old' }] };
    fetchMock.mockImplementation(async (url: string) => (String(url).includes('/get-retell-llm/') ? json(llm) : json({ agent_name: 'Ours', webhook_events: [], general_tools: [] })));
    const svc = new RetellAccountService(prisma() as any, creds({ agentId: 'agent_1', llmId: 'llm_1' }) as any, config as any, slots as any, tools as any, smsSvc as any);
    await svc.setTools(ORG, [
      { type: 'end_call', name: 'end_call', description: 'Bye' },
      { type: 'custom', name: 'crm_lookup', description: 'Look the caller up', url: 'https://crm.example/lookup', method: 'get', headers: { 'X-Key': 'k' }, parameters: { type: 'object', properties: {} }, timeout_ms: 5000 },
      { type: 'transfer_call', name: 'to_agent', transfer_destination: { type: 'predefined', number: '+12025550123' }, transfer_option: { type: 'cold_transfer' } },
    ]);
    const patch = (fetchMock.mock.calls as [string, RequestInit][]).find(([u, i]) => String(u).includes('/update-retell-llm/') && i.method === 'PATCH')!;
    const body = JSON.parse(String(patch[1].body));
    expect(body.general_tools.map((t: any) => t.name)).toEqual(['record_outcome', 'end_call', 'crm_lookup', 'to_agent']);
    expect(body.general_tools[0].headers.Authorization).toBe('Bearer secret');
    expect(body.general_tools[2]).toEqual({ type: 'custom', name: 'crm_lookup', description: 'Look the caller up', url: 'https://crm.example/lookup', method: 'GET', headers: { 'X-Key': 'k' }, parameters: { type: 'object', properties: {} }, timeout_ms: 5000 });
    expect(body.general_tools[3]).toEqual({ type: 'transfer_call', name: 'to_agent', transfer_destination: { type: 'predefined', number: '+12025550123' }, transfer_option: { type: 'cold_transfer' } });

    await expect(svc.setTools(ORG, [{ type: 'custom', name: 'record_outcome', url: 'https://x' }])).rejects.toThrow('EstatePulse manages');
    await expect(svc.setTools(ORG, [{ type: 'custom', name: 'bad name', url: 'https://x' }])).rejects.toThrow('needs a name');
    await expect(svc.setTools(ORG, [{ type: 'custom', name: 'nourl' }])).rejects.toThrow('http(s) URL');
    await expect(svc.setTools(ORG, [{ type: 'transfer_call', name: 'x', transfer_destination: { type: 'predefined', number: '555' } }])).rejects.toThrow('E.164');
    await expect(svc.setTools(ORG, [{ type: 'mcp', name: 'x' }])).rejects.toThrow('not a kind this page can add');
  });

  it('switching post-call processing off stops Retell analysing and sending call_analyzed; on restores our fields; variables go to the LLM', async () => {
    fetchMock.mockImplementation(async (url: string) => (String(url).includes('/get-retell-llm/') ? json({ general_prompt: 'p', general_tools: [] }) : json({ agent_name: 'Ours', webhook_events: ['call_started', 'call_ended'], general_tools: [] })));
    const svc = new RetellAccountService(prisma() as any, creds({ agentId: 'agent_1', llmId: 'llm_1' }) as any, config as any, slots as any, tools as any, smsSvc as any);
    const view = await svc.updateAgent(ORG, { postCallProcessing: false, dynamicVariables: { company_name: 'Acme', '': 'dropped' } });
    const calls = fetchMock.mock.calls as [string, RequestInit][];
    const agentPatch = JSON.parse(String(calls.find(([u, i]) => String(u).includes('/update-agent/') && i.method === 'PATCH')![1].body));
    expect(agentPatch).toMatchObject({ webhook_events: ['call_started', 'call_ended'], post_call_analysis_data: [] });
    const llmPatch = JSON.parse(String(calls.find(([u, i]) => String(u).includes('/update-retell-llm/') && i.method === 'PATCH')![1].body));
    expect(llmPatch).toEqual({ default_dynamic_variables: { company_name: 'Acme' } });
    expect(view.postCallProcessing).toBe(false);

    fetchMock.mockClear();
    await svc.updateAgent(ORG, { postCallProcessing: true });
    const on = JSON.parse(String((fetchMock.mock.calls as [string, RequestInit][]).find(([u, i]) => String(u).includes('/update-agent/') && i.method === 'PATCH')![1].body));
    expect(on.webhook_events).toEqual(['call_started', 'call_ended', 'call_analyzed']);
    expect(on.post_call_analysis_data).toHaveLength(19);
  });

  it('refuses an agent that is not single-prompt (conversation flow, custom LLM), since its prompt cannot be edited here', async () => {
    fetchMock.mockResolvedValueOnce(json({ agent_id: 'flow_1', response_engine: { type: 'conversation-flow', conversation_flow_id: 'cf_1' } }));
    const svc = new RetellAccountService(prisma() as any, creds() as any, config as any, slots as any, tools as any, smsSvc as any);
    await expect(svc.useAgent(ORG, 'flow_1')).rejects.toThrow('does not run on a Retell LLM');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps our call limit within the Retell workspace limit, which only Retell can raise', async () => {
    fetchMock.mockResolvedValueOnce(json({ current_concurrency: 0, concurrency_limit: 20 }));
    const p = prisma();
    const svc = new RetellAccountService(p as any, creds() as any, config as any, slots as any, tools as any, smsSvc as any);
    await expect(svc.setCallCapacity(ORG, 25)).rejects.toThrow('allows 20 concurrent calls');
    expect(p.organizationSetting.upsert).not.toHaveBeenCalled();
  });

  it('offers only voices a Retell LLM agent can use (xAI voices need xAI speech-to-speech)', async () => {
    fetchMock.mockResolvedValueOnce(json([{ voice_id: 'xai-Iris', voice_name: 'Iris', provider: 'xai' }, { voice_id: '11labs-Adrian', voice_name: 'Adrian', provider: 'elevenlabs' }]));
    const svc = new RetellAccountService(prisma() as any, creds() as any, config as any, slots as any, tools as any, smsSvc as any);
    expect((await svc.listVoices(ORG)).map((v) => v.id)).toEqual(['11labs-Adrian']);
  });

  it('passes Retell’s own error message on, not its JSON envelope', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ llm_id: 'llm_1' }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'error', message: 'Voice xai-Iris is only supported with xai speech-to-speech models.' }), { status: 400 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const svc = new RetellAccountService(prisma() as any, creds() as any, config as any, slots as any, tools as any, smsSvc as any);
    await expect(svc.createAgent(ORG, { voiceId: 'xai-Iris' })).rejects.toThrow('Retell POST /create-agent failed 400: Voice xai-Iris is only supported with xai speech-to-speech models.');
  });
});
