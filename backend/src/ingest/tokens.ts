import { randomBytes, createHash } from 'node:crypto';

/**
 * Ingest token scheme — kept identical to the team's design so this backend and the
 * lead_sources table interoperate: `whk_live_<crockford-base32>`, looked up by sha256(token).
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const base32 = (bytes: Buffer): string => Array.from(bytes, (b) => ALPHABET[b % 32]).join('');

export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

export interface GeneratedToken {
  token: string;
  hash: string;
  prefix: string;
}

export function generateIngestToken(env: 'live' | 'test' = 'live'): GeneratedToken {
  const body = base32(randomBytes(20)); // 160 bits
  const token = `whk_${env}_${body}`;
  return { token, hash: sha256Hex(token), prefix: `whk_${env}_${body.slice(0, 4)}` };
}

export const looksLikeIngestToken = (t: string): boolean => /^whk_(live|test)_[0-9A-Z]{8,}$/.test(t);
