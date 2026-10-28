import { generateKeyPairSync, sign } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TelnyxWebhookController } from './telnyx-webhook.controller';

/** Characterization: which Telnyx event reaches which handler, and when a delivery is ignored. */

const ORG = 'org-1';
const CCID = 'v3:cc-1';

const keys = generateKeyPairSync('ed25519');
const PUBLIC_KEY = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');

function request(body: unknown, signed: 'none' | 'good' | 'bad' = 'none') {
  const rawBody = Buffer.from(JSON.stringify(body));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature =
    signed === 'none' ? undefined : signed === 'good' ? sign(null, Buffer.concat([Buffer.from(`${timestamp}|`), rawBody]), keys.privateKey).toString('base64') : 'AAAA';
  const headers: Record<string, string | undefined> = { 'telnyx-signature-ed25519': signature, 'telnyx-timestamp': timestamp };
  return { header: (name: string) => headers[name], rawBody } as any;
}

function setup(publicKey = '') {
  const activity = {
    callByProvider: vi.fn().mockResolvedValue({ id: 'call-1', orgId: ORG }),
    onCallAnswered: vi.fn(),
    onCallHangup: vi.fn(),
    onRecordingSaved: vi.fn(),
    onTranscriptionSaved: vi.fn(),
  };
  const inbound = { onMessageReceived: vi.fn() };
  const scoring = { onTranscriptSaved: vi.fn(), onInsightsGenerated: vi.fn() };
  const creds = { getCreds: vi.fn().mockResolvedValue({ publicKey }), orgForNumber: vi.fn().mockResolvedValue(ORG) };
  const callbacks = { onCallEnded: vi.fn() };
  const controller = new TelnyxWebhookController(activity as any, inbound as any, scoring as any, creds as any, {} as any, callbacks as any);
  return { controller, activity, inbound, scoring, creds };
}

const voiceEvent = (event_type: string, payload: Record<string, unknown> = {}) => ({ data: { event_type, payload: { call_control_id: CCID, ...payload } } });
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('TelnyxWebhookController voice', () => {
  beforeEach(() => vi.clearAllMocks());

  it('routes every call event to its handler', async () => {
    const { controller, activity, scoring } = setup();
    for (const type of ['call.answered', 'call.hangup', 'call.recording.saved', 'call.recording.transcription.saved', 'call.conversation_insights.generated']) {
      expect(controller.voice(voiceEvent(type, { hangup_cause: 'normal_clearing' }), request({}))).toEqual({ received: true });
    }
    await settle();
    expect(activity.onCallAnswered).toHaveBeenCalledWith(CCID, {});
    expect(activity.onCallHangup).toHaveBeenCalledWith(CCID, expect.objectContaining({ hangup_cause: 'normal_clearing' }));
    expect(activity.onRecordingSaved).toHaveBeenCalledWith(CCID, expect.objectContaining({ call_control_id: CCID }));
    expect(activity.onTranscriptionSaved).toHaveBeenCalledWith(CCID, expect.objectContaining({ call_control_id: CCID }));
    expect(scoring.onTranscriptSaved).toHaveBeenCalledWith(CCID);
    expect(scoring.onInsightsGenerated).toHaveBeenCalledWith(CCID, expect.objectContaining({ call_control_id: CCID }), {
      signature: undefined,
      timestamp: expect.any(String),
      rawBody: expect.any(Buffer),
    });
  });

  it('ignores events for calls we did not place, and bodies without a call id', async () => {
    const { controller, activity } = setup();
    activity.callByProvider.mockResolvedValue(null);
    controller.voice(voiceEvent('call.answered'), request({}));
    expect(controller.voice({ data: { event_type: 'call.answered', payload: {} } }, request({}))).toEqual({ received: true });
    expect(controller.voice(undefined, request({}))).toEqual({ received: true });
    await settle();
    expect(activity.onCallAnswered).not.toHaveBeenCalled();
  });

  it('with a saved public key, acts only on deliveries signed by it', async () => {
    const event = voiceEvent('call.answered');
    const bad = setup(PUBLIC_KEY);
    bad.controller.voice(event, request(event, 'bad'));
    const unsigned = setup(PUBLIC_KEY);
    unsigned.controller.voice(event, request(event, 'none'));
    const good = setup(PUBLIC_KEY);
    good.controller.voice(event, request(event, 'good'));
    await settle();
    expect(bad.activity.onCallAnswered).not.toHaveBeenCalled();
    expect(unsigned.activity.onCallAnswered).not.toHaveBeenCalled();
    expect(good.activity.onCallAnswered).toHaveBeenCalledWith(CCID, {});
  });

  it('without a public key, accepts unsigned deliveries', async () => {
    const { controller, activity } = setup('');
    controller.voice(voiceEvent('call.hangup'), request({}));
    await settle();
    expect(activity.onCallHangup).toHaveBeenCalled();
  });
});

describe('TelnyxWebhookController messaging', () => {
  beforeEach(() => vi.clearAllMocks());

  const received = (to: unknown) => ({ data: { event_type: 'message.received', payload: { id: 'msg-1', from: { phone_number: '+12895550111' }, to, text: 'STOP' } } });

  it('hands message.received to inbound SMS, finding the org by the normalized to-number', async () => {
    const { controller, inbound, creds } = setup();
    expect(controller.messaging(received([{ phone_number: '+1 (202) 555-0100' }]), request({}))).toEqual({ received: true });
    await settle();
    expect(creds.orgForNumber).toHaveBeenCalledWith('+12025550100');
    expect(inbound.onMessageReceived).toHaveBeenCalledWith(expect.objectContaining({ id: 'msg-1', text: 'STOP' }));
  });

  it('accepts a single to-object as well as a list', async () => {
    const { controller, creds } = setup();
    controller.messaging(received({ phone_number: '+12025550100' }), request({}));
    await settle();
    expect(creds.orgForNumber).toHaveBeenCalledWith('+12025550100');
  });

  it('ignores other messaging events and badly signed deliveries', async () => {
    const other = setup();
    other.controller.messaging({ data: { event_type: 'message.sent', payload: {} } }, request({}));
    const signed = setup(PUBLIC_KEY);
    const event = received([{ phone_number: '+12025550100' }]);
    signed.controller.messaging(event, request(event, 'bad'));
    await settle();
    expect(other.inbound.onMessageReceived).not.toHaveBeenCalled();
    expect(signed.inbound.onMessageReceived).not.toHaveBeenCalled();
  });
});
