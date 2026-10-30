import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callIntent } from '../calls/call.types';
import { ActivityService } from '../activity.service';
import { AssistantService } from '../assistant.service';
import { telnyx } from '../telnyx-api';
import { VoiceService } from '../voice.service';
import { voicemailSettings } from './voicemail';

vi.mock('../telnyx-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../telnyx-api')>()),
  telnyx: vi.fn(async () => ({ data: { call_control_id: 'cc-1' } })),
}));

/**
 * Answering-machine detection is the organization's choice: on by default, and
 * off it costs nothing. The Voicemail setting is the only place that decides,
 * so the assistant's own voicemail handling is switched off.
 */
describe('answering-machine detection as an organization setting', () => {
  it('is on unless the organization turned it off', () => {
    expect(voicemailSettings(null).detect).toBe(true);
    expect(voicemailSettings({ detect: false }).detect).toBe(false);
    expect(voicemailSettings({ enabled: false })).toMatchObject({ detect: true, enabled: false });
  });

  const dial = async (detect: boolean) => {
    vi.mocked(telnyx).mockClear();
    const creds = {
      getCreds: vi.fn(async () => ({ apiKey: 'KEY', fromNumber: '+17427245092' })),
      ensureConnectionId: vi.fn(async () => 'conn-1'),
      keyAccepted: vi.fn(async () => undefined),
      keyRejected: vi.fn(async () => undefined),
    };
    const voicemail = { settings: vi.fn(async () => ({ detect, enabled: true, message: 'hi' })) };
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const voice = new VoiceService(creds as any, { get: vi.fn(() => 'https://api.example.com') } as any, voicemail as any);
    await voice.placeCall('org-1', '+12895550100', { leadId: 'lead-1', orgId: 'org-1' });
    vi.unstubAllGlobals();
    const body = JSON.parse(String((vi.mocked(telnyx).mock.calls[0][2] as any).body));
    return { body, state: callIntent(body.client_state) };
  };

  it('on: the call is dialed with premium detection', async () => {
    const { body, state } = await dial(true);
    expect(body.answering_machine_detection).toBe('premium');
    expect(state.amd).toBeUndefined();
  });

  it('off: no detection is asked for (nothing is charged), and the webhooks are told so', async () => {
    const { body, state } = await dial(false);
    expect(body).not.toHaveProperty('answering_machine_detection');
    expect(state.amd).toBe(false);
  });
});

describe('opening a call dialed without detection', () => {
  let actions: string[];
  beforeEach(() => {
    actions = [];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      actions.push(String(url).split('/actions/')[1]);
      return { ok: true, status: 200, text: async () => '' };
    }));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('starts the assistant at once: no verdict is coming to wait for', async () => {
    const service = new ActivityService({} as any, {} as any, {} as any, {} as any, {} as any, { get: vi.fn(() => 5000) } as any, {} as any, {} as any, {} as any);
    const plan = { apiKey: 'KEY', assistantId: 'assistant-1', record: false, variables: {} };
    await (service as any).attach('cc-1', plan, false);
    expect(actions).toEqual(['ai_assistant_start']);
  });
});

describe("the assistant's own voicemail handling", () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is switched off, so only the Voicemail setting decides what a call does on a machine', async () => {
    const calls: { method: string; body?: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
      calls.push({ method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined });
      const assistant = { tools: [{ type: 'hangup' }], telephony_settings: { time_limit_secs: 1800, voicemail_detection: { action: 'hangup' } } };
      return { ok: true, status: 200, json: async () => ({ data: assistant }), text: async () => '' };
    }));
    const creds = { getCreds: vi.fn(async () => ({ apiKey: 'KEY', assistantId: 'assistant-1' })) };
    await new AssistantService(creds as any, {} as any, {} as any).ensureCallSetup('org-1');
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.body.telephony_settings).toEqual({ time_limit_secs: 1800, voicemail_detection: null });
  });
});
