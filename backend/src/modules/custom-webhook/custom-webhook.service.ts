import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma, lead_sources } from '@prisma/client';
import { SecretBox, ingestTokenAad, signingSecretAad } from '../../common/crypto';
import { ConnectionMethod, DeliveryOutcome, IngestStatus, MappingOrigin, MappingStatus, QueueState } from '../../common/domain';
import { AppError } from '../../common/errors';
import { newId } from '../../common/ids';
import { generateIngestToken, generateSigningSecret } from '../../common/tokens';
import { TENANT_PRISMA, type GuardedPrisma } from '../../prisma/prisma.service';
import { LeadSourcesService } from '../lead-sources/lead-sources.service';
import { ProcessingWorker } from '../processing/worker.service';
import { needsSecret, type CustomConfig } from './auth';
import { AWAITING_MAPPING, CAPTURED_DURING_SETUP, CUSTOM_PROVIDER } from './constants';
import { previewLead } from './extract';
import { flatten } from './flatten';
import { expandFields, fieldsFromRows, suggestFields, validateFields, type StoredMapping } from './mapping';
import { parseConfig, type CreateBody, type SaveMappingBody, type TestBody, type UpdateAuthBody } from './schemas';

export interface Identity {
  organizationId: string;
  userId: string;
}

/** How long a replaced secret keeps verifying, as the Tally rotate endpoint allows. */
const GRACE_MINUTES = 60;

/**
 * The owner's side of a custom webhook: create it, read the first payload,
 * map it, try the mapping, switch it on.
 *
 * Everything is an ordinary lead_sources row (provider CUSTOM, source_type
 * 'webhook'), so the Lead Sources screen, the deliveries read-back, pause and
 * secret rotation all work on it unchanged. What is specific lives in
 * custom_config (auth, non-secret) and in the mapping rows.
 */
