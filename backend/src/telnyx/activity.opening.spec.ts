import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityService } from './activity.service';

/**
 * The lead speaks first on an AI call: the assistant starts on their first
 * words, or after AI_OPENING_WAIT_MS of silence — exactly once either way.
 */
describe('ActivityService call opening', () => {
  const plan = { apiKey: 'KEY', assistantId: 'assistant-1', record: false, variables: { first_name: 'Ana' } };
  let actions: string[];
  let service: ActivityService;

  const make = (waitMs: number) => {
    const config = { get: vi.fn(() => waitMs) };
    const prisma = { call: { findFirst: vi.fn(async () => null) } };
    return new ActivityService(prisma as any, {} as any, {} as any, {} as any, {} as any, config as any);
  };
  const attach = (s: ActivityService) => (s as any).attach('cc-1', plan) as Promise<void>;
  const flush = () => new Promise((r) => setImmediate(r));

  beforeEach(() => {
    actions = [];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      actions.push(String(url).split('/actions/')[1]);
      return { ok: true, text: async () => '' };
    }));
    service = make(5000);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('listens first instead of starting the assistant', async () => {
    await attach(service);
    expect(actions).toEqual(['transcription_start']);
  });

  it('starts the assistant on the lead\'s first words, once', async () => {
    await attach(service);
    await service.onCallSpeech('cc-1', { transcription_data: { transcript: 'Hello?' } });
    await service.onCallSpeech('cc-1', { transcription_data: { transcript: 'Hello? Who is this' } });
    vi.advanceTimersByTime(6000);
    await flush();
    expect(actions.filter((a) => a === 'ai_assistant_start')).toHaveLength(1);
    expect(actions).toContain('transcription_stop');
  });

  it('ignores empty transcripts', async () => {
    await attach(service);
    await service.onCallSpeech('cc-1', { transcription_data: { transcript: '  ' } });
    expect(actions).not.toContain('ai_assistant_start');
  });

  it('starts the assistant by itself after the silence window', async () => {
    await attach(service);
    vi.advanceTimersByTime(4999);
    await flush();
    expect(actions).not.toContain('ai_assistant_start');
    vi.advanceTimersByTime(1);
    await flush();
    expect(actions.filter((a) => a === 'ai_assistant_start')).toHaveLength(1);
  });

  it('never starts the assistant once the call has hung up', async () => {
    await attach(service);
    await service.onCallHangup('cc-1');
    vi.advanceTimersByTime(6000);
    await flush();
    expect(actions).not.toContain('ai_assistant_start');
  });

  it('starts at once when the wait is switched off (0)', async () => {
    await attach(make(0));
    expect(actions).toEqual(['ai_assistant_start']);
  });
});
