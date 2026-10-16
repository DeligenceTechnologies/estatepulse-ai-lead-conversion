import { Injectable, Logger } from '@nestjs/common';
import {
  DeliveryOutcome,
  IngestStatus,
  MappingOrigin,
  MappingStatus,
  Prisma,
  QueueState,
  SignatureState,
  type LeadSource,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AuditService } from '@/audit/audit.service';
import { PrismaService } from '@/common/prisma/prisma.service';
import { SecretBoxService } from '@/common/service/secret-box.service';
import { aad, looksLikeIngestToken, sha256Hex } from '@/common/utils/crypto';
import { EventsBus } from '@/events/events.bus';
import type { NormalizedDelivery } from '@/ingest/adapters/types';
import { HELD_UNTIL } from '@/ingest/ingest.service';
import { authHeaderName, headerValue, verifyCustomAuth, type CustomConfig } from './auth';
import { AWAITING_MAPPING, CUSTOM_EVENT_TYPE, CUSTOM_PROVIDER, HELD_CAP } from './constants';
import { detectAdapter } from './detect';
import { expandFields, suggestFromAnswers, validateFields } from './mapping';
import { parseConfig } from './schemas';

/**
 * Outcome of the synchronous half of a custom delivery. The controller maps
 * these onto HTTP statuses; nothing here throws for ordinary business failures.
 */
export type CustomIngestResult =
  | { kind: 'accepted'; eventId: string }
  | { kind: 'duplicate'; eventId: string }
  | { kind: 'held'; eventId: string; reason: 'awaiting_mapping' | 'source_paused' }
  | { kind: 'dropped'; reason: 'setup_backlog_full' }
  | { kind: 'quarantined'; eventId: string; reason: 'invalid_signature' | 'signature_required' }
  | { kind: 'invalid_payload'; eventId: string; detail: string }
  | { kind: 'unknown_token' }
  | { kind: 'archived' };

const KEPT_HEADERS = ['content-type', 'content-length', 'user-agent', 'x-forwarded-for'];

/**
 * Store only headers worth reading in support. The auth header is a secret (or
 * a MAC over the body) and is kept as a marker; the delivery-id header, when
 * one is configured, is kept because it is the sender's own reference.
 */
