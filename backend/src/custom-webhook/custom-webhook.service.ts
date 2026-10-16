import { Injectable } from '@nestjs/common';
import {
  ConnectionMethod,
  DeliveryOutcome,
  IngestStatus,
  MappingOrigin,
  MappingStatus,
  QueueState,
  type LeadSource,
  type Prisma,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AuditService } from '@/audit/audit.service';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { SecretBoxService } from '@/common/service/secret-box.service';
import { aad, generateIngestToken, generateSigningSecret } from '@/common/utils/crypto';
import { ProcessingWorker } from '@/ingest/processing/worker.service';
import { LeadSourcesService } from '@/lead-source/lead-sources.service';
import { needsSecret, type CustomConfig } from './auth';
import { AWAITING_MAPPING, CAPTURED_DURING_SETUP, CUSTOM_PROVIDER } from './constants';
import { detectAdapter } from './detect';
import { previewLead } from './extract';
import { flatten } from './flatten';
import {
  expandFields,
  fieldsFromRows,
  suggestFields,
  suggestFromAnswers,
  toStoredMapping,
  validateFields,
  type StoredMapping,
} from './mapping';
import { parseConfig, type CreateBody, type SaveMappingBody, type TestBody, type UpdateAuthBody } from './schemas';

export interface Identity {
  organizationId: string;
  userId: string;
}

/** How long a replaced secret keeps verifying, as the rotate endpoint allows. */
const GRACE_MINUTES = 60;

/**
 * The owner's side of a custom webhook: create it, read the first payload,
 * map it, try the mapping, switch it on.
 *
 * Everything is an ordinary lead_sources row (provider CUSTOM, connection
 * MANUAL), so the Lead Sources screen, the deliveries read-back, pause and
 * secret rotation all work on it unchanged. What is specific lives in
 * custom_config (auth, non-secret, and whether it is switched on) and in the
 * mapping rows.
 */
