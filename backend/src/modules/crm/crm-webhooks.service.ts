import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { newId } from '../../common/ids';
import { PrismaService } from '../../prisma/prisma.service';
import { SYNC_CONNECTION } from '../google-sheets/sheet-import.service';
import { CrmSyncService } from './crm-sync.service';
import { HubSpotClient } from './hubspot/hubspot.client';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, parseDelivery, signedUri, verifySignatureV3 } from './hubspot/hubspot-webhooks';

export type WebhookResult =
  | { kind: 'accepted'; accepted: number; duplicates: number; ignored: number }
  | { kind: 'unauthenticated'; verdict: string }
  | { kind: 'invalid_payload'; detail: string };

/**
 * The synchronous half of a HubSpot webhook: authenticate it, record it, and
 * get out of the way. HubSpot retries anything that takes longer than five
 * seconds or answers non-2xx, up to ten times over a day, so nothing slow
 * happens here — no CRM call, no lead write. The worker does that, under the
 * connection's lease (CrmSyncService).
 *
 * The ONLY way an event reaches an organization is through the HubSpot account
 * id inside a signature-verified body, looked up against live connections. A
 * delivery cannot name an organization, a lead source or a lead.
 */
@Injectable()
export class CrmWebhooksService {
  private readonly logger = new Logger('CrmWebhooks');

  constructor(
    // Unguarded by design, like the Tally ingest path: resolving which
    // connection a CRM account belongs to IS how the tenant is discovered, so
    // there is no organization id yet to scope by. Every row written carries
    // the organization of the connection it was resolved to.
    private readonly prisma: PrismaService,
    private readonly hubspot: HubSpotClient,
    private readonly sync: CrmSyncService,
  ) {}

  async ingestHubSpot(req: { method: string; url: string; rawBody: Buffer; headers: Record<string, unknown> }): Promise<WebhookResult> {
    const header = (name: string) => {
      const v = req.headers[name];
      return Array.isArray(v) ? String(v[0]) : typeof v === 'string' ? v : undefined;
    };
    const verdict = verifySignatureV3({
      method: req.method,
      uri: signedUri(this.hubspot.webhookUrl, req.url),
      rawBody: req.rawBody,
      signature: header(SIGNATURE_HEADER),
      timestamp: header(TIMESTAMP_HEADER),
      clientSecret: this.hubspot.webhookSecret,
    });
    if (verdict !== 'VALID') {
      // Never the body or the header values: they are either an attacker's or
      // a misconfiguration's, and neither belongs in a log.
      this.logger.warn(`HubSpot webhook refused: signature ${verdict}`);
      return { kind: 'unauthenticated', verdict };
    }

    let body: unknown;
    try {
      body = JSON.parse(req.rawBody.toString('utf8'));
    } catch {
      return { kind: 'invalid_payload', detail: 'Body is not JSON' };
    }
    const parsed = parseDelivery(body);
    if ('error' in parsed) return { kind: 'invalid_payload', detail: parsed.error };

    const actionable = parsed.events.filter((e) => e.contactIds.length > 0);
    let ignored = parsed.events.length - actionable.length;
    if (actionable.length === 0) return { kind: 'accepted', accepted: 0, duplicates: 0, ignored };

    // Live connections for these accounts — including ones waiting for a
    // reconnect, whose deliveries wait with them. A disconnected connection
    // gets nothing: its deliveries are acknowledged and dropped.
    const portals = [...new Set(actionable.map((e) => e.portalId))];
    const sources = await this.prisma.$queryRaw<{ id: string; organization_id: string; external_form_id: string }[]>`
      SELECT s.id, s.organization_id, s.external_form_id
        FROM lead_sources s
        JOIN provider_credentials c ON c.id = s.provider_credential_id AND c.organization_id = s.organization_id
       WHERE s.provider = ${this.hubspot.provider} AND s.connection_method = ${SYNC_CONNECTION}
         AND s.archived_at IS NULL AND s.is_active
         AND s.external_form_id = ANY(${portals}::text[])
         AND c.revoked_at IS NULL`;
    const byPortal = new Map<string, { id: string; organization_id: string }[]>();
    for (const s of sources) byPortal.set(s.external_form_id, [...(byPortal.get(s.external_form_id) ?? []), s]);

    const rows: Prisma.webhook_eventsCreateManyInput[] = [];
    const now = new Date();
    for (const e of actionable) {
      const targets = byPortal.get(e.portalId) ?? [];
      if (targets.length === 0) {
        ignored += 1;
        continue;
      }
      // Fan out: one copy per connection, each deduplicated within its own source.
      for (const t of targets) {
        rows.push({
          id: newId(),
          organization_id: t.organization_id,
          lead_source_id: t.id,
          provider: this.hubspot.provider,
          event_type: e.type.slice(0, 100),
          // HubSpot's eventId is documented as not unique, so it is not the
          // identity: dedupe_key is (see dedupeKeyFor). Left NULL so the global
          // (provider, external_event_id) index never collides across accounts.
          external_event_id: null,
          dedupe_key: e.dedupeKey,
          payload: e.stored as Prisma.InputJsonValue,
          headers: { 'content-type': header('content-type') ?? null, 'user-agent': header('user-agent') ?? null, signature: '[verified, redacted]' },
          signature_verified: true,
          signature_state: 'VALID',
          queue_state: 'PENDING',
          processing_status: 'received',
          received_at: now,
          available_at: now,
          provider_created_at: new Date(e.occurredAt),
          content_length: req.rawBody.byteLength,
        });
      }
    }
    if (rows.length === 0) {
      if (ignored) this.logger.log(`HubSpot webhook: ${ignored} event(s) for accounts with no live connection, acknowledged and dropped`);
      return { kind: 'accepted', accepted: 0, duplicates: 0, ignored };
    }

    // ON CONFLICT DO NOTHING on webhook_events_source_dedupe_uniq: HubSpot's
    // retries, and its documented duplicate deliveries, are absorbed here.
    const created = await this.prisma.webhook_events.createMany({ data: rows, skipDuplicates: true });
    const touched = [...new Set(rows.map((r) => r.lead_source_id!))];
    await this.prisma.$executeRaw`UPDATE lead_sources SET last_event_at = now() WHERE id = ANY(${touched}::uuid[])`;

    if (created.count > 0) this.sync.nudge();
    return { kind: 'accepted', accepted: created.count, duplicates: rows.length - created.count, ignored };
  }
}
