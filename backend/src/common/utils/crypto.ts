import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export interface GeneratedToken {
  token: string;
  hash: string;
  prefix: string;
}

/** Webhook ingest token: goes in the URL a customer pastes into their form provider. 160 bits. */
export function generateIngestToken(env: 'live' | 'test' = 'live'): GeneratedToken {
  const body = Array.from(randomBytes(20), (b) => ALPHABET[b % 32]).join('');
  const token = `whk_${env}_${body}`;
  return { token, hash: sha256Hex(token), prefix: `whk_${env}_${body.slice(0, 4)}` };
}

/** Rejects garbage without a database round trip. */
export function looksLikeIngestToken(value: string): boolean {
  return /^whk_(live|test)_[0-9A-HJKMNP-TV-Z]{20}$/.test(value);
}

export function generateSigningSecret(): string {
  return `whsec_${randomBytes(24).toString('base64url')}`;
}

export function secretPreview(last4: string): string {
  return `${'•'.repeat(8)}${last4}`;
}

/** AAD values that bind a sealed secret to its row. */
export const aad = {
  signingSecret: (orgId: string, leadSourceId: string) => `${orgId}:${leadSourceId}:signing_secret`,
  ingestToken: (orgId: string, leadSourceId: string) => `${orgId}:${leadSourceId}:ingest_token`,
  integration: (orgId: string, integrationId: string) => `${orgId}:${integrationId}:integration`,
};

/** Tally signs the raw body: base64(HMAC-SHA256(secret, body)). */
export function verifyTallySignature(rawBody: Buffer, secret: string, header: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const provided = Buffer.from(header, 'base64');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** Typeform's `Typeform-Signature` header: `sha256=` followed by the same base64 HMAC Tally sends. */
export function verifyTypeformSignature(rawBody: Buffer, secret: string, header: string): boolean {
  const value = header.startsWith('sha256=') ? header.slice('sha256='.length) : header;
  return verifyTallySignature(rawBody, secret, value);
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const TELNYX_TOLERANCE_SECONDS = 300;

/** Telnyx signs `${timestamp}|${body}` with the account's Ed25519 key. */
export function verifyTelnyxSignature(input: {
  publicKey: string;
  signature: string | undefined;
  timestamp: string | undefined;
  rawBody: Buffer | undefined;
  nowSeconds?: number;
}): boolean {
  const { publicKey, signature, timestamp, rawBody } = input;
  if (!publicKey || !signature || !timestamp || !rawBody) return false;
  const ts = Number(timestamp);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > TELNYX_TOLERANCE_SECONDS) return false;
  try {
    const raw = Buffer.from(publicKey, 'base64');
    if (raw.length !== 32) return false;
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
    return verify(null, Buffer.concat([Buffer.from(`${timestamp}|`), rawBody]), key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}
