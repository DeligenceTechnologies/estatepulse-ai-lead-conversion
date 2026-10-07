import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyTelnyxSignature } from './telnyx-signature';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
// The portal shows the raw 32-byte key, base64 — the last 32 bytes of the SPKI DER.
const portalKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');

const NOW = 1_760_000_000;
const body = Buffer.from('{"data":{"event_type":"call.conversation_insights.generated"}}');
const signed = (ts: number, raw = body) =>
  sign(null, Buffer.concat([Buffer.from(`${ts}|`), raw]), privateKey).toString('base64');

describe('verifyTelnyxSignature', () => {
  it('accepts a genuine delivery', () => {
    expect(
      verifyTelnyxSignature({ publicKey: portalKey, signature: signed(NOW), timestamp: String(NOW), rawBody: body, nowSeconds: NOW }),
    ).toBe(true);
  });

  it('rejects a tampered body', () => {
    const tampered = Buffer.from(body.toString().replace('generated', 'forged'));
    expect(
      verifyTelnyxSignature({ publicKey: portalKey, signature: signed(NOW), timestamp: String(NOW), rawBody: tampered, nowSeconds: NOW }),
    ).toBe(false);
  });

  it('rejects a replay outside the tolerance window', () => {
    const old = NOW - 301;
    expect(
      verifyTelnyxSignature({ publicKey: portalKey, signature: signed(old), timestamp: String(old), rawBody: body, nowSeconds: NOW }),
    ).toBe(false);
  });

  it('rejects another key, missing headers and garbage', () => {
    const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
    const ok = { signature: signed(NOW), timestamp: String(NOW), rawBody: body, nowSeconds: NOW };
    expect(verifyTelnyxSignature({ publicKey: other, ...ok })).toBe(false);
    expect(verifyTelnyxSignature({ publicKey: portalKey, ...ok, signature: undefined })).toBe(false);
    expect(verifyTelnyxSignature({ publicKey: portalKey, ...ok, timestamp: undefined })).toBe(false);
    expect(verifyTelnyxSignature({ publicKey: portalKey, ...ok, rawBody: undefined })).toBe(false);
    expect(verifyTelnyxSignature({ publicKey: 'not-a-key', ...ok })).toBe(false);
    expect(verifyTelnyxSignature({ publicKey: portalKey, ...ok, signature: 'AAAA' })).toBe(false);
  });
});
