import { prisma } from '../db';
import { generateIngestToken, sha256Hex } from './tokens';
import { parsePayload, normalizePhone, normalizeEmail } from './parse';
import * as engine from '../telnyx/engine';

/**
 * Milestone-1 lead ingestion. A public webhook resolves an ingest token to an
 * org-scoped lead source, dedupes recent submissions, creates the lead as `new`,
 * logs a webhook_event, and hands the lead to the strategy engine so the first
 * contact (call/SMS) fires immediately.
 */

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type IngestOutcome =
  | { kind: 'accepted'; leadId: string }
  | { kind: 'duplicate'; leadId: string }
  | { kind: 'invalid' }
  | { kind: 'unknown_token' }
  | { kind: 'inactive' };

export async function ingestLead(token: string, provider: string, body: any): Promise<IngestOutcome> {
  const source = await prisma.lead_sources.findFirst({ where: { ingest_token_hash: sha256Hex(token) } });
  if (!source) return { kind: 'unknown_token' };
  if (source.is_active === false) return { kind: 'inactive' };

  const orgId = source.organization_id;
  const parsed = parsePayload(body);
  const phone = normalizePhone(parsed.phone);
  const email = normalizeEmail(parsed.email);
  const eventId = String(body?.eventId ?? body?.event_id ?? '') || null;

  // Idempotency: the same provider event id is a retry of one we already handled
  // (webhook_events has a unique (provider, external_event_id)). Replay the result.
  if (eventId) {
    const prior = await prisma.webhook_events.findFirst({ where: { provider, external_event_id: eventId } });
    if (prior) return { kind: 'duplicate', leadId: prior.correlation_id ?? '' };
  }

  let event;
  try {
    event = await prisma.webhook_events.create({
      data: {
        organization_id: orgId,
        provider,
        event_type: 'lead.submission',
        external_event_id: eventId,
        payload: (body ?? {}) as object,
        signature_verified: false,
        processing_status: 'received',
      },
    });
  } catch (e) {
    // Lost the race on (provider, external_event_id) — another request has it.
    if ((e as { code?: string }).code === 'P2002' && eventId) {
      const prior = await prisma.webhook_events.findFirst({ where: { provider, external_event_id: eventId } });
      return { kind: 'duplicate', leadId: prior?.correlation_id ?? '' };
    }
    throw e;
  }

  if (!phone && !email) {
    await prisma.webhook_events.update({
      where: { id: event.id },
      data: { processing_status: 'failed', error_message: 'no phone or email in payload', processed_at: new Date() },
    });
    return { kind: 'invalid' };
  }

  // Dedupe: same org + phone (or email) within the window collapses onto one lead.
  const existing = await prisma.leads.findFirst({
    where: {
      organization_id: orgId,
      created_at: { gt: new Date(Date.now() - DEDUPE_WINDOW_MS) },
      ...(phone ? { normalized_phone: phone } : { normalized_email: email }),
    },
    orderBy: { created_at: 'desc' },
  });

  let leadId: string;
  let duplicate = false;
  if (existing) {
    duplicate = true;
    leadId = existing.id;
  } else {
    const lead = await prisma.leads.create({
      data: {
        organization_id: orgId,
        lead_source_id: source.id,
        first_name: parsed.firstName || null,
        last_name: parsed.lastName || null,
        email: parsed.email || null,
        normalized_email: email || null,
        phone: parsed.phone || null,
        normalized_phone: phone || null,
        status: 'new',
        extracted_intel: { raw: body ?? {} } as object,
      },
    });
    leadId = lead.id;
  }

  await prisma.webhook_events.update({
    where: { id: event.id },
    data: { processing_status: duplicate ? 'ignored' : 'processed', correlation_id: leadId, processed_at: new Date() },
  });

  // Fresh lead -> kick off the strategy immediately (fire-and-forget; never blocks the 202).
  if (!duplicate) void engine.enroll(orgId, leadId).catch((e) => console.error('[ingest] enroll:', (e as Error).message));

  return { kind: duplicate ? 'duplicate' : 'accepted', leadId };
}

const slugify = (s: string): string =>
  (s || 'source').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'source';

/** Public base for webhook URLs — the tunnel/host external providers can reach. */
const publicBase = (): string => (process.env.PUBLIC_API_URL || '').replace(/\/+$/, '');

/** Dashboard: mint a new ingest source and return the token ONCE (only the hash is stored). */
export async function createSource(
  orgId: string,
  label: string,
): Promise<{ id: string; label: string; token: string; prefix: string; webhookUrl: string; tallyUrl: string }> {
  const cred = generateIngestToken('live');
  const code = `${slugify(label)}-${Math.random().toString(36).slice(2, 6)}`;
  const src = await prisma.lead_sources.create({
    data: {
      organization_id: orgId,
      name: label || 'Webhook source',
      code,
      source_type: 'webhook',
      is_active: true,
      ingest_token_hash: cred.hash,
      ingest_token_prefix: cred.prefix,
    },
  });
  const base = publicBase();
  return {
    id: src.id,
    label: src.name,
    token: cred.token,
    prefix: cred.prefix,
    webhookUrl: `${base}/api/ingest/v1/webhook/${cred.token}`,
    tallyUrl: `${base}/api/ingest/v1/tally/${cred.token}`,
  };
}

export async function listSources(orgId: string) {
  const rows = await prisma.lead_sources.findMany({ where: { organization_id: orgId }, orderBy: { created_at: 'desc' } });
  return rows.map((r) => ({
    id: r.id,
    label: r.name,
    code: r.code,
    prefix: r.ingest_token_prefix,
    active: r.is_active,
    sourceType: r.source_type,
    hasToken: !!r.ingest_token_hash,
    createdAt: r.created_at,
  }));
}

export async function setSourceActive(orgId: string, id: string, active: boolean): Promise<boolean> {
  const r = await prisma.lead_sources.updateMany({ where: { id, organization_id: orgId }, data: { is_active: active } });
  return r.count > 0;
}
