import { describe, expect, it, vi } from 'vitest';
import { VoiceService } from './voice.service';
import { telnyx } from './telnyx-api';

/** Every AI call is dialed with premium answering machine detection, so a voicemail is told from a person. */

vi.mock('./telnyx-api', () => ({ telnyx: vi.fn().mockResolvedValue({ data: { call_control_id: 'cc-1' } }) }));

describe('VoiceService.placeCall', () => {
  it('asks Telnyx for premium answering machine detection', async () => {
    const creds = { getCreds: vi.fn().mockResolvedValue({ apiKey: 'KEY', fromNumber: '+14155550000' }), ensureConnectionId: vi.fn().mockResolvedValue('conn-1') };
    const voice = new VoiceService(creds as any, { get: () => 'https://api.example.test' } as any);
    await voice.placeCall('org-1', '+14155550111', { leadId: 'lead-1' });
    const [, path, init] = vi.mocked(telnyx).mock.calls[0];
    expect(path).toBe('/calls');
    expect(JSON.parse(String(init!.body))).toEqual(expect.objectContaining({ answering_machine_detection: 'premium', to: '+14155550111' }));
  });
});
