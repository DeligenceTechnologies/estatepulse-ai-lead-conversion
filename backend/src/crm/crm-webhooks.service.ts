import { Injectable, Logger } from '@nestjs/common';
import { LeadSourceProvider, Prisma, QueueState, SignatureState } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';
import { sha256Hex } from '@/common/utils/crypto';
import { CrmSyncService } from './crm-sync.service';
import { HubSpotClient } from './hubspot/hubspot.client';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, parseDelivery, signedUri, verifySignatureV3 } from './hubspot/hubspot-webhooks';

export type WebhookResult =
  | { kind: 'accepted'; accepted: number; duplicates: number; ignored: number }
  | { kind: 'unauthenticated'; verdict: string }
  | { kind: 'invalid_payload'; detail: string };

/**
 * The synchronous half of a HubSpot webhook: authenticate it, record it, and
 * get out of the way. HubSpot retries anything slower than five seconds or
 * non-2xx, so nothing slow happens here; CrmSyncService does the work under
 * the connection's lease.
 *
 * The ONLY way an event reaches an organization is through the HubSpot account
 * id inside a signature-verified body, looked up against live connections.
 */
@Injectable()
export class CrmWebhooksService {
  private readonly logger = new Logger('CrmWebhooks');

  constructor(
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
      // Never the body or the header values: they are either an attacker's or a misconfiguration's.
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

    // Live connections for these accounts, including ones waiting for a reconnect, whose deliveries wait with them.
    // A disconnected connection gets nothing: its deliveries are acknowledged and dropped.
    const portals = [...new Set(actionable.map((e) => e.portalId))];
    const sources = await this.prisma.$queryRaw<{ id: string; organization_id: string; external_form_id: string }[]>`
      SELECT s.id, s.organization_id, s.external_form_id
        FROM lead_sources s
        JOIN integrations c ON c.id = s.integration_id AND c.organization_id = s.organization_id
       WHERE s.provider = 'HUBSPOT' AND s.connection_method = 'SYNC'
         AND s.archived_at IS NULL AND s.is_active
         AND s.external_form_id = ANY(${portals}::text[])
         AND c.revoked_at IS NULL`;
    const byPortal = new Map<string, { id: string; organization_id: string }[]>();
    for (const s of sources) byPortal.set(s.external_form_id, [...(byPortal.get(s.external_form_id) ?? []), s]);

    const rows: Prisma.IngestEventCreateManyInput[] = [];
    const now = new Date();
    for (const e of actionable) {
      const targets = byPortal.get(e.portalId) ?? [];
      if (targets.length === 0) {
        ignored += 1;
        continue;
      }
      const payload = e.stored as Prisma.InputJsonValue;
      // Fan out: one copy per connection, each deduplicated within its own source.
      for (const t of targets) {
        rows.push({
          orgId: t.organization_id,
          leadSourceId: t.id,
          provider: LeadSourceProvider.HUBSPOT,
          eventType: e.type.slice(0, 100),
          // HubSpot's eventId is documented as not unique, so it is not the identity: dedupeKey is.
          dedupeKey: e.dedupeKey,
          payload,
          payloadHash: sha256Hex(JSON.stringify(e.stored)),
          headers: { 'content-type': header('content-type') ?? null, 'user-agent': header('user-agent') ?? null, signature: '[verified, redacted]' },
          signatureState: SignatureState.VALID,
          queueState: QueueState.PENDING,
          receivedAt: now,
          availableAt: now,
          providerCreatedAt: new Date(e.occurredAt),
          contentLength: req.rawBody.byteLength,
        });
      }
    }
    if (rows.length === 0) {
      if (ignored) this.logger.log(`HubSpot webhook: ${ignored} event(s) for accounts with no live connection, acknowledged and dropped`);
      return { kind: 'accepted', accepted: 0, duplicates: 0, ignored };
    }

    // The (lead_source_id, dedupe_key) unique index absorbs HubSpot's retries and documented duplicate deliveries.
    const created = await this.prisma.ingestEvent.createMany({ data: rows, skipDuplicates: true });
    const touched = [...new Set(rows.map((r) => r.leadSourceId))];
    await this.prisma.$executeRaw`UPDATE lead_sources SET last_event_at = now() WHERE id = ANY(${touched}::uuid[])`;

    if (created.count > 0) this.sync.nudge();
    return { kind: 'accepted', accepted: created.count, duplicates: rows.length - created.count, ignored };
  }
}
