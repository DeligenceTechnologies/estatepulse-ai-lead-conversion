import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SecretBox, ingestTokenAad, signingSecretAad } from '../../common/crypto';
import { IngestStatus, MappingStatus } from '../../common/domain';
import { newId } from '../../common/ids';
import { generateIngestToken, generateSigningSecret, secretPreview } from '../../common/tokens';
import { PrismaService } from '../../prisma/prisma.service';
import { TallyAdapter } from '../ingest/adapters/tally.adapter';

export interface CreateLeadSourceInput {
  name: string;
  requireSignature?: boolean;
}

@Injectable()
export class LeadSourcesService {
  private readonly adapter = new TallyAdapter();
  private readonly secretBox: SecretBox;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.secretBox = new SecretBox(
      this.config.getOrThrow<string>('ENCRYPTION_KEYS'),
      this.config.getOrThrow<string>('ENCRYPTION_ACTIVE_KEY_ID'),
    );
  }

  private ingestUrl(token: string): string {
    return `${this.config.get<string>('PUBLIC_API_BASE_URL')}/ingest/v1/tally/${token}`;
  }

  /**
   * Creates a source and returns the webhook URL and signing secret.
   *
   * The signing secret is returned HERE AND NOWHERE ELSE — no GET ever exposes
   * it, which makes "shown once" a property of the API surface rather than a
   * convention the UI has to remember. The ingest token is different: it is
   * encrypted rather than hashed precisely so the URL can be shown again, since
   * a customer will come back next week to paste it into a second form.
   */
  async create(organizationId: string, input: CreateLeadSourceInput) {
    // The id must exist before encrypting: the AAD binds each ciphertext to
    // (organization_id, lead_source_id).
    const id = newId();
    const token = generateIngestToken('live');
    const secret = generateSigningSecret();

    const baseCode = input.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 36) || 'webhook';

    // (organization_id, code) is unique in the Phase One schema.
    let code = baseCode;
    for (let n = 2; await this.prisma.lead_sources.findFirst({
      where: { organization_id: organizationId, code },
      select: { id: true },
    }); n++) {
      code = `${baseCode.slice(0, 33)}_${n}`;
    }

    const created = await this.prisma.lead_sources.create({
      data: {
        id,
        organization_id: organizationId,
        name: input.name.slice(0, 100),
        code,
        source_type: 'webhook',
        is_active: true,
        ingest_token_hash: token.hash,
        ingest_token_prefix: token.prefix,
        ingest_token_enc: this.secretBox.encrypt(token.token, ingestTokenAad(organizationId, id)),
        signing_secret_enc: this.secretBox.encrypt(secret, signingSecretAad(organizationId, id)),
        signing_secret_last4: secret.slice(-4),
        signing_secret_set_at: new Date(),
        // Default to verify-if-present. Requiring a signature before the
        // customer has pasted the secret into Tally would quarantine their very
        // first submission — a terrible first impression.
        require_signature: input.requireSignature ?? false,
        ingest_status: IngestStatus.AWAITING_FIRST_EVENT,
        mapping_status: MappingStatus.UNCONFIGURED,
        auto_create_leads: true,
        default_consent_status: 'pending',
      },
    });

    return {
      ...this.toSummary(created, token.token),
      signingSecret: secret, // the only time this is ever returned
    };
  }

  async list(organizationId: string) {
    const rows = await this.prisma.lead_sources.findMany({
      where: { organization_id: organizationId, source_type: 'webhook' },
      orderBy: { created_at: 'desc' },
    });

    const counts = await this.prisma.webhook_events.groupBy({
      by: ['lead_source_id'],
      where: { organization_id: organizationId },
      _count: { _all: true },
    });
    const bySource = new Map(counts.map((c) => [c.lead_source_id, c._count._all]));

    return rows.map((r) => ({
      ...this.toSummary(r, this.decryptToken(r)),
      deliveryCount: bySource.get(r.id) ?? 0,
    }));
  }

  async get(organizationId: string, id: string) {
    const row = await this.prisma.lead_sources.findFirst({
      where: { id, organization_id: organizationId },
    });
    if (!row) throw new NotFoundException({ error: { code: 'NOT_FOUND' } });
    return this.toSummary(row, this.decryptToken(row));
  }

  /**
   * Rotates the signing secret, keeping the old one valid for a grace window.
   *
   * Without the grace window, every submission fails from the instant the
   * customer clicks Rotate until they finish pasting the new secret into Tally.
   */
  async rotateSecret(organizationId: string, id: string, graceMinutes = 60) {
    const row = await this.prisma.lead_sources.findFirst({
      where: { id, organization_id: organizationId },
    });
    if (!row) throw new NotFoundException({ error: { code: 'NOT_FOUND' } });

    const aad = signingSecretAad(organizationId, id);
    const next = generateSigningSecret();

    await this.prisma.lead_sources.update({
      where: { id },
      data: {
        previous_secret_enc: row.signing_secret_enc,
        previous_secret_valid_until: new Date(Date.now() + graceMinutes * 60_000),
        signing_secret_enc: this.secretBox.encrypt(next, aad),
        signing_secret_last4: next.slice(-4),
        signing_secret_set_at: new Date(),
      },
    });

    return { signingSecret: next, graceMinutes };
  }

  async setPaused(organizationId: string, id: string, paused: boolean) {
    const row = await this.prisma.lead_sources.findFirst({
      where: { id, organization_id: organizationId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException({ error: { code: 'NOT_FOUND' } });

    await this.prisma.lead_sources.update({
      where: { id },
      data: {
        ingest_status: paused ? IngestStatus.PAUSED : IngestStatus.AWAITING_FIRST_EVENT,
        is_active: !paused,
      },
    });
    return { paused };
  }

  /**
   * Recent deliveries, with the payload parsed into readable question/answer
   * pairs.
   *
   * Parsing on read (rather than only in the worker) is what lets someone
   * confirm "is my data arriving correctly?" before any mapping exists — which
   * is the entire question during setup.
   */
  async deliveries(organizationId: string, id: string, limit = 25) {
    const rows = await this.prisma.webhook_events.findMany({
      where: { organization_id: organizationId, lead_source_id: id },
      orderBy: { received_at: 'desc' },
      take: Math.min(limit, 100),
    });

    return rows.map((r) => {
      let answers: { label: string; type: string; value: string }[] = [];
      let parseError: string | null = null;

      if (r.payload) {
        try {
          const parsed = this.adapter.parse(r.payload);
          answers = parsed.answers.map((a) => ({
            label: a.label,
            type: a.type,
            // Already option-UUID-resolved by the adapter, so a dropdown reads
            // "ASAP / under 30 days" and not "opt_a".
            value: a.scalarText,
          }));
        } catch (e) {
          parseError = e instanceof Error ? e.message : String(e);
        }
      }

      return {
        id: r.id,
        receivedAt: r.received_at,
        providerEventId: r.external_event_id,
        signatureState: r.signature_state,
        usedPreviousSecret: r.used_previous_secret,
        queueState: r.queue_state,
        outcome: r.outcome,
        outcomeReason: r.outcome_reason,
        errorMessage: r.error_message,
        bodyBytes: r.content_length,
        formName: (r.payload as Record<string, never> | null)?.['data']?.['formName'] ?? null,
        answers,
        parseError,
      };
    });
  }

  private decryptToken(row: { id: string; organization_id: string; ingest_token_enc: string | null }): string | null {
    if (!row.ingest_token_enc) return null;
    try {
      return this.secretBox.decrypt(row.ingest_token_enc, ingestTokenAad(row.organization_id, row.id));
    } catch {
      return null;
    }
  }

  private toSummary(
    row: {
      id: string;
      name: string;
      code: string;
      is_active: boolean;
      require_signature: boolean;
      ingest_status: string | null;
      mapping_status: string | null;
      signing_secret_last4: string | null;
      signing_secret_set_at: Date | null;
      external_form_name: string | null;
      last_event_at: Date | null;
      created_at: Date;
    },
    token: string | null,
  ) {
    return {
      id: row.id,
      name: row.name,
      code: row.code,
      isActive: row.is_active,
      requireSignature: row.require_signature,
      ingestStatus: row.ingest_status,
      mappingStatus: row.mapping_status,
      // Never the secret itself — only proof that one is configured.
      signingSecretPreview: row.signing_secret_last4 ? secretPreview(`****${row.signing_secret_last4}`) : null,
      signingSecretSetAt: row.signing_secret_set_at,
      externalFormName: row.external_form_name,
      lastEventAt: row.last_event_at,
      createdAt: row.created_at,
      webhookUrl: token ? this.ingestUrl(token) : null,
    };
  }
}
