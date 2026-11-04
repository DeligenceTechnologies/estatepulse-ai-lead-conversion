import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TelnyxWebhookController } from './telnyx-webhook.controller';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
// The portal shows the raw 32-byte key, base64 — the last 32 bytes of the SPKI DER.
const portalKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');

const ORG = 'org-1';
const OUR_CALL = 'ccid-we-placed';
const variables = { first_name: 'Dana' };

const controller = (savedKey: string): TelnyxWebhookController =>
  new TelnyxWebhookController(
    {
      callByProvider: async (ccid: string) => (ccid === OUR_CALL ? { orgId: ORG, leadId: 'lead-1' } : null),
      leadVariables: async () => ({ ...variables }),
    } as any,
    {} as any,
    {} as any,
    { getCreds: async () => ({ publicKey: savedKey }), orgForNumber: async () => ORG } as any,
    { lead: { findFirst: async () => ({ id: 'lead-1', takenOverById: null }) } } as any,
    {} as any,
  );

/** An assistant asking for a lead's details — over the phone, or in a text chat. */
const event = (over: Record<string, unknown> = {}) => ({
  data: { payload: { telnyx_conversation_channel: 'sms_chat', telnyx_agent_target: '+12025550123', telnyx_end_user_target: '+12025550199', ...over } },
});

const request = (body: unknown, signed: boolean) => {
  const rawBody = Buffer.from(JSON.stringify(body));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = signed
    ? { 'telnyx-signature-ed25519': sign(null, Buffer.concat([Buffer.from(`${timestamp}|`), rawBody]), privateKey).toString('base64'), 'telnyx-timestamp': timestamp }
    : {};
  return { header: (name: string) => headers[name.toLowerCase()], rawBody } as any;
};

describe('Telnyx webhooks are acted on only when signed', () => {
  it('drops an unsigned event for an account with a saved key', async () => {
    const body = event();
    expect(await controller(portalKey).assistantVariables(body, request(body, false))).toEqual({});
  });

  it('drops an unsigned event naming nothing we created, key saved or not', async () => {
    const body = event();
    expect(await controller('').assistantVariables(body, request(body, false))).toEqual({});
  });

  it('takes a signed event', async () => {
    const body = event();
    expect(await controller(portalKey).assistantVariables(body, request(body, true))).toEqual({ dynamic_variables: variables });
  });

  it('takes an unsigned event for a call we placed, until a key is saved', async () => {
    const body = event({ call_control_id: OUR_CALL, telnyx_conversation_channel: 'phone_call' });
    expect(await controller('').assistantVariables(body, request(body, false))).toEqual({ dynamic_variables: variables });
  });

  it('drops that same call event once a key is saved and the signature is wrong', async () => {
    const body = event({ call_control_id: OUR_CALL, telnyx_conversation_channel: 'phone_call' });
    expect(await controller(portalKey).assistantVariables(body, request(body, false))).toEqual({});
  });
});
