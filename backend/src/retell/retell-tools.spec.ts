import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@/common/utils/crypto';
import { CALL_TOOLS_PROMPT_START, CALL_TOOLS_VERSION } from '@/telnyx/tools/call-tools';
import { RetellToolAuthService } from './retell-tool-auth.service';
import { retargetOurTools, retellOutcomeTools } from './retell-tools';
import { RetellToolsService } from './retell-tools.service';

const ORG = 'org-1';
const API = 'https://api.example.com';

describe('retellOutcomeTools', () => {
  it('are the two Telnyx tools as Retell custom functions on /tools/outcome, the token in their headers, the chat named in the URL for a text chat', () => {
    const call = retellOutcomeTools(API, 'tok', 'call');
    expect(call.map((t) => [t.name, t.url])).toEqual([
      ['schedule_callback', `${API}/tools/outcome/callback`],
      ['record_outcome', `${API}/tools/outcome/record`],
    ]);
    expect(call[0]).toMatchObject({ type: 'custom', method: 'POST', headers: { Authorization: 'Bearer tok' }, speak_during_execution: false, parameters: { type: 'object' } });
    expect(retellOutcomeTools(API, 'tok', 'chat').map((t) => t.url)).toEqual([`${API}/tools/outcome/callback?chat_id={{chat_id}}`, `${API}/tools/outcome/record?chat_id={{chat_id}}`]);
  });
});

describe('retargetOurTools', () => {
  it('moves only our tools, only when they name another host, keeping path, query and headers', () => {
    const tools = [
      { type: 'end_call', name: 'end_call' },
      { type: 'custom', name: 'record_outcome', url: 'https://old-tunnel.example/tools/outcome/record?chat_id={{chat_id}}', headers: { Authorization: 'Bearer tok' } },
      { type: 'custom', name: 'their_tool', url: 'https://old-tunnel.example/theirs' },
      { type: 'custom', name: 'check_availability', url: `${API}/tools/booking/availability` },
    ];
    const next = retargetOurTools(tools, API)!;
    expect(next[1]).toEqual({ type: 'custom', name: 'record_outcome', url: `${API}/tools/outcome/record?chat_id={{chat_id}}`, headers: { Authorization: 'Bearer tok' } });
    expect(next[2]).toBe(tools[2]);
    expect(next[3]).toBe(tools[3]);
    expect(retargetOurTools(next, API)).toBeNull();
  });
});

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
const bodyOf = (i: number) => JSON.parse(String((fetchMock.mock.calls[i][1] as RequestInit).body));

function toolsSetup(opts: { callTools?: Record<string, unknown> | null; creds?: Record<string, unknown> | null } = {}) {
  let stored: unknown = opts.callTools === undefined ? { enabled: true } : opts.callTools;
  const prisma = {
    organizationSetting: {
      findUnique: vi.fn(async () => ({ callTools: stored })),
      upsert: vi.fn(async ({ update }: any) => {
        stored = update.callTools;
      }),
    },
  };
  const creds = { getCreds: vi.fn(async () => (opts.creds === undefined ? { apiKey: 'key_api', llmId: 'llm_1', smsLlmId: 'sms_llm_1' } : opts.creds)) };
  const svc = new RetellToolsService(prisma as any, creds as any, { get: () => `${API}/` } as any);
  return { svc, stored: () => stored as any, prisma };
}

