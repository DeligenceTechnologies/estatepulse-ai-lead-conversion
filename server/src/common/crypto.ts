import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Authenticated encryption for secrets that must be RECOVERABLE.
 *
 * Why encryption and not hashing, for lead-source signing secrets:
 * verification is `base64(HMAC-SHA256(secret, rawBody))`, which needs the secret
 * in cleartext at verify time. A hash cannot produce it. (API keys are the
 * opposite case — we only ever compare those, so they are hashed.)
 *
 * Envelope format: `v1.<keyId>.<iv>.<tag>.<ciphertext>`, all base64url.
 * Embedding the keyId is what makes rotation possible without a backfill: add a
 * new key, flip ENCRYPTION_ACTIVE_KEY_ID, and old ciphertexts keep decrypting
 * under the key they were written with.
 */

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit IV is the GCM-recommended size
const VERSION = 'v1';

export class CryptoError extends Error {}

function b64u(buf: Buffer): string {
  return buf.toString('base64url');
}

function unb64u(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

export class SecretBox {
  private readonly keys: Map<string, Buffer>;
  private readonly activeKeyId: string;

  constructor(keysJson: string, activeKeyId: string) {
    let parsed: Record<string, string>;
    try {
      parsed = JSON.parse(keysJson);
    } catch {
      throw new CryptoError('ENCRYPTION_KEYS must be a JSON object of keyId -> base64 key');
    }

    this.keys = new Map();
    for (const [id, b64] of Object.entries(parsed)) {
      const key = Buffer.from(b64, 'base64');
      if (key.length !== 32) {
        throw new CryptoError(`ENCRYPTION_KEYS["${id}"] must decode to exactly 32 bytes`);
      }
      this.keys.set(id, key);
    }

    if (!this.keys.has(activeKeyId)) {
      throw new CryptoError(`ENCRYPTION_ACTIVE_KEY_ID "${activeKeyId}" is not present in ENCRYPTION_KEYS`);
    }
    this.activeKeyId = activeKeyId;
  }

  /**
   * `aad` binds the ciphertext to the row it belongs to — see `secretAad()`.
   * Without it, anyone who can write SQL could copy tenant A's ciphertext into
   * tenant B's row and have B's webhook traffic verified with A's secret.
   */
  encrypt(plaintext: string, aad: string): string {
    const key = this.keys.get(this.activeKeyId)!;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, this.activeKeyId, b64u(iv), b64u(tag), b64u(ct)].join('.');
  }

  decrypt(envelope: string, aad: string): string {
    const parts = envelope.split('.');
    if (parts.length !== 5 || parts[0] !== VERSION) {
      throw new CryptoError('Malformed ciphertext envelope');
    }
    const [, keyId, ivB64, tagB64, ctB64] = parts;

    const key = this.keys.get(keyId);
    if (!key) {
      throw new CryptoError(
        `Ciphertext was written with key "${keyId}", which is not in ENCRYPTION_KEYS. ` +
          'Retiring a key requires re-encrypting everything written under it.',
      );
    }

    const decipher = createDecipheriv(ALGO, key, unb64u(ivB64));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(unb64u(tagB64));
    try {
      // GCM's auth tag means tampered or mis-bound ciphertext fails loudly here
      // rather than decrypting to garbage that silently rejects every delivery.
      return Buffer.concat([decipher.update(unb64u(ctB64)), decipher.final()]).toString('utf8');
    } catch {
      throw new CryptoError('Ciphertext failed authentication (wrong key, wrong AAD, or tampered)');
    }
  }
}

/** AAD for a lead source's signing secret. Binds ciphertext to (org, source). */
export function signingSecretAad(organizationId: string, leadSourceId: string): string {
  return `${organizationId}:${leadSourceId}:signing_secret`;
}

/** AAD for a lead source's ingest token. */
export function ingestTokenAad(organizationId: string, leadSourceId: string): string {
  return `${organizationId}:${leadSourceId}:ingest_token`;
}

// ---------------------------------------------------------------------------
// Hashing and signature verification
// ---------------------------------------------------------------------------

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Verify Tally's `Tally-Signature` header.
 *
 * `rawBody` MUST be the exact bytes received. Re-serializing parsed JSON
 * (`JSON.stringify(req.body)`) produces different bytes — key order, unicode
 * escaping and number formatting all differ — and every signature fails. This is
 * the single most common way this integration breaks.
 *
 * Note that Tally signs only the body, with no timestamp in the signed material,
 * so a valid signature provides NO replay protection: a captured request
 * replays successfully forever. The unique index on
 * (lead_source_id, dedupe_key) is what actually defends against that, which is
 * why it is a security control and not merely a correctness nicety.
 */
export function verifyTallySignature(rawBody: Buffer, secret: string, headerValue: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest();

  let provided: Buffer;
  try {
    provided = Buffer.from(headerValue, 'base64');
  } catch {
    return false;
  }

  // timingSafeEqual throws on unequal lengths, so check first — and treat a
  // length mismatch as a plain failure rather than an exception.
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
