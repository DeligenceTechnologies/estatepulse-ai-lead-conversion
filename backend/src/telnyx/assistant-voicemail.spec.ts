import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantService } from './assistant.service';
import { DEFAULT_VOICEMAIL_MESSAGE } from './strategy-store.service';

/**
 * "Detect voicemail" on the AI Settings screen. An office that never saved the setting keeps
 * its assistant's own Telnyx-side detection, and sees it on the screen; only the owner's own
 * change moves voicemail handling to the call. An unrelated save changes nothing on either side.
 */

const ORG = 'org-1';

/** The assistant as Telnyx returns it, with its own voicemail detection on or off. */
const assistant = (voicemail: Record<string, unknown> | null) => ({
  id: 'a-1',
  name: 'Agent',
  model: 'm',
  telephony_settings: { time_limit_secs: 900, ...(voicemail ? { voicemail_detection: voicemail } : {}) },
});

function setup(opts: { assistantVoicemail: Record<string, unknown> | null; saved?: Record<string, unknown> }) {
  const patches: any[] = [];
  let raw = assistant(opts.assistantVoicemail);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'PATCH') {
        const body = JSON.parse(init.body!);
        patches.push(body);
        raw = { ...raw, ...body, telephony_settings: body.telephony_settings ?? raw.telephony_settings };
      }
      return { ok: true, json: async () => ({ data: raw }), text: async () => '' };
    }),
  );
  const creds = { getCreds: vi.fn().mockResolvedValue({ apiKey: 'KEY', assistantId: 'a-1' }) };
  const prisma = { organizationSetting: { findUnique: vi.fn().mockResolvedValue({ callRecordingEnabled: true }), updateMany: vi.fn() } };
  const strategy = { name: 'S', guardrails: { maxVoiceAttempts: 3, ...(opts.saved ? { voicemail: opts.saved } : {}) }, steps: [] };
  const strategies = { getStrategy: vi.fn().mockResolvedValue(strategy), saveStrategy: vi.fn().mockResolvedValue(strategy) };
  const service = new AssistantService(creds as any, prisma as any, strategies as any);
  return { service, patches, strategies, assistantLevel: () => patches.at(-1)?.telephony_settings?.voicemail_detection };
}

