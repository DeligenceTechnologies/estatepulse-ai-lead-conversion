import { randomBytes } from 'node:crypto';
import { sha256Hex } from './crypto';

/**
 * Credential generation for ingest tokens (pasted into Tally) and API keys
 * (used by the dashboard).
 *
 * Both are prefixed so that:
 *  - a structurally invalid token is rejected with zero DB round trips, which is
 *    a cheap guard against someone spraying the ingest endpoint;
 *  - `live` vs `test` prevents the classic "pasted the sandbox URL into
 *    production" support ticket;
 *  - a leaked credential is greppable and attributable in logs by its prefix
 *    alone, without ever logging the secret itself.
 */

// Crockford base32: no I/L/O/U, so the alphabet survives being read aloud over
// the phone to a support agent and pasted back without transcription errors.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function base32(bytes: Buffer): string {
  let out = '';
  for (const b of bytes) out += ALPHABET[b % 32];
  return out;
}

export type TokenEnv = 'live' | 'test';

export interface GeneratedCredential {
  /** Full secret. Returned to the caller exactly once; never stored in plaintext. */
  token: string;
  /** sha256(token) — the only lookup path. */
  hash: string;
  /** Non-secret display fragment, e.g. "whk_live_7F3A". */
  prefix: string;
}

function generate(kind: 'whk' | 'ep', env: TokenEnv, entropyBytes: number): GeneratedCredential {
  const body = base32(randomBytes(entropyBytes));
  const token = `${kind}_${env}_${body}`;
  return {
    token,
    hash: sha256Hex(token),
    // Enough to identify which credential a log line refers to, far too little
    // to reconstruct it.
    prefix: `${kind}_${env}_${body.slice(0, 4)}`,
  };
}

/** Webhook ingest token — goes in the URL path a customer pastes into Tally. */
export function generateIngestToken(env: TokenEnv = 'live'): GeneratedCredential {
  return generate('whk', env, 20); // 160 bits
}

/** Dashboard API key. Deliberately a different credential from the ingest token. */
export function generateApiKey(env: TokenEnv = 'live'): GeneratedCredential {
  return generate('ep', env, 24); // 192 bits
}

/**
 * Tally's signing secret is chosen by us and pasted into their UI by the
 * customer, so it only has to be high-entropy and copy-pasteable.
 */
export function generateSigningSecret(): string {
  return `whsec_${randomBytes(24).toString('base64url')}`;
}

/** Shown in the UI as a reminder of which secret is configured. */
export function secretPreview(secret: string): string {
  return `${'•'.repeat(8)}${secret.slice(-4)}`;
}

/**
 * Cheap structural check before touching the database. Rejects obvious garbage
 * and truncated pastes without spending a query.
 */
export function looksLikeIngestToken(value: string): boolean {
  return /^whk_(live|test)_[0-9A-HJKMNP-TV-Z]{20}$/.test(value);
}

export function hashCredential(token: string): string {
  return sha256Hex(token);
}
