import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TENANT_PRISMA, type GuardedPrisma } from '../prisma/prisma.service';
import { EngineService } from '../telnyx/engine.service';
import { normalizeEmail, normalizePhone, parsePayload } from './parse';
import { generateIngestToken, sha256Hex } from './tokens';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The portal's simple lead webhook. A public request resolves an ingest token to
 * an org-scoped lead source, dedupes recent submissions, creates the lead as
 * `new`, logs a webhook_event, and hands the lead to the strategy engine so the
 * first contact (call/SMS) fires immediately.
 *
 * This is deliberately NOT the same path as modules/ingest, which is the
 * form-provider pipeline: signature verification, stored deliveries, and a
 * worker that maps each answer onto canonical fields. This one trades all of
 * that for immediacy, and exists for "paste a URL into anything" sources.
 */
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type IngestOutcome =
  | { kind: 'accepted'; leadId: string }
  | { kind: 'duplicate'; leadId: string }
  | { kind: 'invalid' }
  | { kind: 'unknown_token' }
  | { kind: 'inactive' };

export interface NewIngestSource {
  id: string;
  label: string;
  token: string;
  prefix: string;
  webhookUrl: string;
  tallyUrl: string;
}

const slugify = (s: string): string =>
  (s || 'source')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'source';

@Injectable()
export class PortalIngestService {
  private readonly logger = new Logger(PortalIngestService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma,
    private readonly engine: EngineService,
    private readonly config: ConfigService,
  ) {}

  /** Public base for webhook URLs — the tunnel/host external providers can reach. */
  private publicBase(): string {
    return (this.config.get<string>('PUBLIC_API_URL') ?? '').replace(/\/+$/, '');
  }

  async ingestLead(token: string, provider: string, body: any): Promise<IngestOutcome> {
    // ingest_token_hash is globally unique — resolving it IS how the tenant is
    // discovered, so there is no organization id to scope this by.
    const source = await this.prisma.lead_sources.findFirst({
      where: { ingest_token_hash: sha256Hex(token) },
    });
    if (!source) return { kind: 'unknown_token' };
    if (source.is_active === false) return { kind: 'inactive' };

    const orgId = source.organization_id;
    const parsed = parsePayload(body);
    const phone = normalizePhone(parsed.phone);
    const email = normalizeEmail(parsed.email);
    const eventId = String(body?.eventId ?? body?.event_id ?? '') || null;

    /*
     * Idempotency: the same provider event id is a retry of one we already
     * handled, so the earlier result is replayed rather than creating a second
     * lead.
     *
     * Scoped to the organization deliberately. webhook_events is unique on
     * (provider, external_event_id) GLOBALLY, so an unscoped lookup would hand
     * this caller another tenant's correlation_id whenever two orgs ever saw the
     * same event id. Scoping means the worst case is a create that loses the
     * uniqueness race below and replays an empty lead id — no cross-tenant read.
     */
    if (eventId) {
      const prior = await this.prisma.webhook_events.findFirst({
        where: { organization_id: orgId, provider, external_event_id: eventId },
      });
      if (prior) return { kind: 'duplicate', leadId: prior.correlation_id ?? '' };
    }

    let event;
    try {
      event = await this.prisma.webhook_events.create({
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
        const prior = await this.prisma.webhook_events.findFirst({
          where: { organization_id: orgId, provider, external_event_id: eventId },
        });
        return { kind: 'duplicate', leadId: prior?.correlation_id ?? '' };
      }
      throw e;
    }

    if (!phone && !email) {
      await this.prisma.webhook_events.update({
        where: { id: event.id },
        data: {
          processing_status: 'failed',
          error_message: 'no phone or email in payload',
          processed_at: new Date(),
        },
      });
      return { kind: 'invalid' };
    }

    // Dedupe: same org + phone (or email) within the window collapses onto one lead.
    const existing = await this.prisma.leads.findFirst({
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
      const lead = await this.prisma.leads.create({
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

    await this.prisma.webhook_events.update({
      where: { id: event.id },
      data: {
        processing_status: duplicate ? 'ignored' : 'processed',
        correlation_id: leadId,
        processed_at: new Date(),
      },
    });

    // Fresh lead -> kick off the strategy immediately. Fire-and-forget on
    // purpose: a provider waiting on our 202 must not wait on an outbound call.
    if (!duplicate) {
      void this.engine
        .enroll(orgId, leadId)
        .catch((e) => this.logger.error(`enroll: ${(e as Error).message}`));
    }

    return { kind: duplicate ? 'duplicate' : 'accepted', leadId };
  }

  /** Dashboard: mint a new ingest source and return the token ONCE (only the hash is stored). */
  async createSource(orgId: string, label: string): Promise<NewIngestSource> {
    const cred = generateIngestToken('live');
    const code = `${slugify(label)}-${Math.random().toString(36).slice(2, 6)}`;
    const src = await this.prisma.lead_sources.create({
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
    const base = this.publicBase();
    return {
      id: src.id,
      label: src.name,
      token: cred.token,
      prefix: cred.prefix,
      webhookUrl: `${base}/api/ingest/v1/webhook/${cred.token}`,
      tallyUrl: `${base}/api/ingest/v1/tally/${cred.token}`,
    };
  }

  async listSources(orgId: string) {
    const rows = await this.prisma.lead_sources.findMany({
      where: { organization_id: orgId },
      orderBy: { created_at: 'desc' },
    });
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

  async setSourceActive(orgId: string, id: string, active: boolean): Promise<boolean> {
    const r = await this.prisma.lead_sources.updateMany({
      where: { id, organization_id: orgId },
      data: { is_active: active },
    });
    return r.count > 0;
  }
}
