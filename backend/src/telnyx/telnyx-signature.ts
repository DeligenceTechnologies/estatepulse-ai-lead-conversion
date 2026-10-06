import { createPublicKey, verify } from 'node:crypto';

/**
 * Telnyx webhook signature check (Ed25519).
 *
 * Telnyx signs `${telnyx-timestamp}|${raw body}` with the account's key; the
 * matching public key is the base64 value shown in the portal, which an office
 * saves alongside its API key. The body must be the exact bytes received —
 * re-serialising parsed JSON would change them — hence req.rawBody.
 */

/** DER prefix that wraps a raw 32-byte Ed25519 key as SubjectPublicKeyInfo. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** How old a signed timestamp may be before the delivery is treated as a replay. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

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
  if (!Number.isFinite(ts) || Math.abs(now - ts) > SIGNATURE_TOLERANCE_SECONDS) return false;

  try {
    const raw = Buffer.from(publicKey, 'base64');
    if (raw.length !== 32) return false;
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
    const message = Buffer.concat([Buffer.from(`${timestamp}|`), rawBody]);
    return verify(null, message, key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}