describe('RetellToolsService', () => {
  it('puts the tools and the prompt section on the voice and SMS LLMs, keeping their own tools, and stores the token hash and the LLMs', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ general_prompt: 'Voice prompt', general_tools: [{ type: 'end_call', name: 'end_call' }, { type: 'custom', name: 'record_outcome', url: 'old' }] }))
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json({ general_prompt: 'SMS prompt', general_tools: [] }))
      .mockResolvedValueOnce(json({}));
    const { svc, stored } = toolsSetup();
    await svc.provisionNow(ORG);
    const voice = bodyOf(1);
    expect(voice.general_tools.map((t: any) => [t.name, t.url])).toEqual([
      ['end_call', undefined],
      ['schedule_callback', `${API}/tools/outcome/callback`],
      ['record_outcome', `${API}/tools/outcome/record`],
    ]);
    expect(voice.general_prompt).toContain('Voice prompt');
    expect(voice.general_prompt).toContain(CALL_TOOLS_PROMPT_START);
    const sms = bodyOf(3);
    expect(sms.general_tools.map((t: any) => t.url)).toEqual([`${API}/tools/outcome/callback?chat_id={{chat_id}}`, `${API}/tools/outcome/record?chat_id={{chat_id}}`]);
    const token = /^Bearer (.+)$/.exec(voice.general_tools[1].headers.Authorization)![1];
    expect(sms.general_tools[0].headers.Authorization).toBe(`Bearer ${token}`);
    expect(stored()).toEqual({ enabled: true, retell: { tokenHash: sha256Hex(token), url: API, version: CALL_TOOLS_VERSION, llmIds: ['llm_1', 'sms_llm_1'] } });
    expect(await svc.tokenHash(ORG)).toBe(sha256Hex(token));
  });

  it('is idempotent: provisioned for these LLMs and this server, ensure() touches nothing; a new LLM or address provisions again', async () => {
    const current = { enabled: true, retell: { tokenHash: 'h', url: API, version: CALL_TOOLS_VERSION, llmIds: ['llm_1', 'sms_llm_1'] } };
    const same = toolsSetup({ callTools: current });
    await same.svc.ensure(ORG);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await same.svc.isCurrent(ORG, { llmId: 'llm_1', smsLlmId: 'sms_llm_1' } as any)).toBe(true);

    const moved = toolsSetup({ callTools: { ...current, retell: { ...current.retell, url: 'https://old-tunnel.example' } } });
    fetchMock.mockImplementation(async () => json({ general_prompt: 'p', general_tools: [] }));
    await moved.svc.ensure(ORG);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const fewer = toolsSetup({ callTools: { ...current, retell: { ...current.retell, llmIds: ['llm_1'] } } });
    expect(await fewer.svc.isCurrent(ORG, { llmId: 'llm_1', smsLlmId: 'sms_llm_1' } as any)).toBe(false);
  });

  it('off, or no agent yet: nothing is provisioned; turning on without an agent says so', async () => {
    const off = toolsSetup({ callTools: { enabled: false } });
    await off.svc.ensure(ORG);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await off.svc.tokenHash(ORG)).toBeNull();
    const noAgent = toolsSetup({ creds: { apiKey: 'key_api', llmId: '', smsLlmId: '' } });
    await expect(noAgent.svc.provisionNow(ORG)).rejects.toThrow('Create the Retell agent first.');
  });

  it('teardown removes our tools and the section from each LLM and forgets the hash, leaving the rest of the settings', async () => {
    const { svc, stored } = toolsSetup({ callTools: { enabled: false, confirmSms: false, retell: { tokenHash: 'h', url: API, version: CALL_TOOLS_VERSION, llmIds: ['llm_1'] } } });
    fetchMock
      .mockResolvedValueOnce(json({ general_prompt: `Own prompt\n\n${CALL_TOOLS_PROMPT_START}\nstuff\n[End of EstatePulse callbacks and outcomes]`, general_tools: [{ name: 'end_call' }, { name: 'record_outcome' }, { name: 'schedule_callback' }] }))
      .mockResolvedValueOnce(json({}));
    await svc.teardownNow(ORG);
    expect(bodyOf(1)).toEqual({ general_tools: [{ name: 'end_call' }], general_prompt: 'Own prompt' });
    expect(stored()).toEqual({ enabled: false, confirmSms: false, retell: null });
  });

  it('refreshUrls moves our tools to this server when they name another host, and writes nothing otherwise', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ general_prompt: 'p', general_tools: [{ name: 'record_outcome', url: 'https://old-tunnel.example/tools/outcome/record' }] }))
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json({ general_prompt: 'p', general_tools: [{ name: 'record_outcome', url: `${API}/tools/outcome/record?chat_id={{chat_id}}` }] }));
    const { svc } = toolsSetup();
    await svc.refreshUrls({ apiKey: 'key_api', llmId: 'llm_1', smsLlmId: 'sms_llm_1' } as any);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(bodyOf(1).general_tools[0].url).toBe(`${API}/tools/outcome/record`);
  });
});

