/**
 * Connecting a customer's form by installing the webhook ourselves.
 *
 * Two orderings in here are load-bearing and both look arbitrary until they go
 * wrong, so they are argued at their call sites below:
 *
 *   connect:    insert our row FIRST, then install remotely.
 *   disconnect: remove remotely FIRST, then archive our row.
 *
 * Both follow from the same asymmetry. An orphaned row of ours is invisible and
 * harmless — no deliveries reference it and it cascades cleanly. An orphaned
 * webhook on the customer's form is not: it fires at a URL that no longer
 * resolves, Tally retries on its 5m/30m/1h/6h/1d ladder, and eventually emails
 * our customer that our integration is broken.
 *
 * So: never leave a live webhook pointing at a token we have deleted.
 */

import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SecretBox, ingestTokenAad, signingSecretAad } from '../../common/crypto';
import {
  ConnectionMethod,
  IngestStatus,
  MappingOrigin,
  MappingStatus,
  RemoteWebhookState,
} from '../../common/domain';
import { newId } from '../../common/ids';
import { generateIngestToken, generateSigningSecret } from '../../common/tokens';
import { TENANT_PRISMA, type GuardedPrisma } from '../../prisma/prisma.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { ProviderRegistry } from '../providers/provider.registry';
import { ProviderApiError, type FormProviderAdapter, type ProviderCredential } from '../providers/types';
import { LeadSourcesService } from './lead-sources.service';
import { prebuildMappings, schemaFingerprint } from './prebuild-mapping';

export interface ConnectFormInput {
  credentialId: string;
  externalFormId: string;
  name?: string;
  requireSignature?: boolean;
  prebuildMapping?: boolean;
}

