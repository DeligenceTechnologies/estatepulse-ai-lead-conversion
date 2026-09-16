import { randomUUID, randomBytes } from 'node:crypto';
import { prisma } from '../db.js';
import { encrypt, decrypt } from '../crypto.js';
import { sha256Hex } from '../ingest/tokens.js';

/**
 * Bridge to the teammate's Tally-connection service (NestJS, default :3001).
 * The portal authenticates with the app JWT; that service authenticates with a
 * per-tenant x-api-key. This module mints one api_keys row per org (once),
 * stores the plaintext encrypted in our integrations table, and forwards
 * requests server-side so the key never reaches the browser.
 */
const BASE = (process.env.TALLY_API_URL || 'http://localhost:3001').replace(/\/+$/, '');
const BRIDGE_PROVIDER = 'tally_bridge';

async function ensureApiKey(orgId: string): Promise<string> {
  const existing = await prisma.integrations.findFirst({ where: { organization_id: orgId, provider: BRIDGE_PROVIDER } });
  if (existing?.credentials_secret_ref) {
    const key = decrypt(existing.credentials_secret_ref);
    if (key) return key;
  }
  // Mint. The service only does sha256(presented) -> api_keys.key_hash, so the
  // token's exact format is cosmetic; we shape it like their dashboard keys.
  const token = `ep_live_${randomBytes(18).toString('base64url')}`;
  await prisma.api_keys.create({
    data: {
      id: randomUUID(),
      organization_id: orgId,
      name: 'EstatePulse Portal Bridge',
      key_hash: sha256Hex(token),
      key_prefix: token.slice(0, 12),
      scopes: [],
    },
  });
  await prisma.integrations.upsert({
    where: existing ? { id: existing.id } : { id: randomUUID() },
    update: { credentials_secret_ref: encrypt(token), status: 'active', updated_at: new Date() },
    create: {
      organization_id: orgId,
      provider: BRIDGE_PROVIDER,
      integration_type: 'other',
      status: 'active',
      credentials_secret_ref: encrypt(token),
    },
  });
  return token;
}

export interface TallyResponse {
  status: number;
  body: unknown;
}

export async function tallyFetch(
  orgId: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<TallyResponse> {
  const key = await ensureApiKey(orgId);
  const headers: Record<string, string> = { 'x-api-key': key };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch {
    return { status: 503, body: { error: { code: 'TALLY_SERVICE_UNREACHABLE', message: `Cannot reach the Tally service at ${BASE}` } } };
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}
