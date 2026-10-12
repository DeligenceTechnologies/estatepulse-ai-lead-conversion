import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { SecretBox, ingestTokenAad, signingSecretAad } from '../../common/crypto';
import { IngestStatus, MappingStatus } from '../../common/domain';
import { newId } from '../../common/ids';
import { generateIngestToken, generateSigningSecret, secretPreview } from '../../common/tokens';
import { TENANT_PRISMA, type GuardedPrisma } from '../../prisma/prisma.service';
import { TallyAdapter } from '../ingest/adapters/tally.adapter';

export interface CreateLeadSourceInput {
  name: string;
  requireSignature?: boolean;
}

/** One entry of `webhook_events.mapping_trace`, written by the processing worker. */
interface TraceEntry {
  sourceFieldKey: string;
  targetField: string | null;
  outcome: 'mapped' | 'unmapped' | 'transform_error';
  warning?: string | null;
}

interface DeliveryAnswerDto {
  label: string;
  type: string;
  value: string;
  /** Usually one; two when a single question feeds a pair (name, budget range). */
  targetFields: string[];
  mappingOutcome: string | null;
  warnings: string[];
}

@Injectable()
export class LeadSourcesService {
  private readonly adapter = new TallyAdapter();
  private readonly secretBox: SecretBox;

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma,
    private readonly config: ConfigService,
  ) {
    this.secretBox = new SecretBox(
      this.config.getOrThrow<string>('ENCRYPTION_KEYS'),
      this.config.getOrThrow<string>('ENCRYPTION_ACTIVE_KEY_ID'),
    );
  }

  /** Public so the connect flow builds the same URL rather than its own. */
  ingestUrl(token: string): string {
    return `${this.config.get<string>('PUBLIC_API_BASE_URL')}/ingest/v1/tally/${token}`;
  }

  /**
   * A slug unique within the organization, since (organization_id, code) is.
   *
   * Shared with the connect flow: two creation paths minting codes by different
   * rules is how you end up with "buyer_inquiry" and "buyer-inquiry-2".
   */
  async uniqueCode(organizationId: string, name: string): Promise<string> {
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 36) || 'webhook';

    let code = base;
    for (
      let n = 2;
      await this.prisma.lead_sources.findFirst({
        where: { organization_id: organizationId, code },
        select: { id: true },
      });
      n++
    ) {
      code = `${base.slice(0, 33)}_${n}`;
    }
    return code;
  }

  /** Public for the connect flow, which returns the same DTO shape. */
  summarize(row: Parameters<LeadSourcesService['toSummary']>[0], token: string | null) {
    return this.toSummary(row, token);
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

    const code = await this.uniqueCode(organizationId, input.name);

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

  /**
   * The organization's webhook sources, newest first, each with how many
   * deliveries it has received and how many leads it produced.
   *
   * ONE statement: the sources were read first and the two counts after — a
   * second round trip, polled on every refresh of the screen. Only the columns
   * toSummary and decryptToken read are selected; the signing secrets are not.
   * The counts are per source within this organization, as the grouped counts
   * were.
   */
  async list(organizationId: string, includeArchived = false) {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        organization_id: string;
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
        provider: string;
        connection_method: string;
        external_form_id: string | null;
        remote_state: string | null;
        remote_synced_at: Date | null;
        remote_error_message: string | null;
        ingest_token_enc: string | null;
        delivery_count: number;
        lead_count: number;
      }>
    >`
      select ls.id, ls.organization_id, ls.name, ls.code, ls.is_active, ls.require_signature,
             ls.ingest_status, ls.mapping_status, ls.signing_secret_last4, ls.signing_secret_set_at,
             ls.external_form_name, ls.last_event_at, ls.created_at, ls.provider, ls.connection_method,
             ls.external_form_id, ls.remote_state, ls.remote_synced_at, ls.remote_error_message,
             ls.ingest_token_enc,
             (select count(*) from webhook_events w
               where w.organization_id = ls.organization_id and w.lead_source_id = ls.id)::int as delivery_count,
             -- Deliveries and leads are no longer the same number — a delivery
             -- with no usable phone or email is stored without producing a lead
             -- — so the list reports both rather than letting one stand in for
             -- the other.
             (select count(*) from leads l
               where l.organization_id = ls.organization_id and l.lead_source_id = ls.id)::int as lead_count
        from lead_sources ls
       where ls.organization_id = ${organizationId}::uuid
         and ls.source_type = 'webhook'
         -- Disconnected sources are archived, not deleted (lead_submissions has
         -- ON DELETE RESTRICT). Without this they would keep appearing as live.
         ${includeArchived ? Prisma.empty : Prisma.sql`and ls.archived_at is null`}
       order by ls.created_at desc
    `;

    return rows.map((r) => ({
      ...this.toSummary(r, this.decryptToken(r)),
      deliveryCount: r.delivery_count,
      leadCount: r.lead_count,
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
      // Only what the answer below reads. The row also carries raw_body — the
      // exact request bytes, about the size of the payload again — plus headers
      // and warnings, none of which are shown; on up to 100 rows that is
      // roughly doubling what crosses the wire for nothing.
      select: {
        id: true,
        received_at: true,
        external_event_id: true,
        signature_state: true,
        used_previous_secret: true,
        queue_state: true,
        outcome: true,
        outcome_reason: true,
        error_message: true,
        content_length: true,
        payload: true,
        mapping_trace: true,
      },
    });

    return rows.map((r) => {
      let answers: DeliveryAnswerDto[] = [];
      let parseError: string | null = null;

      // What the mapping engine decided about each field, recorded when the
      // delivery was processed. Joining it onto the answers is what turns
      // "a webhook arrived" into "and here is which answers became lead fields,
      // which were kept as extras, and which we could not read".
      // Keyed by source field, holding EVERY entry for it: one question
      // legitimately feeds two targets ("Your name" -> first_name + last_name,
      // one budget question -> min_budget + max_budget). Keeping only the first
      // would show 5 arrows next to a summary that counted 6.
      const trace = new Map<string, TraceEntry[]>();
      if (Array.isArray(r.mapping_trace)) {
        for (const t of r.mapping_trace as unknown as TraceEntry[]) {
          if (!t?.sourceFieldKey) continue;
          const list = trace.get(t.sourceFieldKey) ?? [];
          list.push(t);
          trace.set(t.sourceFieldKey, list);
        }
      }

      if (r.payload) {
        try {
          const parsed = this.adapter.parse(r.payload);
          answers = parsed.answers.map((a) => {
            const entries = trace.get(a.key) ?? [];
            return {
              label: a.label,
              type: a.type,
              // Already option-UUID-resolved by the adapter, so a dropdown reads
              // "ASAP / under 30 days" and not "opt_a".
              value: a.scalarText,
              // Empty when the delivery predates mapping or was never processed.
              targetFields: entries.map((t) => t.targetField).filter((t): t is string => Boolean(t)),
              mappingOutcome: entries[0]?.outcome ?? null,
              warnings: entries.map((t) => t.warning).filter((w): w is string => Boolean(w)),
            };
          });
        } catch (e) {
          parseError = e instanceof Error ? e.message : String(e);
        }
      }

      const traceEntries = Array.isArray(r.mapping_trace)
        ? (r.mapping_trace as unknown as TraceEntry[])
        : [];

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
        /**
         * The one-line answer to "did normalization work on this submission?".
         * Null when the delivery has not been processed yet, which is different
         * from "processed and mapped nothing".
         */
        mapping: traceEntries.length
          ? {
              mapped: traceEntries.filter((t) => t.outcome === 'mapped').length,
              unmapped: traceEntries.filter((t) => t.outcome === 'unmapped').length,
              errored: traceEntries.filter((t) => t.outcome === 'transform_error').length,
              warnings: traceEntries.filter((t) => t.warning).length,
            }
          : null,
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
      provider?: string | null;
      connection_method?: string | null;
      external_form_id?: string | null;
      remote_state?: string | null;
      remote_synced_at?: Date | null;
      remote_error_message?: string | null;
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
      // Only meaningful for an API-connected source; null on a manual one, which
      // is exactly what the UI needs to tell them apart.
      provider: row.provider ?? null,
      connectionMethod: row.connection_method ?? null,
      externalFormId: row.external_form_id ?? null,
      remoteState: row.remote_state ?? null,
      remoteSyncedAt: row.remote_synced_at ?? null,
      remoteErrorMessage: row.remote_error_message ?? null,
    };
  }
}
