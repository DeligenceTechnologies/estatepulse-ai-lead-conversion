import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmsService } from './sms.service';
import { VoiceService } from './voice.service';

/** Characterization: the exact Telnyx requests a call and a text make today. */

const ORG = 'org-1';
const creds = (over: Record<string, unknown> = {}) => ({
  getCreds: vi.fn().mockResolvedValue({ apiKey: 'KEY123', fromNumber: '+12025550100', connectionId: 'conn-1', ...over }),
  ensureConnectionId: vi.fn().mockResolvedValue('conn-1'),
  keyAccepted: vi.fn().mockResolvedValue(undefined),
  keyRejected: vi.fn().mockResolvedValue(undefined),
});
/** The organization's voicemail setting: detection off, so the dial carries no AMD. */
const amd = () => ({ settings: vi.fn().mockResolvedValue({ detect: false }) });
const config = (publicUrl?: string) => ({ get: vi.fn(() => publicUrl) });
const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(ok({ call_control_id: 'cc-1' }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const sent = () => {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url, init, body: JSON.parse(String(init.body)) };
};

describe('VoiceService.placeCall', () => {
  it('posts one Call Control dial with the lead in client_state and our webhook URL', async () => {
    const voice = new VoiceService(creds() as any, config('https://api.example.com/') as any, amd() as any);
    const res = await voice.placeCall(ORG, '+12895550111', { leadId: 'lead-1', orgId: ORG });

    expect(res).toEqual({ call_control_id: 'cc-1' });
    const { url, init, body } = sent();
    expect(url).toBe('https://api.telnyx.com/v2/calls');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: 'Bearer KEY123', 'Content-Type': 'application/json' });
    expect(body).toEqual({
      connection_id: 'conn-1',
      to: '+12895550111',
      from: '+12025550100',
      timeout_secs: 60,
      client_state: Buffer.from(JSON.stringify({ leadId: 'lead-1', orgId: ORG, amd: false })).toString('base64'),
      webhook_url: 'https://api.example.com/webhooks/telnyx/voice',
    });
  });

  it('leaves webhook_url out when PUBLIC_API_URL is not set', async () => {
    const voice = new VoiceService(creds() as any, config(undefined) as any, amd() as any);
    await voice.placeCall(ORG, '+12895550111', { leadId: 'lead-1', orgId: ORG, sequenceId: 'seq-1' });
    const { body } = sent();
    expect(body).not.toHaveProperty('webhook_url');
    expect(JSON.parse(Buffer.from(body.client_state, 'base64').toString())).toEqual({ leadId: 'lead-1', orgId: ORG, sequenceId: 'seq-1', amd: false });
  });

  it('refuses without a key, a from-number or a Call Control app, and never dials', async () => {
    const noKey = { ...creds(), getCreds: vi.fn().mockResolvedValue(null) };
    await expect(new VoiceService(noKey as any, config() as any, amd() as any).placeCall(ORG, '+1', {})).rejects.toThrow('No provider connected');
    await expect(new VoiceService(creds({ fromNumber: '' }) as any, config() as any, amd() as any).placeCall(ORG, '+1', {})).rejects.toThrow(
      'No from number configured',
    );
    const noApp = { ...creds(), ensureConnectionId: vi.fn().mockResolvedValue('') };
    await expect(new VoiceService(noApp as any, config() as any, amd() as any).placeCall(ORG, '+1', {})).rejects.toThrow('No Call Control application');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a Telnyx rejection with its status, which the call worker reads for capacity', async () => {
    fetchMock.mockResolvedValue(new Response('{"errors":[{"detail":"too many"}]}', { status: 429 }));
    const voice = new VoiceService(creds() as any, config() as any, amd() as any);
    await expect(voice.placeCall(ORG, '+12895550111', {})).rejects.toThrow('Telnyx POST /calls failed 429');
  });
});

describe('SmsService.sendSms', () => {
  it('posts the text from the org number and returns the message id', async () => {
    fetchMock.mockResolvedValue(ok({ id: 'msg-1' }));
    const res = await new SmsService(creds() as any).sendSms(ORG, '+12895550111', 'Hi Asha');
    expect(res).toEqual({ id: 'msg-1' });
    const { url, init, body } = sent();
    expect(url).toBe('https://api.telnyx.com/v2/messages');
    expect(init.method).toBe('POST');
    expect(body).toEqual({ from: '+12025550100', to: '+12895550111', text: 'Hi Asha' });
  });

  it('refuses without a key or a from-number', async () => {
    await expect(new SmsService({ getCreds: vi.fn().mockResolvedValue(null) } as any).sendSms(ORG, '+1', 'x')).rejects.toThrow('No provider connected');
    await expect(new SmsService(creds({ fromNumber: '' }) as any).sendSms(ORG, '+1', 'x')).rejects.toThrow('No from number configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