describe('RetellToolAuthService', () => {
  const TOKEN = 'tok_1';
  const KEYS = { webhookKey: 'key_hook', apiKey: 'key_api' };
  const signed = (over: Record<string, unknown> = {}, key = KEYS.webhookKey) => {
    const rawBody = Buffer.from('{"name":"record_outcome","call":{"call_id":"call_abc"},"args":{"outcome":"not_interested"}}');
    const ts = Date.now();
    return {
      authorization: `Bearer ${TOKEN}`,
      signature: `v=${ts},d=${createHmac('sha256', key).update(Buffer.concat([rawBody, Buffer.from(String(ts))])).digest('hex')}`,
      rawBody,
      callId: 'call_abc',
      chatId: undefined,
      ...over,
    };
  };
  const authSetup = (opts: { call?: Record<string, unknown> | null; chat?: Record<string, unknown> | null; hash?: string | null } = {}) => {
    const prisma = {
      call: { findFirst: vi.fn(async () => (opts.call === undefined ? { id: 'call-1', orgId: ORG, leadId: 'lead-1', status: 'in_progress' } : opts.call)) },
      smsChat: { findFirst: vi.fn(async () => (opts.chat === undefined ? { id: 'chat-1', orgId: ORG, leadId: 'lead-1', status: 'ongoing' } : opts.chat)) },
    };
    const creds = { getCreds: vi.fn(async () => KEYS) };
    const auth = new RetellToolAuthService(prisma as any, creds as any, { get: () => 'test' } as any);
    const hashFor = vi.fn(async () => (opts.hash === undefined ? sha256Hex(TOKEN) : opts.hash));
    return { auth, hashFor, prisma };
  };

  it('admits a live Retell call with our token and Retell’s signature, taking org and lead from the call', async () => {
    const { auth, hashFor } = authSetup();
    await expect(auth.verify(signed(), 'call outcome', hashFor)).resolves.toEqual({ orgId: ORG, leadId: 'lead-1', callId: 'call-1', provider: 'retell' });
    expect(hashFor).toHaveBeenCalledWith(ORG);
  });

  it('admits an ongoing Retell text chat named in the tool URL, with either workspace key signing', async () => {
    const { auth, hashFor, prisma } = authSetup();
    await expect(auth.verify(signed({ callId: undefined, chatId: 'chat_xyz' }, KEYS.apiKey), 'call outcome', hashFor)).resolves.toEqual({ orgId: ORG, leadId: 'lead-1', callId: null, provider: 'retell' });
    expect(prisma.smsChat.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { provider: 'retell', providerChatId: 'chat_xyz' } }));
  });

  it.each([
    ['no bearer token', authSetup(), signed({ authorization: undefined })],
    ['no call id', authSetup(), signed({ callId: undefined })],
    ['no call id', authSetup(), signed({ callId: undefined, chatId: '{{chat_id}}' })],
    ['unknown call', authSetup({ call: null }), signed()],
    ['unknown chat', authSetup({ chat: null }), signed({ callId: undefined, chatId: 'chat_xyz' })],
    ['call outcome tools are off for org-1', authSetup({ hash: null }), signed()],
    ['bad token', authSetup(), signed({ authorization: 'Bearer nope' })],
    ['call call-1 is completed, not live', authSetup({ call: { id: 'call-1', orgId: ORG, leadId: 'lead-1', status: 'completed' } }), signed()],
    ['chat chat-1 is ended, not ongoing', authSetup({ chat: { id: 'chat-1', orgId: ORG, leadId: 'lead-1', status: 'ended' } }), signed({ callId: undefined, chatId: 'chat_xyz' })],
    ['bad Retell signature', authSetup(), signed({}, 'someone_else')],
  ])('refuses: %s', async (why, { auth, hashFor }, request) => {
    await expect(auth.verify(request, 'call outcome', hashFor)).rejects.toThrow(`Not authorized: ${why}`);
  });
});