function redactHeaders(headers: Record<string, unknown>, cfg: CustomConfig | null): Record<string, string> {
  const keep = new Set(KEPT_HEADERS);
  if (cfg?.deliveryIdHeader) keep.add(cfg.deliveryIdHeader);
  const secretHeader = cfg ? authHeaderName(cfg.auth) : null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (key === secretHeader) out[key] = '[present, redacted]';
    else if (keep.has(key)) out[key] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

/**
 * The public side of a custom webhook: resolve the token, prove the sender,
 * store the bytes, answer fast.
 *
 * A separate class from IngestService rather than a branch in it, so the form
 * provider routes stay as they are. The row it writes is the same ingest_events
 * shape — raw body, dedupe key, queue state, hold — so the worker and the
 * deliveries screen need no second code path for storage.
 */
@Injectable()
export class CustomWebhookIngestService {
  private readonly logger = new Logger(CustomWebhookIngestService.name);

  constructor(
    // Unscoped by necessity, as IngestService is: the token in the URL is how
    // the tenant is discovered. Everything after the lookup stays inside it.
    private readonly prisma: PrismaService,
    private readonly secrets: SecretBoxService,
    private readonly events: EventsBus,
    private readonly audit: AuditService,
  ) {}

  async receive(params: {
    token: string;
    rawBody: Buffer;
    /** Already parsed by the body parser: JSON or form fields. */
    body: unknown;
    headers: Record<string, unknown>;
  }): Promise<CustomIngestResult> {
    const { token, rawBody, body, headers } = params;

    if (!looksLikeIngestToken(token)) return { kind: 'unknown_token' };

    const source = await this.prisma.leadSource.findUnique({ where: { ingestTokenHash: sha256Hex(token) } });
    // A token of another kind (a Tally one, say) is not ours to accept on this
    // route; 404 keeps the token spaces apart and confirms nothing.
    if (!source || source.provider !== CUSTOM_PROVIDER) {
      this.logger.warn(`Custom ingest rejected: unknown token ${token.slice(0, 12)}…`);
      return { kind: 'unknown_token' };
    }
    if (source.archivedAt) return { kind: 'archived' };

    // --- Authentication ----------------------------------------------------
    const cfg = parseConfig(source.customConfig);
    const sig = this.evaluate(source, cfg, rawBody, headers);

    // --- Shape -------------------------------------------------------------
    const invalidDetail = body !== null && typeof body === 'object' ? null : 'The body must be a JSON object or form fields';

    // A form provider's payload on this URL (a Tally submission, say) carries
    // its own ids: kept for dedupe and for the deliveries screen, exactly as
    // the provider's own route keeps them.
    const adapter = invalidDetail ? null : detectAdapter(body);
    const known = adapter ? adapter.parse(body) : null;

    const payloadHash = sha256Hex(rawBody);
    const deliveryId = cfg?.deliveryIdHeader ? headerValue(headers, cfg.deliveryIdHeader)?.trim() : null;
    // The sender's delivery id when it sends one, else the form provider's
    // event id, else the bytes themselves — either way a retry of a delivery
    // we hold is a no-op, per source.
    const dedupeKey = deliveryId
      ? `custom:${deliveryId.slice(0, 100)}`
      : known?.providerEventId
        ? `${adapter!.provider.toLowerCase()}:${known.providerEventId}`.slice(0, 128)
        : `sha256:${payloadHash}`;

    const paused = source.ingestStatus === IngestStatus.PAUSED || !source.isActive;
    // Listening until the owner maps the source and switches it on.
    let listening = !cfg?.activated;
    // A form we know, on a webhook nobody has mapped yet: the form's own
    // heuristics write the mapping and switch the source on right here, as the
    // provider's own route would — the owner reviews it rather than builds it.
    // Without a contact field among the questions the payload is held as usual.
    if (cfg && listening && !paused && known && adapter && !sig.quarantine && !invalidDetail) {
      if (await this.autoActivate(source, cfg, adapter.provider, known)) listening = false;
    }

    const outcome = sig.quarantine
      ? DeliveryOutcome.QUARANTINED_SIGNATURE
      : invalidDetail
        ? DeliveryOutcome.INVALID_PAYLOAD
        : null;
    const held = !outcome && (paused || listening);

    // A forgotten setup must not fill the table: past the cap the delivery is
    // acknowledged (so the sender stops retrying) and counted on the source.
    if (!outcome && listening && !paused) {
      const backlog = await this.prisma.ingestEvent.count({
        where: { leadSourceId: source.id, queueState: QueueState.PENDING, outcomeReason: AWAITING_MAPPING },
      });
      if (backlog >= HELD_CAP) {
        await this.recordDrop(source.id, cfg);
        this.events.publish({ organizationId: source.orgId, type: 'delivery.received', leadSourceId: source.id });
        this.logger.warn(`Custom source ${source.id} dropped a delivery: ${backlog} held while unmapped`);
        return { kind: 'dropped', reason: 'setup_backlog_full' };
      }
    }

    const eventId = randomUUID();
    const created = await this.prisma.ingestEvent.createMany({
      data: [
        {
          id: eventId,
          orgId: source.orgId,
          leadSourceId: source.id,
          provider: CUSTOM_PROVIDER,
          eventType: known?.eventType ?? CUSTOM_EVENT_TYPE,
          dedupeKey,
          providerEventId: known?.providerEventId ?? null,
          providerSubmissionId: known?.providerSubmissionId ?? null,
          providerFormId: known?.providerFormId ?? null,
          providerCreatedAt: known?.submittedAt ?? null,
          rawBody: rawBody.toString('utf8'),
          payload: (body ?? {}) as Prisma.InputJsonValue,
          payloadHash,
          headers: redactHeaders(headers, cfg),
          contentLength: rawBody.byteLength,
          signatureState: sig.state,
          usedPreviousSecret: sig.usedPrevious,
          queueState: outcome ? QueueState.FAILED : QueueState.PENDING,
          outcome,
          outcomeReason: sig.quarantine
            ? sig.reason
            : invalidDetail
              ? 'invalid_payload'
              : paused
                ? 'source_paused'
                : listening
                  ? AWAITING_MAPPING
                  : null,
          errorMessage: invalidDetail,
          // The same hold a paused source uses; a delivery held for its
          // mapping is told apart by its outcome reason.
          availableAt: held ? HELD_UNTIL : new Date(),
        },
      ],
      // ON CONFLICT DO NOTHING against (lead_source_id, dedupe_key).
      skipDuplicates: true,
    });

    if (created.count === 0) {
      const existing = await this.prisma.ingestEvent.findUnique({
        where: { leadSourceId_dedupeKey: { leadSourceId: source.id, dedupeKey } },
        select: { id: true },
      });
      return { kind: 'duplicate', eventId: existing?.id ?? eventId };
    }

    await this.prisma.leadSource.update({
      where: { id: source.id },
      data: {
        lastEventAt: new Date(),
        // The first usable payload moves the source on to mapping.
        ...(!outcome && listening && source.ingestStatus === IngestStatus.AWAITING_FIRST_EVENT
          ? { ingestStatus: IngestStatus.NEEDS_MAPPING }
          : {}),
      },
    });

    this.events.publish({ organizationId: source.orgId, type: 'delivery.received', leadSourceId: source.id });

    if (sig.quarantine) {
      this.logger.warn(`Quarantined custom delivery ${eventId} for source ${source.id}: ${sig.reason}`);
      return { kind: 'quarantined', eventId, reason: sig.reason! };
    }
    if (invalidDetail) return { kind: 'invalid_payload', eventId, detail: invalidDetail };
    if (held) return { kind: 'held', eventId, reason: paused ? 'source_paused' : 'awaiting_mapping' };
    return { kind: 'accepted', eventId };
  }

  /**
   * The verdict, in the same terms the form routes record. A source whose
   * config cannot be read fails closed: required and missing, never accepted.
   */
  private evaluate(
    source: LeadSource,
    cfg: CustomConfig | null,
    rawBody: Buffer,
    headers: Record<string, unknown>,
  ): { state: SignatureState; usedPrevious: boolean; quarantine: boolean; reason?: 'invalid_signature' | 'signature_required' } {
    if (!cfg) return { state: SignatureState.MISSING, usedPrevious: false, quarantine: true, reason: 'signature_required' };
    if (cfg.auth.mode === 'none') return { state: SignatureState.NOT_CONFIGURED, usedPrevious: false, quarantine: false };

    const secretAad = aad.signingSecret(source.orgId, source.id);
    const current = source.signingSecretEnc ? this.secrets.open(source.signingSecretEnc, secretAad) : null;
    const graceOpen = source.previousSecretEnc && source.previousSecretValidUntil && source.previousSecretValidUntil > new Date();
    const previous = graceOpen ? this.secrets.open(source.previousSecretEnc!, secretAad) : null;

    const verdict = verifyCustomAuth(cfg.auth, { current, previous }, rawBody, headers);
    if (verdict.ok) return { state: SignatureState.VALID, usedPrevious: verdict.usedPrevious, quarantine: false };
    return {
      state: verdict.reason === 'signature_required' ? SignatureState.MISSING : SignatureState.INVALID,
      usedPrevious: false,
      quarantine: true,
      reason: verdict.reason,
    };
  }

  /**
   * Map a listening source from a known form's first payload and switch it on.
   * Only when nothing has been mapped yet and the heuristics find a phone or an
   * email; the mapping is HEURISTIC with status NEEDS_REVIEW, so new questions
   * keep auto-mapping until the owner signs it off, exactly as on the Tally
   * route. Returns false to leave the payload held for the owner.
   */
  private async autoActivate(source: LeadSource, cfg: CustomConfig, provider: string, known: NormalizedDelivery): Promise<boolean> {
    if (source.mappingStatus === MappingStatus.CONFIGURED) return false;
    const existing = await this.prisma.leadSourceFieldMapping.count({ where: { leadSourceId: source.id } });
    if (existing > 0) return false;

    const settings = await this.prisma.organizationSetting.findUnique({ where: { orgId: source.orgId }, select: { defaultRegion: true } });
    const region = settings?.defaultRegion ?? 'US';
    const fields = suggestFromAnswers(known.answers, region);
    if (fields.length === 0 || validateFields(fields).length > 0) return false;
    const rows = expandFields(fields, region);

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.leadSourceFieldMapping.createMany({
          data: rows.map((r) => ({
            orgId: source.orgId,
            leadSourceId: source.id,
            sourceFieldKey: r.source_field_key,
            targetField: r.target_field,
            transform: r.transform as unknown as Prisma.InputJsonValue,
            isActive: true,
            origin: MappingOrigin.HEURISTIC,
          })),
        });
        await tx.leadSource.update({
          where: { id: source.id },
          data: {
            mappingStatus: MappingStatus.NEEDS_REVIEW,
            mappingVersion: { increment: 1 },
            ingestStatus: IngestStatus.ACTIVE,
            customConfig: { ...cfg, activated: true } as unknown as Prisma.InputJsonValue,
          },
        });
        await this.audit.record(
          {
            orgId: source.orgId,
            actorType: 'system',
            action: 'custom_webhook.auto_activated',
            entityType: 'lead_source',
            entityId: source.id,
            payload: { provider, fields: fields.map((f) => `${f.path} -> ${f.target}`) },
          },
          tx,
        );
      });
    } catch (e) {
      // Two first deliveries at once: the other one wrote the mapping, which is
      // the same outcome.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return true;
      throw e;
    }
    this.logger.log(`Custom source ${source.id} mapped from a ${provider} payload and switched on (${rows.length} rows)`);
    return true;
  }

  private async recordDrop(sourceId: string, cfg: CustomConfig | null): Promise<void> {
    const next: CustomConfig = { ...(cfg ?? { auth: { mode: 'none' } }), dropped: (cfg?.dropped ?? 0) + 1 };
    await this.prisma.leadSource.update({
      where: { id: sourceId },
      data: { customConfig: next as unknown as Prisma.InputJsonValue, lastFailureAt: new Date() },
    });
  }
}