@Injectable()
export class ConnectService {
  private readonly logger = new Logger(ConnectService.name);
  private readonly secretBox: SecretBox;

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma,
    private readonly config: ConfigService,
    private readonly registry: ProviderRegistry,
    private readonly integrations: IntegrationsService,
    private readonly leadSources: LeadSourcesService,
  ) {
    this.secretBox = new SecretBox(
      this.config.getOrThrow<string>('ENCRYPTION_KEYS'),
      this.config.getOrThrow<string>('ENCRYPTION_ACTIVE_KEY_ID'),
    );
  }

  /**
   * Refuse to install a webhook at an address the provider cannot reach.
   *
   * PUBLIC_API_BASE_URL defaults to http://localhost:3001. Tally will happily
   * ACCEPT such a URL, so the connect appears to succeed and then no delivery
   * ever arrives — leaving the source on "listening" forever with nothing to
   * debug. The manual flow at least showed the developer the URL they pasted;
   * this one hides it. One check turns the likeliest first-run failure into a
   * sentence they can act on.
   */
  private assertIngestUrlIsReachable(): void {
    if (this.config.get<string>('ALLOW_INSECURE_INGEST_URL') === 'true') return;

    const raw = this.config.get<string>('PUBLIC_API_BASE_URL') ?? '';
    let host = '';
    let protocol = '';
    try {
      ({ hostname: host, protocol } = new URL(raw));
    } catch {
      throw new BadRequestException({
        error: { code: 'PUBLIC_BASE_URL_INVALID', message: `PUBLIC_API_BASE_URL is not a URL: "${raw}".` },
      });
    }

    const isPrivate =
      host === 'localhost' ||
      host === '::1' ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host);

    if (isPrivate || protocol !== 'https:') {
      throw new BadRequestException({
        error: {
          code: 'PUBLIC_BASE_URL_NOT_PUBLIC',
          message:
            `PUBLIC_API_BASE_URL is "${raw}", which the form provider cannot reach. ` +
            'Point it at a public HTTPS origin (an ngrok tunnel locally), or set ' +
            'ALLOW_INSECURE_INGEST_URL=true when testing against a fake provider.',
        },
      });
    }
  }

  async connectForm(organizationId: string, input: ConnectFormInput) {
    this.assertIngestUrlIsReachable();

    const cred = await this.integrations.credentialFor(organizationId, input.credentialId);
    const adapter = this.registry.get(cred.provider);
    const credential: ProviderCredential = { apiKey: cred.apiKey };

    // Always resolve the provider's own name: it is what `external_form_name`
    // records, and it is how we later notice a customer pointing a DIFFERENT
    // form at the same source. The user's chosen label is a separate thing.
    let remoteName: string;
    try {
      remoteName = await this.formName(adapter, credential, input.externalFormId);
    } catch (e) {
      // A dead credential surfaces here first, and must reach the caller as the
      // 400 it is rather than as an unhandled 500.
      if (e instanceof ProviderApiError && e.kind === 'INVALID_CREDENTIAL') {
        await this.integrations.markInvalid(input.credentialId, e.kind);
      }
      throw this.integrations.toHttp(e);
    }
    const name = (input.name ?? '').trim() || remoteName;

    const id = newId();
    const token = generateIngestToken('live');
    const secret = generateSigningSecret();
    const url = this.leadSources.ingestUrl(token.token);

    // --- 1. our row first. See the ordering argument at the top. ------------
    try {
      await this.prisma.lead_sources.create({
        data: {
          id,
          organization_id: organizationId,
          name: name.slice(0, 100),
          code: await this.leadSources.uniqueCode(organizationId, name),
          // Still a webhook source — byte-identical on the ingest path.
          source_type: 'webhook',
          provider: cred.provider,
          connection_method: ConnectionMethod.API,
          provider_credential_id: input.credentialId,
          external_form_id: input.externalFormId,
          external_form_name: remoteName,
          is_active: true,
          ingest_token_hash: token.hash,
          ingest_token_prefix: token.prefix,
          ingest_token_enc: this.secretBox.encrypt(token.token, ingestTokenAad(organizationId, id)),
          signing_secret_enc: this.secretBox.encrypt(secret, signingSecretAad(organizationId, id)),
          signing_secret_last4: secret.slice(-4),
          signing_secret_set_at: new Date(),
          // Unlike the manual path, we install the secret ourselves, so there is
          // no window where the customer has not pasted it yet. Requiring a
          // signature from the first delivery is therefore free here.
          require_signature: input.requireSignature ?? adapter.capabilities.supportsSigningSecret,
          ingest_status: IngestStatus.AWAITING_FIRST_EVENT,
          mapping_status: MappingStatus.UNCONFIGURED,
          remote_state: RemoteWebhookState.PENDING,
          auto_create_leads: true,
          default_consent_status: 'pending',
        },
      });
    } catch (e) {
      // The partial unique index is the real double-click guard; a pre-check
      // SELECT would race against a second request already in flight.
      if ((e as { code?: string }).code === 'P2002') {
        const existing = await this.prisma.lead_sources.findFirst({
          where: {
            organization_id: organizationId,
            provider: cred.provider,
            external_form_id: input.externalFormId,
            archived_at: null,
          },
          select: { id: true, name: true },
        });
        throw new ConflictException({
          error: {
            code: 'FORM_ALREADY_CONNECTED',
            message: `That form already feeds "${existing?.name ?? 'an existing lead source'}". Connecting it twice would deliver every submission to us twice.`,
            leadSourceId: existing?.id ?? null,
          },
        });
      }
      throw e;
    }

    // --- 2. install remotely -------------------------------------------------
    let webhookId: string;
    try {
      const hook = await adapter.installWebhook(credential, {
        externalFormId: input.externalFormId,
        url,
        signingSecret: adapter.capabilities.supportsSigningSecret ? secret : null,
        externalRef: id,
      });
      webhookId = hook.externalWebhookId;
    } catch (e) {
      webhookId = await this.recoverFromInstallFailure(organizationId, id, input, adapter, credential, url, e);
    }

    await this.prisma.lead_sources.update({
      where: { id },
      data: {
        external_webhook_id: webhookId,
        remote_state: RemoteWebhookState.INSTALLED,
        remote_synced_at: new Date(),
        remote_error_code: null,
        remote_error_message: null,
      },
    });

    // --- 3. map it from the schema, non-fatally ------------------------------
    const prebuild =
      input.prebuildMapping === false
        ? null
        : await this.prebuild(organizationId, id, adapter, credential, input.externalFormId);

    await this.prisma.audit_logs.create({
      data: {
        id: newId(),
        organization_id: organizationId,
        actor_type: 'user',
        action: 'lead_source.connected',
        entity_type: 'lead_source',
        entity_id: id,
        payload: { provider: cred.provider, externalFormId: input.externalFormId, webhookId } as never,
      },
    });

    const row = await this.prisma.lead_sources.findUniqueOrThrow({ where: { id } });

    return {
      // No signingSecret: we installed it, so the customer never needs it. That
      // is the whole ergonomic win of this path over the manual one.
      ...this.leadSources.summarize(row, token.token),
      connection: {
        method: ConnectionMethod.API,
        provider: cred.provider,
        remoteState: RemoteWebhookState.INSTALLED,
        externalFormId: input.externalFormId,
        externalWebhookId: webhookId,
        credentialId: input.credentialId,
      },
      prebuild: prebuild && {
        fields: prebuild.fields,
        mapped: prebuild.mappings.length,
        unmapped: prebuild.unmapped,
        needsReview: prebuild.withheld,
        mappingStatus: prebuild.mappings.length ? MappingStatus.NEEDS_REVIEW : MappingStatus.UNCONFIGURED,
      },
    };
  }

  /**
   * An install that threw may or may not have created a webhook. Which one it is
   * decides whether we roll back or adopt, and guessing wrong is expensive in
   * one direction only.
   */
  private async recoverFromInstallFailure(
    organizationId: string,
    leadSourceId: string,
    input: ConnectFormInput,
    adapter: FormProviderAdapter,
    credential: ProviderCredential,
    url: string,
    err: unknown,
  ): Promise<string> {
    if (!(err instanceof ProviderApiError)) {
      await this.deleteProvisional(leadSourceId);
      throw err;
    }

    if (!err.mayHaveExecuted) {
      // 401/403/404/400/429 — the provider definitively created nothing, so our
      // row is pure litter. It has no deliveries yet, so deleting is safe.
      await this.deleteProvisional(leadSourceId);
      if (err.kind === 'INVALID_CREDENTIAL') {
        await this.integrations.markInvalid(input.credentialId, err.kind);
      }
      throw this.integrations.toHttp(err);
    }

    // 5xx or a timeout: it might have landed. Ask before destroying anything.
    if (!adapter.capabilities.supportsWebhookList) {
      await this.markRemoteError(leadSourceId, err);
      throw this.unresolvable(leadSourceId);
    }

    try {
      const remote = await adapter.listWebhooks(credential, input.externalFormId);
      const ours =
        remote.find((w) => w.externalRef === leadSourceId) ?? remote.find((w) => w.url === url);

      if (ours) {
        this.logger.warn(`Install reported failure but the webhook exists; adopting ${ours.externalWebhookId}`);
        return ours.externalWebhookId;
      }

      await this.deleteProvisional(leadSourceId);
      throw this.integrations.toHttp(err);
    } catch (probeErr) {
      if (probeErr instanceof ConflictException || probeErr instanceof BadRequestException) throw probeErr;

      // We cannot establish the truth. NEVER delete here: a webhook may exist,
      // and removing the row would leave it firing at a dead token.
      await this.markRemoteError(leadSourceId, err);
      throw this.unresolvable(leadSourceId);
    }
  }

  private unresolvable(leadSourceId: string) {
    return new ConflictException({
      error: {
        code: 'PROVIDER_UNAVAILABLE',
        message:
          'We could not confirm whether the webhook was created. The lead source was kept rather than deleted, ' +
          'because deleting it could leave a live webhook pointing nowhere. Retry with POST /v1/lead-sources/{id}/resync.',
        leadSourceId,
      },
    });
  }

  /**
   * Mapping failures are NOT fatal.
   *
   * A connected form with no mapping is strictly better than a failed connect:
   * the webhook is installed, submissions are being stored, and the existing
   * first-delivery path will map it exactly as it does today.
   */
  private async prebuild(
    organizationId: string,
    leadSourceId: string,
    adapter: FormProviderAdapter,
    credential: ProviderCredential,
    externalFormId: string,
  ) {
    try {
      const fields = await adapter.describeForm(credential, externalFormId);
      if (fields.length === 0) return null;

      const org = await this.prisma.organizations.findUnique({ where: { id: organizationId } });
      const result = prebuildMappings(fields, org?.default_region ?? 'US');

      // One transaction, because these three writes are one fact.
      //
      // Found the hard way: when the status update failed, the mappings had
      // already been inserted and stayed ACTIVE while mapping_status still read
      // UNCONFIGURED — a source silently mapping leads while claiming not to be
      // mapped. Either all of this lands or none of it does.
      await this.prisma.$transaction(async (tx) => {
        // Catalogue every question, including unmapped ones. Status NEW is the
        // vocabulary's existing word for "declared, not yet observed".
        await tx.lead_source_fields.createMany({
          data: fields.map((f) => ({
            id: newId(),
            organization_id: organizationId,
            lead_source_id: leadSourceId,
            field_key: f.key,
            label: f.label,
            field_type: f.type,
            options: (f.options ?? null) as never,
            sample_values: [] as never,
            status: 'NEW',
          })),
          skipDuplicates: true,
        });

        if (result.mappings.length > 0) {
          await tx.lead_source_field_mappings.createMany({
            data: result.mappings.map((m) => ({
              id: newId(),
              organization_id: organizationId,
              lead_source_id: leadSourceId,
              source_field_key: m.sourceFieldKey,
              target_field: m.targetField,
              transform: m.transform as never,
              is_active: true,
              confidence: m.confidence,
              origin: MappingOrigin.PREBUILT,
            })),
            skipDuplicates: true,
          });
        }

        await tx.lead_sources.update({
          where: { id: leadSourceId },
          data: {
            // NEEDS_REVIEW, never CONFIGURED: nothing here was confirmed by a
            // human, and these mappings are live the moment a lead arrives.
            mapping_status: result.mappings.length ? MappingStatus.NEEDS_REVIEW : MappingStatus.UNCONFIGURED,
            mapping_version: { increment: 1 },
            prebuilt_at: new Date(),
            schema_fingerprint: schemaFingerprint(fields),
          },
        });
      });

      this.logger.log(
        `Pre-mapped ${result.mappings.length}/${result.fields} field(s) for source ${leadSourceId}`,
      );
      return result;
    } catch (e) {
      this.logger.warn(
        `Pre-mapping failed for ${leadSourceId}; the first delivery will map it instead: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return null;
    }
  }

  private async formName(
    adapter: FormProviderAdapter,
    credential: ProviderCredential,
    externalFormId: string,
  ): Promise<string> {
    try {
      let cursor: string | null = null;
      do {
        const page = await adapter.listForms(credential, cursor);
        const hit = page.items.find((f) => f.externalFormId === externalFormId);
        if (hit) return hit.name;
        cursor = page.nextCursor;
      } while (cursor);
    } catch (e) {
      // A dead credential must NOT be swallowed here. This is the first call we
      // make, so failing now means failing before we have created anything —
      // strictly better than discovering it one step later and rolling back.
      // Anything else (a transient 5xx, a rate limit) is not worth failing a
      // connect over: naming is a convenience.
      if (e instanceof ProviderApiError && (e.kind === 'INVALID_CREDENTIAL' || e.kind === 'FORBIDDEN')) {
        throw e;
      }
    }
    return 'Connected form';
  }

  private async deleteProvisional(id: string): Promise<void> {
    // Safe only because this row is seconds old and has no deliveries. Anything
    // with a lead_submission is protected by ON DELETE RESTRICT anyway.
    await this.prisma.lead_sources.delete({ where: { id } }).catch(() => undefined);
  }

  private async markRemoteError(id: string, err: ProviderApiError): Promise<void> {
    await this.prisma.lead_sources.update({
      where: { id },
      data: {
        remote_state: RemoteWebhookState.ERROR,
        remote_error_code: err.kind,
        remote_error_message: err.message,
        remote_synced_at: new Date(),
      },
    });
  }

  /**
   * Reconcile what we believe against what the provider actually has.
   *
   * Also the repair path: if the webhook is gone, we can re-install it with the
   * SAME token and secret, because `signing_secret_enc` is ciphertext rather
   * than a hash. Nothing needs rotating.
   */
  async resync(organizationId: string, leadSourceId: string) {
    const row = await this.prisma.lead_sources.findFirst({
      where: { id: leadSourceId, organization_id: organizationId },
    });
    if (!row) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'No such lead source.' } });

    if (row.connection_method !== ConnectionMethod.API || !row.provider_credential_id || !row.external_form_id) {
      throw new ConflictException({
        error: {
          code: 'NOT_API_CONNECTED',
          message: 'This source was set up by pasting the webhook URL manually, so there is nothing for us to sync.',
        },
      });
    }

    const cred = await this.integrations.credentialFor(organizationId, row.provider_credential_id);
    const adapter = this.registry.get(cred.provider);
    const credential: ProviderCredential = { apiKey: cred.apiKey };

    const token = this.secretBox.decrypt(row.ingest_token_enc!, ingestTokenAad(organizationId, row.id));
    const url = this.leadSources.ingestUrl(token);

    let remote;
    try {
      remote = await adapter.listWebhooks(credential, row.external_form_id);
    } catch (e) {
      if (e instanceof ProviderApiError && e.kind === 'INVALID_CREDENTIAL') {
        await this.integrations.markInvalid(row.provider_credential_id, e.kind);
      }
      throw this.integrations.toHttp(e);
    }

    const mine = remote.filter((w) => w.externalRef === row.id || w.url === url);

    // Duplicates are not cosmetic: two webhooks mean two deliveries with
    // distinct event ids, which survive the dedupe key and inflate
    // submission_count on the lead.
    let removedDuplicates = 0;
    for (const extra of mine.slice(1)) {
      await adapter.uninstallWebhook(credential, {
        externalFormId: row.external_form_id,
        externalWebhookId: extra.externalWebhookId,
      });
      removedDuplicates++;
    }

    if (mine.length === 0) {
      await this.prisma.lead_sources.update({
        where: { id: row.id },
        data: { remote_state: RemoteWebhookState.UNINSTALLED, remote_synced_at: new Date() },
      });
      return { remoteState: RemoteWebhookState.UNINSTALLED, repaired: false, removedDuplicates };
    }

    await this.prisma.lead_sources.update({
      where: { id: row.id },
      data: {
        external_webhook_id: mine[0].externalWebhookId,
        remote_state: RemoteWebhookState.INSTALLED,
        remote_synced_at: new Date(),
        remote_error_code: null,
        remote_error_message: null,
      },
    });

    return {
      remoteState: RemoteWebhookState.INSTALLED,
      repaired: row.external_webhook_id !== mine[0].externalWebhookId,
      removedDuplicates,
    };
  }

  /** Re-install a webhook the customer deleted on the provider's side. */
  async reinstall(organizationId: string, leadSourceId: string) {
    const row = await this.prisma.lead_sources.findFirst({
      where: { id: leadSourceId, organization_id: organizationId },
    });
    if (!row?.provider_credential_id || !row.external_form_id) {
      throw new ConflictException({
        error: { code: 'NOT_API_CONNECTED', message: 'Nothing to reinstall for this source.' },
      });
    }

    this.assertIngestUrlIsReachable();

    const cred = await this.integrations.credentialFor(organizationId, row.provider_credential_id);
    const adapter = this.registry.get(cred.provider);

    // Both are recoverable from ciphertext, so a repair needs no rotation and
    // the customer's existing configuration keeps working.
    const token = this.secretBox.decrypt(row.ingest_token_enc!, ingestTokenAad(organizationId, row.id));
    const secret = row.signing_secret_enc
      ? this.secretBox.decrypt(row.signing_secret_enc, signingSecretAad(organizationId, row.id))
      : null;

    try {
      const hook = await adapter.installWebhook(
        { apiKey: cred.apiKey },
        {
          externalFormId: row.external_form_id,
          url: this.leadSources.ingestUrl(token),
          signingSecret: adapter.capabilities.supportsSigningSecret ? secret : null,
          externalRef: row.id,
        },
      );

      await this.prisma.lead_sources.update({
        where: { id: row.id },
        data: {
          external_webhook_id: hook.externalWebhookId,
          remote_state: RemoteWebhookState.INSTALLED,
          remote_synced_at: new Date(),
          remote_error_code: null,
          remote_error_message: null,
        },
      });
      return { remoteState: RemoteWebhookState.INSTALLED, externalWebhookId: hook.externalWebhookId };
    } catch (e) {
      throw this.integrations.toHttp(e);
    }
  }

  /**
   * Disconnect.
   *
   * Remote FIRST — see the ordering argument at the top of the file. Archived
   * rather than deleted: lead_submissions.lead_source_id is ON DELETE RESTRICT,
   * so any source with a processed submission cannot be hard-deleted anyway,
   * and an archived token answers 410 Gone instead of 404, which at least logs
   * late deliveries against the right organization.
   */
  async disconnect(organizationId: string, leadSourceId: string, removeRemote = true, force = false) {
    const row = await this.prisma.lead_sources.findFirst({
      where: { id: leadSourceId, organization_id: organizationId },
    });
    if (!row) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'No such lead source.' } });

    let remoteState: string = RemoteWebhookState.UNINSTALLED;
    let warning: string | null = null;

    const manageable =
      removeRemote &&
      row.connection_method === ConnectionMethod.API &&
      row.provider_credential_id &&
      row.external_webhook_id &&
      row.external_form_id;

    if (manageable) {
      try {
        const cred = await this.integrations.credentialFor(organizationId, row.provider_credential_id!);
        const adapter = this.registry.get(cred.provider);
        await adapter.uninstallWebhook(
          { apiKey: cred.apiKey },
          { externalFormId: row.external_form_id!, externalWebhookId: row.external_webhook_id! },
        );
      } catch (e) {
        if (!force) {
          throw new ConflictException({
            error: {
              code: 'CANNOT_REMOVE_REMOTE',
              message:
                `We could not remove the webhook from the provider (${
                  e instanceof ProviderApiError ? e.kind : 'unknown error'
                }). Retry, or pass force=true to disconnect anyway and remove it there yourself.`,
              externalWebhookId: row.external_webhook_id,
            },
          });
        }
        remoteState = RemoteWebhookState.ORPHANED;
        warning =
          `The webhook ${row.external_webhook_id} may still exist on your form and will keep firing at a URL ` +
          'that now returns 410. Remove it in the provider to stop that.';
      }
    }

    await this.prisma.lead_sources.update({
      where: { id: row.id },
      data: {
        archived_at: new Date(),
        is_active: false,
        remote_state: remoteState,
        external_webhook_id: remoteState === RemoteWebhookState.ORPHANED ? row.external_webhook_id : null,
      },
    });

    await this.prisma.audit_logs.create({
      data: {
        id: newId(),
        organization_id: organizationId,
        actor_type: 'user',
        action: 'lead_source.disconnected',
        entity_type: 'lead_source',
        entity_id: row.id,
        payload: { remoteState, removeRemote } as never,
      },
    });

    return { disconnected: true, remoteState, warning };
  }
}
