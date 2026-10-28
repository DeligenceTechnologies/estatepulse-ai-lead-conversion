import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@/common/utils/crypto';
import { BOOKING_PROMPT_START } from './booking-prompt';
import { InCallBookingSettingsService } from './in-call-booking-settings.service';
import { ToolAuthService, type RetellToolRequest } from './tool-auth.service';

/** In-call booking on a Retell agent: custom functions on its LLM, calling the neutral /tools/booking URL. */

const ORG = 'org-1';
const TOKEN = 'tok_retell_1';
const config = { eventTypeUri: 'et-1', eventTypeName: 'Consultation', durationMinutes: 30, tokenHash: sha256Hex(TOKEN), provider: 'retell', llmId: 'llm_1' };
const keys = { webhookKey: 'key_hook', apiKey: 'key_api' };

function signedRequest(over: Partial<RetellToolRequest> = {}, key = keys.webhookKey): RetellToolRequest {
  const rawBody = Buffer.from('{"name":"check_availability","call":{"call_id":"call_abc"},"args":{}}');
  const ts = Date.now();
  return {
    authorization: `Bearer ${TOKEN}`,
    signature: `v=${ts},d=${createHmac('sha256', key).update(Buffer.concat([rawBody, Buffer.from(String(ts))])).digest('hex')}`,
    rawBody,
    callId: 'call_abc',
    ...over,
  };
}

function authSetup(opts: { call?: Record<string, unknown> | null; config?: unknown } = {}) {
  const call = opts.call === undefined ? { id: 'call-1', orgId: ORG, leadId: 'lead-1', status: 'in_progress' } : opts.call;
  const prisma = { call: { findFirst: vi.fn().mockResolvedValue(call) } };
  const settings = { activeConfig: vi.fn().mockResolvedValue(opts.config === undefined ? config : opts.config) };
  const retellCreds = { getCreds: vi.fn().mockResolvedValue(keys) };
  const auth = new ToolAuthService({} as any, settings as any, prisma as any, retellCreds as any, { get: () => 'test' } as any);
  return { auth, prisma };
}

describe('ToolAuthService.verifyRetell', () => {
  it('admits a live Retell call with our token and a Retell signature, taking org and lead from the call', async () => {
    const { auth, prisma } = authSetup();
    await expect(auth.verifyRetell(signedRequest())).resolves.toEqual({ orgId: ORG, leadId: 'lead-1', callId: 'call-1', config });
    expect(prisma.call.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { providerCallId: 'call_abc', provider: 'retell' } }));
  });

  it('accepts a signature made with the API key too, since the docs disagree on which key signs tool calls', async () => {
    await expect(authSetup().auth.verifyRetell(signedRequest({}, keys.apiKey))).resolves.toMatchObject({ callId: 'call-1' });
  });

  it.each([
    ['no bearer token', authSetup(), signedRequest({ authorization: undefined })],
    ['no call id', authSetup(), signedRequest({ callId: undefined })],
    ['unknown call', authSetup({ call: null }), signedRequest()],
    ['in-call booking is off on Retell', authSetup({ config: { ...config, provider: undefined } }), signedRequest()],
    ['bad token', authSetup(), signedRequest({ authorization: 'Bearer nope' })],
    ['call call-1 is completed, not live', authSetup({ call: { id: 'call-1', orgId: ORG, leadId: 'lead-1', status: 'completed' } }), signedRequest()],
    ['bad Retell signature', authSetup(), signedRequest({}, 'someone_else')],
  ])('refuses: %s', async (why, { auth }, request) => {
    await expect(auth.verifyRetell(request)).rejects.toThrow(`Not authorized: ${why}`);
  });
});

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });

