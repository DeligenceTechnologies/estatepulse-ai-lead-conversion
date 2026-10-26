import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma, lead_sources } from '@prisma/client';
import { SecretBox, sha256Hex, signingSecretAad } from '../../common/crypto';
import { DeliveryOutcome, IngestStatus, MappingOrigin, MappingStatus, QueueState, SignatureState } from '../../common/domain';
import { newId } from '../../common/ids';
import { hashCredential, looksLikeIngestToken } from '../../common/tokens';
import { PrismaService } from '../../prisma/prisma.service';
import { EventsBus } from '../events/events.bus';
import { authHeaderName, headerValue, verifyCustomAuth, type CustomConfig } from './auth';
import { AWAITING_MAPPING, CUSTOM_EVENT_TYPE, CUSTOM_PROVIDER, HELD_CAP } from './constants';
import { detectAdapter } from './detect';
import type { NormalizedDelivery } from '../ingest/adapters/types';
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

/** A hold that never comes due on its own — the same device a paused source uses. */
const farFuture = () => new Date(Date.now() + 100 * 365 * 24 * 3600_000);

/**
 * Store only headers worth reading in support. The auth header is a secret (or
 * a MAC over the body) and is kept as a boolean; the delivery-id header, when
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
 * Deliberately a separate class from IngestService rather than a branch in it:
 * the Tally path stays byte-for-byte what it was. The row it writes is the
 * same webhook_events shape — raw body, dedupe key, queue state, hold — so the
 * worker and the deliveries screen need no second code path for storage.
 *
 * TODO(phase-5-manifests): merge into IngestService once it takes a provider.
 */
@Injectable()
export class CustomWebhookIngestService {
  private readonly logger = new Logger(CustomWebhookIngestService.name);
  private readonly secretBox: SecretBox;

  constructor(
    // Unguarded by necessity, exactly as IngestService is: the token in the URL
    // is how the tenant is discovered, so there is no organization id to scope
    // by until the row is in hand. Everything after the lookup stays inside it.
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly events: EventsBus,
  ) {
    this.secretBox = new SecretBox(
      this.config.getOrThrow<string>('ENCRYPTION_KEYS'),
      this.config.getOrThrow<string>('ENCRYPTION_ACTIVE_KEY_ID'),
    );
  }

  async receive(params: {
    token: string;
    rawBody: Buffer;
    /** Already parsed by the body parser: JSON or form fields. */
    body: unknown;
    headers: Record<string, unknown>;
  }): Promise<CustomIngestResult> {
    const { token, rawBody, body, headers } = params;

    if (!looksLikeIngestToken(token)) return { kind: 'unknown_token' };

    const source = await this.prisma.lead_sources.findUnique({
      where: { ingest_token_hash: hashCredential(token) },
    });
    // A token of another kind (a Tally one, say) is not ours to accept on this
    // route; 404 keeps the token spaces apart and confirms nothing.
    if (!source || source.provider !== CUSTOM_PROVIDER) {
      this.logger.warn(`Custom ingest rejected: unknown token ${token.slice(0, 12)}…`);
      return { kind: 'unknown_token' };
    }
    if (source.archived_at) return { kind: 'archived' };

    // --- Authentication ----------------------------------------------------
    const cfg = parseConfig(source.custom_config);
    const sig = await this.evaluate(source, cfg, rawBody, headers);

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
        ? `${adapter!.provider.toLowerCase()}:${known.providerEventId}`
        : `sha256:${payloadHash}`;

    const paused = source.ingest_status === IngestStatus.PAUSED || !source.is_active;
    // Listening until the owner maps the source and switches it on.
    let listening = !source.auto_create_leads;
    // A form we know, on a webhook nobody has mapped yet: the form's own
    // heuristics write the mapping and switch the source on right here, as the
    // provider's own route would — the owner reviews it rather than builds it.
    // Without a contact field among the questions the payload is held as usual.
    if (listening && !paused && known && adapter && !sig.quarantine && !invalidDetail) {
      if (await this.autoActivate(source, adapter.provider, known)) listening = false;
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
      const backlog = await this.prisma.webhook_events.count({
        where: { lead_source_id: source.id, queue_state: QueueState.PENDING, outcome_reason: AWAITING_MAPPING },
      });
      if (backlog >= HELD_CAP) {
        await this.recordDrop(source.id, cfg);
        this.events.publish({ organizationId: source.organization_id, type: 'delivery.received', leadSourceId: source.id });
        this.logger.warn(`Custom source ${source.id} dropped a delivery: ${backlog} held while unmapped`);
        return { kind: 'dropped', reason: 'setup_backlog_full' };
      }
    }

    const eventId = newId();
    const created = await this.prisma.webhook_events.createMany({
      data: [
        {
          id: eventId,
          organization_id: source.organization_id,
          lead_source_id: source.id,
          provider: CUSTOM_PROVIDER,
          event_type: known?.eventType ?? CUSTOM_EVENT_TYPE,
          // NEVER set: (provider, external_event_id) is unique across every
          // tenant, and two apps can both send "id: 1". Identity lives in
          // dedupe_key, which is unique per source.
          external_event_id: null,
          dedupe_key: dedupeKey,
          payload_hash: payloadHash,
          provider_submission_id: known?.providerSubmissionId ?? null,
          provider_form_id: known?.providerFormId ?? null,
          provider_created_at: known?.submittedAt ?? null,
          raw_body: rawBody.toString('utf8'),
          payload: (body ?? {}) as Prisma.InputJsonValue,
          headers: redactHeaders(headers, cfg) as Prisma.InputJsonValue,
          content_length: rawBody.byteLength,
          signature_verified: sig.state === SignatureState.VALID,
          signature_state: sig.state,
          used_previous_secret: sig.usedPrevious,
          queue_state: outcome ? QueueState.FAILED : QueueState.PENDING,
          processing_status: outcome ? 'failed' : 'received',
          outcome,
          outcome_reason: sig.quarantine
            ? sig.reason
            : invalidDetail
              ? 'invalid_payload'
              : paused
                ? 'source_paused'
                : listening
                  ? AWAITING_MAPPING
                  : null,
          error_message: invalidDetail,
          received_at: new Date(),
          available_at: held ? farFuture() : new Date(),
        },
      ],
      // ON CONFLICT DO NOTHING against webhook_events_source_dedupe_uniq.
      skipDuplicates: true,
    });

    if (created.count === 0) {
      const existing = await this.prisma.webhook_events.findFirst({
        where: { lead_source_id: source.id, dedupe_key: dedupeKey },
        select: { id: true },
      });
      return { kind: 'duplicate', eventId: existing?.id ?? eventId };
    }

    await this.prisma.lead_sources.update({
      where: { id: source.id },
      data: {
        last_event_at: new Date(),
        // The first usable payload moves the source on to mapping.
        ...(!outcome && listening && source.ingest_status === IngestStatus.AWAITING_FIRST_EVENT
          ? { ingest_status: IngestStatus.NEEDS_MAPPING }
          : {}),
      },
    });

    this.events.publish({ organizationId: source.organization_id, type: 'delivery.received', leadSourceId: source.id });

    if (sig.quarantine) {
      this.logger.warn(`Quarantined custom delivery ${eventId} for source ${source.id}: ${sig.reason}`);
      return { kind: 'quarantined', eventId, reason: sig.reason! };
    }
    if (invalidDetail) return { kind: 'invalid_payload', eventId, detail: invalidDetail };
    if (held) return { kind: 'held', eventId, reason: paused ? 'source_paused' : 'awaiting_mapping' };
    return { kind: 'accepted', eventId };
  }

