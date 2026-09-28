import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CryptoError,
  SecretBox,
  calendarConnectionAad,
  providerCredentialAad,
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

describe('calendarConnectionAad', () => {
  it('binds an OAuth token to one connection row', () => {
    const box = new SecretBox(keys, 'k1');
    const tokens = JSON.stringify({ access_token: 'at_live', refresh_token: 'rt_live' });
    const aad = calendarConnectionAad('org-1', 'conn-1');

    const env = box.encrypt(tokens, aad);
    expect(env).not.toContain('rt_live');
    expect(box.decrypt(env, aad)).toBe(tokens);
  });

  it("refuses a token lifted into another agent's connection row", () => {
    const box = new SecretBox(keys, 'k1');
    const stolen = box.encrypt('rt_agentA', calendarConnectionAad('org-1', 'conn-A'));

    // Same organization, different connection: agent B must not be able to
    // drive agent A's Calendly account by copying the ciphertext across rows.
    expect(() => box.decrypt(stolen, calendarConnectionAad('org-1', 'conn-B'))).toThrow(CryptoError);
    // And the cross-tenant case.
    expect(() => box.decrypt(stolen, calendarConnectionAad('org-2', 'conn-A'))).toThrow(CryptoError);
  });

  it('does not collide with the other AAD purposes', () => {
    // Same ids, different purpose strings: a provider credential envelope must
    // never decrypt as a calendar token, or rotating one would silently
    // authenticate the other.
    const box = new SecretBox(keys, 'k1');
    const asProvider = box.encrypt('secret', providerCredentialAad('org-1', 'row-1'));

    expect(() => box.decrypt(asProvider, calendarConnectionAad('org-1', 'row-1'))).toThrow(
      CryptoError,
    );
  });
});