describe('AssistantService "Detect voicemail"', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('an office that never saved the setting sees its assistant\'s own detection, as it is', async () => {
    const on = await setup({ assistantVoicemail: { action: 'leave_message' } }).service.getAssistant(ORG);
    expect(on).toEqual(expect.objectContaining({ voicemail_detection: true, voicemail_action: 'leave_message', voicemail_message: DEFAULT_VOICEMAIL_MESSAGE }));
    const off = await setup({ assistantVoicemail: null }).service.getAssistant(ORG);
    expect(off).toEqual(expect.objectContaining({ voicemail_detection: false, voicemail_action: 'hangup' }));
  });

  it('a saved setting is what the screen shows, whatever the assistant has', async () => {
    const { service } = setup({ assistantVoicemail: { action: 'leave_message' }, saved: { detect: false, action: 'hangup', message: 'x' } });
    expect(await service.getAssistant(ORG)).toEqual(expect.objectContaining({ voicemail_detection: false, voicemail_action: 'hangup', voicemail_message: 'x' }));
  });

  it('an unrelated save leaves the assistant\'s detection on and saves no setting', async () => {
    const { service, patches, strategies } = setup({ assistantVoicemail: { action: 'hangup' } });
    await service.updateAssistant(ORG, { greeting: 'Hello there' });
    expect(patches).toEqual([{ greeting: 'Hello there' }]);
    expect(strategies.saveStrategy).not.toHaveBeenCalled();
  });

  it('the screen sending back what it showed (the whole form) is not a change either', async () => {
    const { service, patches, strategies, assistantLevel } = setup({ assistantVoicemail: { action: 'leave_message' } });
    const shown = await service.getAssistant(ORG);
    await service.updateAssistant(ORG, {
      greeting: 'Hi',
      max_call_secs: 1200,
      voicemail_detection: shown!.voicemail_detection,
      voicemail_action: shown!.voicemail_action,
      voicemail_message: shown!.voicemail_message,
    });
    expect(patches).toHaveLength(1);
    expect(assistantLevel()).toEqual({ action: 'leave_message' });
    expect(strategies.saveStrategy).not.toHaveBeenCalled();
  });

  it('the owner turning the toggle off: the assistant\'s detection is switched off and the setting saved', async () => {
    const { service, strategies, assistantLevel } = setup({ assistantVoicemail: { action: 'hangup' } });
    const result = await service.updateAssistant(ORG, { voicemail_detection: false, voicemail_action: 'hangup', voicemail_message: DEFAULT_VOICEMAIL_MESSAGE });
    expect(assistantLevel()).toBeNull();
    expect(strategies.saveStrategy).toHaveBeenCalledWith(ORG, {
      guardrails: { maxVoiceAttempts: 3, voicemail: { detect: false, action: 'hangup', message: DEFAULT_VOICEMAIL_MESSAGE } },
    });
    expect(result).toEqual(expect.objectContaining({ voicemail_detection: false }));
  });

  it('the owner turning it on, or picking the message, moves voicemail to the call: saved, assistant detection off', async () => {
    const { service, strategies, assistantLevel } = setup({ assistantVoicemail: null });
    await service.updateAssistant(ORG, { voicemail_detection: true, voicemail_action: 'leave_message', voicemail_message: '  Hi {{firstName}}  ' });
    expect(assistantLevel()).toBeNull();
    expect(strategies.saveStrategy).toHaveBeenCalledWith(ORG, {
      guardrails: { maxVoiceAttempts: 3, voicemail: { detect: true, action: 'leave_message', message: 'Hi {{firstName}}' } },
    });
  });

  it('when the setting cannot be saved, nothing is sent to Telnyx: the assistant keeps its own detection', async () => {
    const { service, patches, strategies } = setup({ assistantVoicemail: { action: 'hangup' } });
    strategies.saveStrategy.mockRejectedValue(new Error('database unreachable'));
    await expect(
      service.updateAssistant(ORG, { voicemail_detection: false, voicemail_action: 'hangup', voicemail_message: DEFAULT_VOICEMAIL_MESSAGE }),
    ).rejects.toThrow(/database unreachable/);
    expect(patches).toEqual([]);
  });

  it("an assistant's own detection as Telnyx stores it (on_voicemail_detected): the action and the message it leaves are shown as they are", async () => {
    const leaves = {
      on_voicemail_detected: { action: 'leave_message_and_stop_assistant', voicemail_message: { type: 'message', message: 'Hi, Acme here. Call us back.' } },
    };
    expect(await setup({ assistantVoicemail: leaves }).service.getAssistant(ORG)).toEqual(
      expect.objectContaining({ voicemail_detection: true, voicemail_action: 'leave_message', voicemail_message: 'Hi, Acme here. Call us back.' }),
    );
    const stops = { on_voicemail_detected: { action: 'stop_assistant' } };
    expect(await setup({ assistantVoicemail: stops }).service.getAssistant(ORG)).toEqual(
      expect.objectContaining({ voicemail_detection: true, voicemail_action: 'hangup', voicemail_message: DEFAULT_VOICEMAIL_MESSAGE }),
    );
    // A prompted message has no fixed text to show.
    const prompted = { on_voicemail_detected: { action: 'leave_message_and_stop_assistant', voicemail_message: { type: 'prompt', prompt: 'Be brief' } } };
    expect(await setup({ assistantVoicemail: prompted }).service.getAssistant(ORG)).toEqual(
      expect.objectContaining({ voicemail_action: 'leave_message', voicemail_message: DEFAULT_VOICEMAIL_MESSAGE }),
    );
  });
});
