import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyRetellSignature } from '@/common/utils/crypto';
import { POST_CALL_ANALYSIS_DATA, extractionFromRetell } from './retell-analysis';
import { RetellAccountService } from './retell-account.service';
import { RetellCallingProvider } from './retell-calling.provider';

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

  it('is null for voicemail and for calls with no analysis', () => {
    expect(extractionFromRetell({ in_voicemail: true, custom_analysis_data: { pre_approved: true } })).toBeNull();
    expect(extractionFromRetell({ custom_analysis_data: {} })).toBeNull();
    expect(extractionFromRetell(undefined)).toBeNull();
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
    return new RetellCallingProvider({ getCreds: vi.fn().mockResolvedValue(c) } as any, activity as any);
  };

  it('is voice only', () => {
    expect(setup().capabilities).toEqual({ sms: false });
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

  it('never sends a text', async () => {
    await expect(setup().sendSms()).rejects.toThrow('Retell sends no SMS');
  });

  it('reports the workspace concurrency limit', async () => {
    fetchMock.mockResolvedValue(json({ current_concurrency: 2, concurrency_limit: 20 }));
    expect(await setup().providerLimit(ORG)).toBe(20);
  });
});

describe('RetellAccountService', () => {
  const creds = (c: Record<string, unknown> = {}) => ({
    getCreds: vi.fn().mockResolvedValue({ apiKey: 'key_api', webhookKey: 'key_hook', agentId: '', llmId: '', fromNumber: '', ...c }),
    save: vi.fn().mockResolvedValue({}),
  });
  const prisma = (record = true) => ({
    organizationSetting: {
      findUnique: vi.fn().mockResolvedValue({ callRecordingEnabled: record, callRecordingAnnounce: true, inCallBooking: null }),
      upsert: vi.fn(),
    },
  });
  const config = { get: () => 'https://api.example.com/' };
  const slots = { inUse: vi.fn().mockResolvedValue(1) };

  it('creates the LLM and the agent, wired for our webhook, scoring fields, DNC and voicemail', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ llm_id: 'llm_1' }))
      .mockResolvedValueOnce(json({ agent_id: 'agent_1' }))
      .mockResolvedValueOnce(json({ voice_id: 'voice_1', language: 'en-US', max_call_duration_ms: 1_800_000, voicemail_option: { action: { type: 'hangup' } } }))
      .mockResolvedValueOnce(json({ general_prompt: 'p', begin_message: 'g' }));
    const c = creds();
    const svc = new RetellAccountService(prisma(false) as any, c as any, config as any, slots as any);
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
    const svc = new RetellAccountService(prisma() as any, creds() as any, config as any, slots as any);
    await expect(svc.createAgent(ORG, { voiceId: 'nope' })).rejects.toThrow('failed 400');
    expect(sent(2)).toMatchObject({ url: 'https://api.retellai.com/delete-retell-llm/llm_1', method: 'DELETE' });
  });

  it('refuses keys from two different Retell workspaces', async () => {
    fetchMock.mockResolvedValueOnce(json({ org_id: 'ws_1' })).mockResolvedValueOnce(json({ org_id: 'ws_2' }));
    const svc = new RetellAccountService(prisma() as any, creds() as any, config as any, slots as any);
    await expect(svc.verifyKeys('key_api', 'key_hook')).rejects.toThrow('different Retell workspaces');
  });

  it('says which key Retell rejected', async () => {
    fetchMock.mockResolvedValueOnce(json({ org_id: 'ws_1' })).mockResolvedValueOnce(new Response('{"message":"invalid"}', { status: 401 }));
    const svc = new RetellAccountService(prisma() as any, creds() as any, config as any, slots as any);
    await expect(svc.verifyKeys('key_api', 'bad')).rejects.toThrow('Retell rejected the webhook key');
  });

  it('keeps our call limit within the Retell workspace limit, which only Retell can raise', async () => {
    fetchMock.mockResolvedValueOnce(json({ current_concurrency: 0, concurrency_limit: 20 }));
    const p = prisma();
    const svc = new RetellAccountService(p as any, creds() as any, config as any, slots as any);
    await expect(svc.setCallCapacity(ORG, 25)).rejects.toThrow('allows 20 concurrent calls');
    expect(p.organizationSetting.upsert).not.toHaveBeenCalled();
  });

  it('offers only voices a Retell LLM agent can use (xAI voices need xAI speech-to-speech)', async () => {
    fetchMock.mockResolvedValueOnce(json([{ voice_id: 'xai-Iris', voice_name: 'Iris', provider: 'xai' }, { voice_id: '11labs-Adrian', voice_name: 'Adrian', provider: 'elevenlabs' }]));
    const svc = new RetellAccountService(prisma() as any, creds() as any, config as any, slots as any);
    expect((await svc.listVoices(ORG)).map((v) => v.id)).toEqual(['11labs-Adrian']);
  });

  it('passes Retell’s own error message on, not its JSON envelope', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ llm_id: 'llm_1' }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'error', message: 'Voice xai-Iris is only supported with xai speech-to-speech models.' }), { status: 400 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const svc = new RetellAccountService(prisma() as any, creds() as any, config as any, slots as any);
    await expect(svc.createAgent(ORG, { voiceId: 'xai-Iris' })).rejects.toThrow('Retell POST /create-agent failed 400: Voice xai-Iris is only supported with xai speech-to-speech models.');
  });
});
