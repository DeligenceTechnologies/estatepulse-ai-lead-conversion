import { prisma } from '../db';
import { encrypt, decrypt } from '../crypto';

/**
 * Per-org Telnyx credentials (Bring-Your-Own-Telnyx), persisted in the shared
 * `integrations` table (provider='telnyx'). API key encrypted at rest.
 * org id is the real organizations.id from req.auth.organizationId.
 */
const PROVIDER = 'telnyx';
const TYPE = 'voice'; // allowed: sms|voice|crm|calendar|other
const STATUS = 'active'; // allowed: active|inactive|error

export interface Creds {
  apiKey: string;
  publicKey: string;
  connectionId: string;
  messagingProfileId: string;
  fromNumber: string;
  assistantId: string;
  connectedAt: string | null;
}

const EMPTY: Creds = {
  apiKey: '', publicKey: '', connectionId: '', messagingProfileId: '', fromNumber: '', assistantId: '', connectedAt: null,
};

/* eslint-disable @typescript-eslint/no-explicit-any */
function fromRow(r: any): Creds {
  const m = (r.metadata ?? {}) as Record<string, string>;
  return {
    apiKey: decrypt(r.credentials_secret_ref ?? '') || '',
    publicKey: m.publicKey ?? '',
    connectionId: m.connectionId ?? '',
    messagingProfileId: m.messagingProfileId ?? '',
    fromNumber: m.fromNumber ?? '',
    assistantId: r.external_account_id ?? '',
    connectedAt: r.created_at ? new Date(r.created_at).toISOString() : null,
  };
}

function rowFor(orgId: string) {
  return prisma.integrations.findFirst({ where: { organization_id: orgId, provider: PROVIDER }, orderBy: { created_at: 'asc' } });
}

const isActive = (r: any): boolean => (r?.status ?? 'active') === 'active';

// Operational credentials: only returned when the integration is ACTIVE.
// A disconnected (inactive) row still exists in the DB but is treated as not connected.
export async function getCreds(orgId: string): Promise<Creds | null> {
  const r = await rowFor(orgId);
  return r && isActive(r) ? fromRow(r) : null;
}

export async function saveCreds(orgId: string, patch: Partial<Creds>): Promise<Creds> {
  const existing = await rowFor(orgId);
  const cur = existing ? fromRow(existing) : { ...EMPTY };
  const next: Creds = { ...cur, ...patch };
  if (patch.apiKey && !cur.connectedAt) next.connectedAt = new Date().toISOString();

  const metadata = {
    publicKey: next.publicKey,
    connectionId: next.connectionId,
    messagingProfileId: next.messagingProfileId,
    fromNumber: next.fromNumber,
  };
  const data = {
    status: STATUS,
    integration_type: TYPE,
    external_account_id: next.assistantId || null,
    credentials_secret_ref: encrypt(next.apiKey || ''),
    metadata,
    updated_at: new Date(),
  };

  if (existing) await prisma.integrations.update({ where: { id: existing.id }, data });
  else await prisma.integrations.create({ data: { organization_id: orgId, provider: PROVIDER, ...data } });
  return next;
}

// Soft-disconnect: keep the row (and its assistant/number/encrypted key) — just flip the
// status to 'inactive'. Reconnecting is then a status flip back to 'active'.
export async function clearCreds(orgId: string): Promise<void> {
  await prisma.integrations.updateMany({ where: { organization_id: orgId, provider: PROVIDER }, data: { status: 'inactive', updated_at: new Date() } });
}

export async function isConnected(orgId: string): Promise<boolean> {
  const c = await getCreds(orgId);
  return !!(c && c.apiKey);
}

export async function publicStatus(orgId: string) {
  // Read the raw row so a disconnected-but-present integration reports connected:false
  // (rather than looking like it was never set up).
  const r = await rowFor(orgId);
  const active = isActive(r);
  const c = r ? fromRow(r) : null;
  const mask = (k: string) => (k ? `${k.slice(0, 6)}…${k.slice(-4)}` : '');
  return {
    connected: !!(c && c.apiKey && active),
    hasAssistant: !!(c && c.assistantId && active),
    hasIntegration: !!r, // a row exists (active or inactive)
    status: r ? (r.status ?? 'active') : 'none',
    apiKeyMasked: c && active ? mask(c.apiKey) : '',
    connectionId: c ? c.connectionId : '',
    messagingProfileId: c ? c.messagingProfileId : '',
    fromNumber: c ? c.fromNumber : '',
    assistantId: c && active ? c.assistantId : '',
    connectedAt: c ? c.connectedAt : null,
  };
}

// A reconnect that reuses the stored (encrypted) key — just re-activates the row.
export async function reconnect(orgId: string): Promise<void> {
  await prisma.integrations.updateMany({ where: { organization_id: orgId, provider: PROVIDER }, data: { status: 'active', updated_at: new Date() } });
}