@Injectable()
export class CustomWebhookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretBoxService,
    private readonly audit: AuditService,
    private readonly leadSources: LeadSourcesService,
    private readonly worker: ProcessingWorker,
  ) {}

  /** Creates the source listening. The token is shown again later; the secret only now. */
  async create(who: Identity, body: CreateBody) {
    const id = randomUUID();
    const token = generateIngestToken('live');
    const secret = needsSecret(body.auth) ? generateSigningSecret() : null;
    const code = await this.leadSources.uniqueCode(who.organizationId, body.name);
    const cfg: CustomConfig = { auth: body.auth, ...(body.deliveryIdHeader ? { deliveryIdHeader: body.deliveryIdHeader } : {}) };

    const created = await this.prisma.leadSource.create({
      data: {
        id,
        orgId: who.organizationId,
        name: body.name.slice(0, 100),
        code,
        provider: CUSTOM_PROVIDER,
        connectionMethod: ConnectionMethod.MANUAL,
        isActive: true,
        ingestTokenHash: token.hash,
        ingestTokenPrefix: token.prefix,
        ingestTokenEnc: this.secrets.seal(token.token, aad.ingestToken(who.organizationId, id)),
        ...(secret
          ? {
              signingSecretEnc: this.secrets.seal(secret, aad.signingSecret(who.organizationId, id)),
              signingSecretLast4: secret.slice(-4),
              signingSecretSetAt: new Date(),
            }
          : {}),
        requireSignature: needsSecret(body.auth),
        ingestStatus: IngestStatus.AWAITING_FIRST_EVENT,
        mappingStatus: MappingStatus.UNCONFIGURED,
        defaultConsentStatus: 'pending',
        // Listening: nothing becomes a lead until the owner maps and switches it on.
        customConfig: cfg as unknown as Prisma.InputJsonValue,
      },
    });
    await this.record(who, created.id, 'custom_webhook.created', { name: created.name, auth: body.auth.mode });
    return { ...(await this.dto(created)), secret };
  }

  async get(organizationId: string, id: string) {
    return this.dto(await this.source(organizationId, id));
  }

  /** The latest usable payload as mappable fields — a form's questions, or plain JSON paths — with a suggested mapping. */
  async sample(organizationId: string, id: string) {
    const row = await this.source(organizationId, id);
    const base = await this.dto(row);
    const latest = await this.latestDelivery(row);
    if (!latest) return { ...base, delivery: null, format: null, paths: [], truncated: false, suggested: [] };
    const region = await this.region(organizationId);
    const delivery = { id: latest.id, receivedAt: latest.receivedAt, held: latest.outcomeReason === AWAITING_MAPPING };

    // A form provider's payload: its questions, by their stable keys, with the
    // provider's own heuristics as the prefill (option maps included).
    const adapter = detectAdapter(latest.payload);
    if (adapter) {
      const parsed = adapter.parse(latest.payload);
      return {
        ...base,
        delivery,
        format: adapter.provider,
        paths: parsed.answers.map((a) => ({ path: a.key, label: a.label, value: a.scalarText, type: a.type })),
        truncated: false,
        suggested: suggestFromAnswers(parsed.answers, region),
      };
    }

    const { leaves, truncated } = flatten(latest.payload);
    return {
      ...base,
      delivery,
      format: null,
      paths: leaves.map((l) => ({ ...l, label: l.path })),
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
      await tx.leadSourceFieldMapping.deleteMany({ where: { orgId: who.organizationId, leadSourceId: row.id } });
      await tx.leadSourceFieldMapping.createMany({
        data: rows.map((r) => ({
          orgId: who.organizationId,
          leadSourceId: row.id,
          sourceFieldKey: r.source_field_key,
          targetField: r.target_field,
          transform: r.transform as unknown as Prisma.InputJsonValue,
          isActive: true,
          origin: MappingOrigin.USER,
        })),
      });
      return tx.leadSource.update({
        where: { id: row.id },
        data: { mappingStatus: MappingStatus.CONFIGURED, mappingVersion: { increment: 1 } },
      });
    });
    await this.record(who, row.id, 'custom_webhook.mapping_saved', { fields: body.fields.length, version: updated.mappingVersion });
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
    return { delivery: { id: latest.id, receivedAt: latest.receivedAt }, preview: previewLead(latest.payload, mappings, region) };
  }

  /**
   * Switches the source on. Deliveries held while it was being set up are
   * released to the worker, which creates their leads paused and flagged
   * (see CAPTURED_DURING_SETUP) rather than auto-contacting anyone.
   */
  async activate(who: Identity, id: string) {
    const row = await this.source(who.organizationId, id);
    if (row.mappingStatus !== MappingStatus.CONFIGURED) throw new AppError('CONFLICT', 'Save a mapping before switching the webhook on');
    const cfg = parseConfig(row.customConfig) ?? { auth: { mode: 'none' as const } };

    const { updated, released } = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.leadSource.update({
        where: { id: row.id },
        data: {
          isActive: true,
          ingestStatus: IngestStatus.ACTIVE,
          customConfig: { ...cfg, activated: true } as unknown as Prisma.InputJsonValue,
        },
      });
      const rel = await tx.ingestEvent.updateMany({
        where: { orgId: who.organizationId, leadSourceId: row.id, queueState: QueueState.PENDING, outcomeReason: AWAITING_MAPPING },
        data: { outcomeReason: CAPTURED_DURING_SETUP, availableAt: new Date() },
      });
      return { updated, released: rel.count };
    });
    await this.record(who, row.id, 'custom_webhook.activated', { released });
    if (released > 0) this.worker.nudge();
    return { ...(await this.dto(updated)), released };
  }

  /** Changes the auth mode. A mode that needs a secret gets a fresh one, shown once; the old one keeps verifying for the grace window. */
  async updateAuth(who: Identity, id: string, body: UpdateAuthBody) {
    const row = await this.source(who.organizationId, id);
    const cfg = parseConfig(row.customConfig);
    const secret = needsSecret(body.auth) ? generateSigningSecret() : null;
    const deliveryIdHeader = body.deliveryIdHeader === undefined ? cfg?.deliveryIdHeader : (body.deliveryIdHeader ?? undefined);
    const next: CustomConfig = {
      auth: body.auth,
      ...(deliveryIdHeader ? { deliveryIdHeader } : {}),
      ...(cfg?.dropped ? { dropped: cfg.dropped } : {}),
      ...(cfg?.activated ? { activated: true } : {}),
    };

    const updated = await this.prisma.leadSource.update({
      where: { id: row.id },
      data: {
        customConfig: next as unknown as Prisma.InputJsonValue,
        requireSignature: needsSecret(body.auth),
        ...(secret
          ? {
              previousSecretEnc: row.signingSecretEnc,
              previousSecretValidUntil: row.signingSecretEnc ? new Date(Date.now() + GRACE_MINUTES * 60_000) : null,
              signingSecretEnc: this.secrets.seal(secret, aad.signingSecret(who.organizationId, row.id)),
              signingSecretLast4: secret.slice(-4),
              signingSecretSetAt: new Date(),
            }
          : {}),
      },
    });
    await this.record(who, row.id, 'custom_webhook.auth_changed', { auth: body.auth.mode });
    return { ...(await this.dto(updated)), secret };
  }

  // --- helpers ----------------------------------------------------------------

  private async source(organizationId: string, id: string): Promise<LeadSource> {
    const row = await this.prisma.leadSource.findFirst({
      where: { id, orgId: organizationId, provider: CUSTOM_PROVIDER, archivedAt: null },
    });
    if (!row) throw new AppError('NOT_FOUND', 'No such custom webhook');
    return row;
  }

  private async region(organizationId: string): Promise<string> {
    const settings = await this.prisma.organizationSetting.findUnique({ where: { orgId: organizationId }, select: { defaultRegion: true } });
    return settings?.defaultRegion ?? 'US';
  }

  /** The newest delivery that carries a readable payload: pending, held or processed; never quarantined or malformed. */
  private latestDelivery(row: LeadSource) {
    return this.prisma.ingestEvent.findFirst({
      where: {
        orgId: row.orgId,
        leadSourceId: row.id,
        OR: [{ outcome: null }, { outcome: { notIn: [DeliveryOutcome.QUARANTINED_SIGNATURE, DeliveryOutcome.INVALID_PAYLOAD] } }],
      },
      orderBy: { receivedAt: 'desc' },
      select: { id: true, receivedAt: true, payload: true, outcomeReason: true },
    });
  }

  private async storedMappings(row: LeadSource): Promise<StoredMapping[]> {
    const rows = await this.prisma.leadSourceFieldMapping.findMany({
      where: { orgId: row.orgId, leadSourceId: row.id, isActive: true },
    });
    return rows.map(toStoredMapping);
  }

  private async dto(row: LeadSource) {
    const [held, mappings] = await Promise.all([
      this.prisma.ingestEvent.count({
        where: { orgId: row.orgId, leadSourceId: row.id, queueState: QueueState.PENDING, outcomeReason: AWAITING_MAPPING },
      }),
      this.storedMappings(row),
    ]);
    const cfg = parseConfig(row.customConfig);
    return {
      ...this.leadSources.toSummary(row, null, true),
      custom: {
        auth: cfg?.auth ?? { mode: 'none' as const },
        deliveryIdHeader: cfg?.deliveryIdHeader ?? null,
        /** Deliveries dropped at the held cap while the source was unmapped. */
        dropped: cfg?.dropped ?? 0,
        activated: cfg?.activated ?? false,
        held,
        mappingConfigured: row.mappingStatus === MappingStatus.CONFIGURED,
        mappingVersion: row.mappingVersion,
        fields: fieldsFromRows(mappings),
      },
    };
  }

  private record(who: Identity, sourceId: string, action: string, payload: Prisma.InputJsonObject) {
    return this.audit.record({
      orgId: who.organizationId,
      actorType: 'user',
      actorId: who.userId,
      action,
      entityType: 'lead_source',
      entityId: sourceId,
      payload,
    });
  }
}