function settingsSetup(calling: 'telnyx' | 'retell' = 'retell', telnyxCreds: Record<string, unknown> | null = null) {
  let stored: unknown = null;
  const prisma = {
    organizationSetting: {
      findUnique: vi.fn(async () => ({ inCallBooking: stored })),
      upsert: vi.fn(async ({ update }: { update: { inCallBooking: unknown } }) => {
        stored = update.inCallBooking;
      }),
    },
    calendarConnection: { findFirst: vi.fn().mockResolvedValue({ id: 'conn-1', provider: 'calendly', scope: 'default' }) },
    calendarMeeting: { findMany: vi.fn().mockResolvedValue([]) },
    calendarMember: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const access = { useActive: vi.fn().mockResolvedValue([{ id: 'et-1', name: 'Consultation', durationMinutes: 30, poolingType: 'round_robin' }]) };
  const svc = new InCallBookingSettingsService(
    prisma as any,
    { getCreds: vi.fn().mockResolvedValue(telnyxCreds) } as any,
    access as any,
    {} as any,
    { get: () => 'https://api.example.com/' } as any,
    { nameFor: vi.fn().mockResolvedValue(calling) } as any,
    { getCreds: vi.fn().mockResolvedValue({ apiKey: 'key_api', agentId: 'agent_1', llmId: 'llm_1' }) } as any,
  );
  return { svc, stored: () => stored as Record<string, unknown> };
}

describe('InCallBookingSettingsService on Retell', () => {
  it('adds the two custom functions and the booking prompt to the agent’s Retell LLM, keeping its own tools', async () => {
    fetchMock.mockResolvedValueOnce(json({ general_prompt: 'Base prompt', general_tools: [{ type: 'end_call', name: 'end_call' }, { type: 'custom', name: 'check_availability', url: 'old' }] }));
    fetchMock.mockResolvedValueOnce(json({}));
    const { svc, stored } = settingsSetup();
    const st = await svc.enable(ORG, 'et-1');

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://api.retellai.com/update-retell-llm/llm_1');
    expect(init.method).toBe('PATCH');
    const body = JSON.parse(String(init.body));
    expect(body.general_prompt).toContain('Base prompt');
    expect(body.general_prompt).toContain(BOOKING_PROMPT_START);
    expect(body.general_tools.map((t: any) => [t.name, t.url])).toEqual([
      ['end_call', undefined],
      ['check_availability', 'https://api.example.com/tools/booking/availability'],
      ['book_appointment', 'https://api.example.com/tools/booking/book'],
    ]);
    const token = /^Bearer (.+)$/.exec(body.general_tools[1].headers.Authorization)![1];
    expect(body.general_tools[1]).toMatchObject({ type: 'custom', method: 'POST', speak_during_execution: true, execution_message_type: 'static_text', parameters: { type: 'object' } });
    expect(stored()).toMatchObject({ provider: 'retell', llmId: 'llm_1', tokenHash: sha256Hex(token), eventTypeName: 'Consultation' });
    expect(st.voice).toEqual({ provider: 'retell', connected: true, hasAgent: true });
  });

  it('disabling takes our tools and the prompt section off the Retell LLM and nothing else', async () => {
    fetchMock.mockResolvedValueOnce(json({ general_prompt: 'Base prompt', general_tools: [] })).mockResolvedValueOnce(json({}));
    const { svc } = settingsSetup();
    await svc.enable(ORG, 'et-1');
    const enabledBody = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(json({ ...enabledBody, general_tools: [{ type: 'end_call', name: 'end_call' }, ...enabledBody.general_tools] })).mockResolvedValueOnce(json({}));
    await svc.disable(ORG);
    const body = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(body.general_tools).toEqual([{ type: 'end_call', name: 'end_call' }]);
    expect(body.general_prompt).toBe('Base prompt');
  });

  it('an organization on Telnyx still needs its Telnyx assistant, as before', async () => {
    const { svc } = settingsSetup('telnyx', { apiKey: 'KEY', assistantId: '' });
    await expect(svc.enable(ORG, 'et-1')).rejects.toThrow('Connect Telnyx and create the AI assistant first.');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
