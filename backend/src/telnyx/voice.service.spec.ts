import { afterEach, describe, expect, it, vi } from 'vitest';
import { telnyx } from './telnyx-api';
import { VoiceService } from './voice.service';

vi.mock('./telnyx-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./telnyx-api')>()),
  telnyx: vi.fn(async () => ({ data: { call_control_id: 'cc-1' } })),
}));

/** The assistant starts from our call.answered webhook, so a call is never dialed while Telnyx cannot reach us. */
describe('VoiceService webhook reachability', () => {
  afterEach(() => vi.unstubAllGlobals());

  const make = (publicUrl: string) => {
    vi.mocked(telnyx).mockClear();
    const creds = {
      getCreds: vi.fn(async () => ({ apiKey: 'KEY', fromNumber: '+17427245092' })),
      ensureConnectionId: vi.fn(async () => 'conn-1'),
      keyAccepted: vi.fn(async () => undefined),
      keyRejected: vi.fn(async () => undefined),
    };
    const voicemail = { settings: vi.fn(async () => ({ detect: false, enabled: true, message: 'hi' })) };
    return new VoiceService(creds as any, { get: vi.fn(() => publicUrl) } as any, voicemail as any);
  };
  const dial = (voice: VoiceService) => voice.placeCall('org-1', '+12895550100', { leadId: 'lead-1', orgId: 'org-1' });

  it('dials once the public health route answers, and reuses that answer', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const voice = make('https://api.example.com/');
    await dial(voice);
    await dial(voice);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('https://api.example.com/health', expect.anything());
    expect(telnyx).toHaveBeenCalledTimes(2);
  });

  it('does not dial when the tunnel is down or the URL is not set', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 530 })));
    await expect(dial(make('https://dead.trycloudflare.com'))).rejects.toThrow(/^Webhook unreachable: .*530/);
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))));
    await expect(dial(make('https://dead.trycloudflare.com'))).rejects.toThrow(/^Webhook unreachable: .*fetch failed/);
    await expect(dial(make(''))).rejects.toThrow(/^Webhook unreachable: PUBLIC_API_URL is not set/);
    expect(telnyx).not.toHaveBeenCalled();
  });
});