  /**
   * The verdict, in the same terms the Tally path records. A source whose
   * config cannot be read fails closed: required and missing, never accepted.
   */
  private async evaluate(
    source: {
      id: string;
      organization_id: string;
      signing_secret_enc: string | null;
      previous_secret_enc: string | null;
      previous_secret_valid_until: Date | null;
    },
    cfg: CustomConfig | null,
    rawBody: Buffer,
    headers: Record<string, unknown>,
  ): Promise<{ state: SignatureState; usedPrevious: boolean; quarantine: boolean; reason?: 'invalid_signature' | 'signature_required' }> {
    if (!cfg) return { state: SignatureState.MISSING, usedPrevious: false, quarantine: true, reason: 'signature_required' };
    if (cfg.auth.mode === 'none') return { state: SignatureState.NOT_CONFIGURED, usedPrevious: false, quarantine: false };

    const aad = signingSecretAad(source.organization_id, source.id);
    const current = source.signing_secret_enc ? this.secretBox.decrypt(source.signing_secret_enc, aad) : null;
    const graceOpen =
      source.previous_secret_enc && source.previous_secret_valid_until && source.previous_secret_valid_until > new Date();
    const previous = graceOpen ? this.secretBox.decrypt(source.previous_secret_enc!, aad) : null;

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
  private async autoActivate(source: lead_sources, provider: string, known: NormalizedDelivery): Promise<boolean> {
    if (source.mapping_status === MappingStatus.CONFIGURED) return false;
    const existing = await this.prisma.lead_source_field_mappings.count({ where: { lead_source_id: source.id } });
    if (existing > 0) return false;

    const org = await this.prisma.organizations.findUnique({ where: { id: source.organization_id }, select: { default_region: true } });
    const region = org?.default_region ?? 'US';
    const fields = suggestFromAnswers(known.answers, region);
    if (fields.length === 0 || validateFields(fields).length > 0) return false;
    const rows = expandFields(fields, region);

    try {
      await this.prisma.$transaction([
        this.prisma.lead_source_field_mappings.createMany({
          data: rows.map((r) => ({
            id: newId(),
            organization_id: source.organization_id,
            lead_source_id: source.id,
            source_field_key: r.source_field_key,
            target_field: r.target_field,
            transform: r.transform as unknown as Prisma.InputJsonValue,
            is_active: true,
            origin: MappingOrigin.HEURISTIC,
          })),
        }),
        this.prisma.lead_sources.update({
          where: { id: source.id },
          data: {
            mapping_status: MappingStatus.NEEDS_REVIEW,
            mapping_version: { increment: 1 },
            auto_create_leads: true,
            ingest_status: IngestStatus.ACTIVE,
          },
        }),
        this.prisma.audit_logs.create({
          data: {
            id: newId(),
            organization_id: source.organization_id,
            actor_type: 'system',
            action: 'custom_webhook.auto_activated',
            entity_type: 'lead_source',
            entity_id: source.id,
            payload: { provider, fields: fields.map((f) => `${f.path} -> ${f.target}`) } as Prisma.InputJsonValue,
          },
        }),
      ]);
    } catch (e) {
      // Two first deliveries at once: the other one wrote the mapping, which is
      // the same outcome.
      if ((e as { code?: string }).code === 'P2002') return true;
      throw e;
    }
    this.logger.log(`Custom source ${source.id} mapped from a ${provider} payload and switched on (${rows.length} rows)`);
    return true;
  }

  private async recordDrop(sourceId: string, cfg: CustomConfig | null): Promise<void> {
    const next: CustomConfig = { ...(cfg ?? { auth: { mode: 'none' } }), dropped: (cfg?.dropped ?? 0) + 1 };
    await this.prisma.lead_sources.update({
      where: { id: sourceId },
      data: { custom_config: next as unknown as Prisma.InputJsonValue, last_failure_at: new Date() },
    });
  }
}