@Injectable()
export class CustomWebhookService {
  private readonly secretBox: SecretBox;

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma,
    private readonly config: ConfigService,
    private readonly leadSources: LeadSourcesService,
    private readonly worker: ProcessingWorker,
  ) {
    this.secretBox = new SecretBox(
      this.config.getOrThrow<string>('ENCRYPTION_KEYS'),
      this.config.getOrThrow<string>('ENCRYPTION_ACTIVE_KEY_ID'),
    );
  }

  /** Creates the source listening. The token is shown again later; the secret only now. */
  async create(who: Identity, body: CreateBody) {
    const id = newId();
    const token = generateIngestToken('live');
    const secret = needsSecret(body.auth) ? generateSigningSecret() : null;
    const code = await this.leadSources.uniqueCode(who.organizationId, body.name);
    const cfg: CustomConfig = { auth: body.auth, ...(body.deliveryIdHeader ? { deliveryIdHeader: body.deliveryIdHeader } : {}) };

    const created = await this.prisma.lead_sources.create({
      data: {
        id,
        organization_id: who.organizationId,
        name: body.name.slice(0, 100),
        code,
        source_type: 'webhook',
        provider: CUSTOM_PROVIDER,
        connection_method: ConnectionMethod.MANUAL,
        is_active: true,
        ingest_token_hash: token.hash,
        ingest_token_prefix: token.prefix,
        ingest_token_enc: this.secretBox.encrypt(token.token, ingestTokenAad(who.organizationId, id)),
        ...(secret
          ? {
              signing_secret_enc: this.secretBox.encrypt(secret, signingSecretAad(who.organizationId, id)),
              signing_secret_last4: secret.slice(-4),
              signing_secret_set_at: new Date(),
            }
          : {}),
        require_signature: needsSecret(body.auth),
        ingest_status: IngestStatus.AWAITING_FIRST_EVENT,
        mapping_status: MappingStatus.UNCONFIGURED,
        // Listening: nothing becomes a lead until the owner maps and switches it on.
        auto_create_leads: false,
        default_consent_status: 'pending',
        custom_config: cfg as unknown as Prisma.InputJsonValue,
      },
    });
    await this.audit(who, created.id, 'custom_webhook.created', { name: created.name, auth: body.auth.mode });
    return { ...(await this.dto(created)), secret };
  }

  async get(organizationId: string, id: string) {
    return this.dto(await this.source(organizationId, id));
  }

  /** The latest usable payload, flattened to paths, with a suggested mapping. */
  async sample(organizationId: string, id: string) {
    const row = await this.source(organizationId, id);
    const base = await this.dto(row);
    const latest = await this.latestDelivery(row);
    if (!latest) return { ...base, delivery: null, paths: [], truncated: false, suggested: [] };
    const { leaves, truncated } = flatten(latest.payload);
    const region = await this.region(organizationId);
    return {
      ...base,
      delivery: { id: latest.id, receivedAt: latest.received_at, held: latest.outcome_reason === AWAITING_MAPPING },
      paths: leaves,
      truncated,
      suggested: suggestFields(leaves, region),
    };
  }

  async saveMapping(who: Identity, id: string, body: SaveMappingBody) {
    const row = await this.source(who.organizationId, id);
    const errors = validateFields(body.fields);
    if (errors.length) throw new AppError('VALIDATION_ERROR', 'The mapping needs a change before it can be saved', errors);
    const rows = expandFields(body.fields, await this.region(who.organizationId));

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.lead_source_field_mappings.deleteMany({ where: { organization_id: who.organizationId, lead_source_id: row.id } });
      await tx.lead_source_field_mappings.createMany({
        data: rows.map((r) => ({
          id: newId(),
          organization_id: who.organizationId,
          lead_source_id: row.id,
          source_field_key: r.source_field_key,
          target_field: r.target_field,
          transform: r.transform as unknown as Prisma.InputJsonValue,
          is_active: true,
          origin: MappingOrigin.USER,
        })),
      });
      return tx.lead_sources.update({
        where: { id: row.id },
        data: { mapping_status: MappingStatus.CONFIGURED, mapping_version: { increment: 1 } },
      });
    });
    await this.audit(who, row.id, 'custom_webhook.mapping_saved', { fields: body.fields.length, version: updated.mapping_version });
    return this.dto(updated);
  }

  /**
   * A dry run of the mapping over the latest payload: the draft on screen when
   * `fields` is sent, the saved mapping otherwise. Writes nothing.
   */
  async test(organizationId: string, id: string, body: TestBody) {
    const row = await this.source(organizationId, id);
    const latest = await this.latestDelivery(row);
    if (!latest) throw new AppError('CONFLICT', 'No payload has arrived yet — send one to the webhook URL first');
    const region = await this.region(organizationId);

    let mappings: StoredMapping[];
    if (body.fields) {
      const errors = validateFields(body.fields);
      if (errors.length) throw new AppError('VALIDATION_ERROR', 'The mapping needs a change before it can be tried', errors);
      mappings = expandFields(body.fields, region);
    } else {
      mappings = await this.storedMappings(row);
      if (mappings.length === 0) throw new AppError('CONFLICT', 'Save a mapping first');
    }
    return { delivery: { id: latest.id, receivedAt: latest.received_at }, preview: previewLead(latest.payload, mappings, region) };
  }

  /**
   * Switches the source on. Deliveries held while it was being set up are
   * released to the worker, which creates their leads paused and flagged
   * (see CAPTURED_DURING_SETUP) rather than auto-contacting anyone.
   */
  async activate(who: Identity, id: string) {
    const row = await this.source(who.organizationId, id);
    if (row.mapping_status !== MappingStatus.CONFIGURED) throw new AppError('CONFLICT', 'Save a mapping before switching the webhook on');

    const { updated, released } = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.lead_sources.update({
        where: { id: row.id },
        data: { auto_create_leads: true, is_active: true, ingest_status: IngestStatus.ACTIVE },
      });
      const rel = await tx.webhook_events.updateMany({
        where: { organization_id: who.organizationId, lead_source_id: row.id, queue_state: QueueState.PENDING, outcome_reason: AWAITING_MAPPING },
        data: { outcome_reason: CAPTURED_DURING_SETUP, available_at: new Date() },
      });
      return { updated, released: rel.count };
    });
    await this.audit(who, row.id, 'custom_webhook.activated', { released });
    if (released > 0) this.worker.nudge();
    return { ...(await this.dto(updated)), released };
  }

  /** Changes the auth mode. A mode that needs a secret gets a fresh one, shown once; the old one keeps verifying for the grace window. */
  async updateAuth(who: Identity, id: string, body: UpdateAuthBody) {
    const row = await this.source(who.organizationId, id);
    const cfg = parseConfig(row.custom_config);
    const secret = needsSecret(body.auth) ? generateSigningSecret() : null;
    const deliveryIdHeader = body.deliveryIdHeader === undefined ? cfg?.deliveryIdHeader : (body.deliveryIdHeader ?? undefined);
    const next: CustomConfig = {
      auth: body.auth,
      ...(deliveryIdHeader ? { deliveryIdHeader } : {}),
      ...(cfg?.dropped ? { dropped: cfg.dropped } : {}),
    };

    const updated = await this.prisma.lead_sources.update({
      where: { id: row.id },
      data: {
        custom_config: next as unknown as Prisma.InputJsonValue,
        require_signature: needsSecret(body.auth),
        ...(secret
          ? {
              previous_secret_enc: row.signing_secret_enc,
              previous_secret_valid_until: row.signing_secret_enc ? new Date(Date.now() + GRACE_MINUTES * 60_000) : null,
              signing_secret_enc: this.secretBox.encrypt(secret, signingSecretAad(who.organizationId, row.id)),
              signing_secret_last4: secret.slice(-4),
              signing_secret_set_at: new Date(),
            }
          : {}),
      },
    });
    await this.audit(who, row.id, 'custom_webhook.auth_changed', { auth: body.auth.mode });
    return { ...(await this.dto(updated)), secret };
  }

  // --- helpers ----------------------------------------------------------------

  private async source(organizationId: string, id: string): Promise<lead_sources> {
    const row = await this.prisma.lead_sources.findFirst({
      where: { id, organization_id: organizationId, provider: CUSTOM_PROVIDER, archived_at: null },
    });
    if (!row) throw new AppError('NOT_FOUND', 'No such custom webhook');
    return row;
  }

  private async region(organizationId: string): Promise<string> {
    const org = await this.prisma.organizations.findFirst({ where: { id: organizationId }, select: { default_region: true } });
    return org?.default_region ?? 'US';
  }

  /** The newest delivery that carries a readable payload: pending, held or processed; never quarantined or malformed. */
  private latestDelivery(row: lead_sources) {
    return this.prisma.webhook_events.findFirst({
      where: {
        organization_id: row.organization_id,
        lead_source_id: row.id,
        OR: [{ outcome: null }, { outcome: { notIn: [DeliveryOutcome.QUARANTINED_SIGNATURE, DeliveryOutcome.INVALID_PAYLOAD] } }],
      },
      orderBy: { received_at: 'desc' },
      select: { id: true, received_at: true, payload: true, outcome_reason: true },
    });
  }

  private async storedMappings(row: lead_sources): Promise<StoredMapping[]> {
    const rows = await this.prisma.lead_source_field_mappings.findMany({
      where: { organization_id: row.organization_id, lead_source_id: row.id, is_active: true },
    });
    return rows.map((r) => ({
      source_field_key: r.source_field_key,
      target_field: r.target_field,
      transform: r.transform as unknown as StoredMapping['transform'],
    }));
  }

  private async dto(row: lead_sources) {
    const [held, mappings] = await Promise.all([
      this.prisma.webhook_events.count({
        where: { organization_id: row.organization_id, lead_source_id: row.id, queue_state: QueueState.PENDING, outcome_reason: AWAITING_MAPPING },
      }),
      this.storedMappings(row),
    ]);
    const cfg = parseConfig(row.custom_config);
    const token = row.ingest_token_enc ? this.secretBox.decrypt(row.ingest_token_enc, ingestTokenAad(row.organization_id, row.id)) : null;
    return {
      ...this.leadSources.summarize(row, token),
      custom: {
        auth: cfg?.auth ?? { mode: 'none' as const },
        deliveryIdHeader: cfg?.deliveryIdHeader ?? null,
        /** Deliveries dropped at the held cap while the source was unmapped. */
        dropped: cfg?.dropped ?? 0,
        activated: row.auto_create_leads,
        held,
        mappingConfigured: row.mapping_status === MappingStatus.CONFIGURED,
        mappingVersion: row.mapping_version,
        fields: fieldsFromRows(mappings),
      },
    };
  }

  private audit(who: Identity, sourceId: string, action: string, payload: Record<string, unknown>) {
    return this.prisma.audit_logs.create({
      data: {
        id: newId(),
        organization_id: who.organizationId,
        actor_type: 'user',
        actor_id: who.userId,
        action,
        entity_type: 'lead_source',
        entity_id: sourceId,
        payload: payload as Prisma.InputJsonValue,
      },
    });
  }
}
