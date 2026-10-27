import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceService } from './voice.service';
import { telnyx } from './telnyx-api';

/** Answering machine detection is asked for only where the office turned "Detect voicemail" on: it is a per-call charge. */

vi.mock('./telnyx-api', () => ({ telnyx: vi.fn().mockResolvedValue({ data: { call_control_id: 'cc-1' } }) }));

function dial(voicemail?: Record<string, unknown>) {
  const creds = { getCreds: vi.fn().mockResolvedValue({ apiKey: 'KEY', fromNumber: '+14155550000' }), ensureConnectionId: vi.fn().mockResolvedValue('conn-1') };
  const strategies = { getStrategy: vi.fn().mockResolvedValue({ name: 'S', guardrails: voicemail ? { voicemail } : {}, steps: [] }) };
  const voice = new VoiceService(creds as any, { get: () => 'https://api.example.test' } as any, strategies as any);
  return voice.placeCall('org-1', '+14155550111', { leadId: 'lead-1' }).then(() => {
    const [, path, init] = vi.mocked(telnyx).mock.calls.at(-1)!;
    expect(path).toBe('/calls');
    return JSON.parse(String(init!.body));
  });
}

describe('VoiceService.placeCall', () => {
  beforeEach(() => vi.mocked(telnyx).mockClear());

  it('an office that never turned "Detect voicemail" on dials without any machine detection', async () => {
    const body = await dial();
    expect(body).toEqual(expect.objectContaining({ to: '+14155550111' }));
    expect(body).not.toHaveProperty('answering_machine_detection');
  });

  it('"Detect voicemail" off, explicitly, dials without it too', async () => {
    expect(await dial({ detect: false, action: 'hangup' })).not.toHaveProperty('answering_machine_detection');
  });

  it('"Detect voicemail" on asks Telnyx for premium answering machine detection', async () => {
    expect(await dial({ detect: true, action: 'hangup' })).toEqual(expect.objectContaining({ answering_machine_detection: 'premium' }));
  });
});
