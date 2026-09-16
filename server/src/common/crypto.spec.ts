import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CryptoError,
  SecretBox,
  signingSecretAad,
  verifyTallySignature,
} from './crypto';

const KEY_A = randomBytes(32).toString('base64');
const KEY_B = randomBytes(32).toString('base64');
const keys = JSON.stringify({ k1: KEY_A, k2: KEY_B });

describe('SecretBox', () => {
  it('round-trips a secret under the active key', () => {
    const box = new SecretBox(keys, 'k1');
    const aad = signingSecretAad('org-1', 'src-1');
    const env = box.encrypt('whsec_topsecret', aad);

    expect(env).not.toContain('whsec_topsecret');
    expect(box.decrypt(env, aad)).toBe('whsec_topsecret');
  });

  it('refuses to decrypt a ciphertext bound to a DIFFERENT row', () => {
    const box = new SecretBox(keys, 'k1');
    const stolen = box.encrypt('whsec_tenantA', signingSecretAad('org-A', 'src-A'));

    // The attack this prevents: copying tenant A's ciphertext into tenant B's
    // row so that B's webhook traffic is verified with A's secret.
    expect(() => box.decrypt(stolen, signingSecretAad('org-B', 'src-B'))).toThrow(CryptoError);
  });

  it('decrypts ciphertext written under a retired key (rotation without backfill)', () => {
    const aad = signingSecretAad('org-1', 'src-1');
    const written = new SecretBox(keys, 'k1').encrypt('whsec_old', aad);

    // Active key has moved on to k2, but the envelope names k1.
    const rotated = new SecretBox(keys, 'k2');
    expect(rotated.decrypt(written, aad)).toBe('whsec_old');
    expect(rotated.encrypt('whsec_new', aad)).toContain('.k2.');
  });

  it('fails loudly on a tampered ciphertext instead of returning garbage', () => {
    const box = new SecretBox(keys, 'k1');
    const aad = signingSecretAad('org-1', 'src-1');
    const env = box.encrypt('whsec_topsecret', aad);
    const tampered = `${env.slice(0, -4)}AAAA`;

    expect(() => box.decrypt(tampered, aad)).toThrow(CryptoError);
  });

  it('rejects malformed configuration at construction time', () => {
    expect(() => new SecretBox('not json', 'k1')).toThrow(CryptoError);
    expect(() => new SecretBox(JSON.stringify({ k1: 'c2hvcnQ=' }), 'k1')).toThrow(/32 bytes/);
    expect(() => new SecretBox(keys, 'nope')).toThrow(/not present/);
  });
});

describe('verifyTallySignature', () => {
  const secret = 'whsec_abc123';
  const rawBody = Buffer.from('{"eventId":"evt_1","data":{"fields":[]}}', 'utf8');
  const goodSig = createHmac('sha256', secret).update(rawBody).digest('base64');

  it('accepts a signature computed over the raw body', () => {
    expect(verifyTallySignature(rawBody, secret, goodSig)).toBe(true);
  });

  it('rejects the signature when a single body byte changes', () => {
    const tampered = Buffer.from('{"eventId":"evt_2","data":{"fields":[]}}', 'utf8');
    expect(verifyTallySignature(tampered, secret, goodSig)).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    expect(verifyTallySignature(rawBody, 'whsec_wrong', goodSig)).toBe(false);
  });

  it('fails on re-serialized JSON, proving why the RAW body must be kept', () => {
    // This is the single most common way this integration breaks: verifying
    // against JSON.stringify(req.body) instead of the bytes the provider signed.
    // Real payloads carry whitespace and non-ASCII escapes that do not survive a
    // parse/stringify round-trip byte-for-byte.
    const wireBytes = Buffer.from(
      '{\n  "eventId": "evt_1",\n  "label": "Caf\\u00e9 \\u2014 budget?"\n}',
      'utf8',
    );
    const wireSig = createHmac('sha256', secret).update(wireBytes).digest('base64');

    const reserialized = Buffer.from(JSON.stringify(JSON.parse(wireBytes.toString())), 'utf8');
    expect(reserialized.equals(wireBytes)).toBe(false);

    // Verifying the original bytes against the original signature: fine.
    expect(verifyTallySignature(wireBytes, secret, wireSig)).toBe(true);
    // Verifying re-serialized bytes against that same signature: broken.
    expect(verifyTallySignature(reserialized, secret, wireSig)).toBe(false);
  });

  it('returns false rather than throwing on a malformed header', () => {
    // timingSafeEqual throws on length mismatch; that must not become a 500.
    expect(verifyTallySignature(rawBody, secret, '')).toBe(false);
    expect(verifyTallySignature(rawBody, secret, 'nonsense')).toBe(false);
  });
});
