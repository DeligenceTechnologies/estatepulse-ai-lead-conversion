import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TelnyxWebhookController } from './telnyx-webhook.controller';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
// The portal shows the raw 32-byte key, base64 — the last 32 bytes of the SPKI DER.
const portalKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');

const ORG = 'org-1';
const OUR_CALL = 'ccid-we-placed';
const CHAT_LOG = 'Us: Still looking? | Lead: Yes, north side only';
const LAST_TEXT = 'Still looking?';

const controller = (savedKey: string): TelnyxWebhookController =>
  new TelnyxWebhookController(
    {
      callByProvider: async (ccid: string) => (ccid === OUR_CALL ? { orgId: ORG, leadId: 'lead-1' } : null),
      leadVariables: async () => ({ firstName: 'Dana', recent_sms: CHAT_LOG, last_outbound_sms: LAST_TEXT }),
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

const ask = (savedKey: string, over: Record<string, unknown> = {}, signed = false) => {
  const body = event(over);
  return controller(savedKey).assistantVariables(body, request(body, signed));
};

const onCall = { call_control_id: OUR_CALL, telnyx_conversation_channel: 'phone_call' };

describe('Telnyx webhooks are acted on only when signed', () => {
  it('drops an unsigned event for an account with a saved key', async () => {
    expect(await ask(portalKey)).toEqual({});
  });

  it('drops an unsigned event naming nothing we created, key saved or not', async () => {
    expect(await ask('')).toEqual({});
  });

  it('takes a signed event', async () => {
    expect((await ask(portalKey, {}, true)).dynamic_variables?.firstName).toBe('Dana');
  });

  it('takes an unsigned event for a call we placed, until a key is saved', async () => {
    expect((await ask('', onCall)).dynamic_variables?.firstName).toBe('Dana');
  });

  it('drops that same call event once a key is saved and the signature is wrong', async () => {
    expect(await ask(portalKey, onCall)).toEqual({});
  });
});

describe('the assistant is told only the chat context its own channel reads', () => {
  it('never hands a text chat the raw chat log', async () => {
    const v = (await ask(portalKey, {}, true)).dynamic_variables;
    expect(v?.recent_sms).toBe('');
    // The text the lead is replying to is what the chat prompt actually reads.
    expect(v?.last_outbound_sms).toBe(LAST_TEXT);
  });

  it('gives a call the chat so far, and not the text being replied to', async () => {
    const v = (await ask('', onCall)).dynamic_variables;
    expect(v?.recent_sms).toBe(CHAT_LOG);
    expect(v?.last_outbound_sms).toBe('');
  });

  it('sends neither on a channel it does not know', async () => {
    const v = (await ask(portalKey, { telnyx_conversation_channel: 'web_chat' }, true)).dynamic_variables;
    expect(v?.recent_sms).toBe('');
    expect(v?.last_outbound_sms).toBe('');
  });
});

/** The messaging webhook, with an inbound service that records what it was asked to do. */
const texts = (savedKey: string, done: string[], known: boolean): TelnyxWebhookController =>
  new TelnyxWebhookController(
    {} as any,
    {
      onMessageReceived: async () => void done.push('inbound text stored'),
      onMessageFinalized: async () => void done.push('receipt applied'),
    } as any,
    {} as any,
    { getCreds: async () => ({ publicKey: savedKey }), orgForNumber: async () => ORG } as any,
    // `known` is whether the event's message id is one we already have: true is the forger's best case.
    { message: { findFirst: async () => (known ? { id: 'our-text' } : null) } } as any,
    {} as any,
  );

const textEvent = (event_type: string) => ({
  data: {
    event_type,
    payload: { id: 'telnyx-msg-1', text: 'STOP', to: [{ phone_number: '+12025550123', status: 'delivered' }], from: { phone_number: '+12025550199' } },
  },
});

/** The handler answers 200 at once and works in the background, so let that finish before looking. */
const deliver = async (savedKey: string, event_type: string, { signed = false, known = true } = {}): Promise<string[]> => {
  const done: string[] = [];
  const body = textEvent(event_type);
  texts(savedKey, done, known).messaging(body, request(body, signed));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return done;
};

describe('an inbound text is acted on only when Telnyx signed it', () => {
  it('ignores an unsigned one, even wearing the id of a text we sent', async () => {
    expect(await deliver('', 'message.received')).toEqual([]);
    expect(await deliver(portalKey, 'message.received')).toEqual([]);
  });

  it('stores a signed one', async () => {
    expect(await deliver(portalKey, 'message.received', { signed: true })).toEqual(['inbound text stored']);
  });

  it('still applies an unsigned receipt for a text we sent, until a key is saved', async () => {
    expect(await deliver('', 'message.finalized')).toEqual(['receipt applied']);
    expect(await deliver(portalKey, 'message.finalized')).toEqual([]);
  });

  // A finalized text whose id we do not have is stored as the AI's own message in the lead's
  // chat, so it must never arrive unsigned — whatever the account's key state.
  it('ignores an unsigned text of an unknown id, which would be filed as the AI speaking', async () => {
    expect(await deliver('', 'message.finalized', { known: false })).toEqual([]);
    expect(await deliver(portalKey, 'message.finalized', { known: false })).toEqual([]);
  });

  it('files one Telnyx signed', async () => {
    expect(await deliver(portalKey, 'message.finalized', { signed: true, known: false })).toEqual(['receipt applied']);
  });
});
