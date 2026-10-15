import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectionMethod,
  LeadSourceProvider,
  MappingOrigin,
  MappingStatus,
  Prisma,
  RemoteWebhookState,
  type LeadSource,
} from '@prisma/client';
import { AuditService } from '@/audit/audit.service';
import { PrismaService } from '@/common/prisma/prisma.service';
import { SecretBoxService } from '@/common/service/secret-box.service';
import { aad } from '@/common/utils/crypto';
import type { IntegrationEnv } from '@/common/utils/interface';
import { IntegrationsService } from '@/integration/integrations.service';
import { ProviderRegistry } from '@/integration/providers/provider.registry';
import { ProviderApiError, type FormProviderAdapter, type ProviderCredential } from '@/integration/providers/types';
import { LeadSourcesService } from './lead-sources.service';
import { prebuildMappings, schemaFingerprint } from './prebuild-mapping';

export interface ConnectFormInput {
  credentialId: string;
  externalFormId: string;
  name?: string;
  requireSignature?: boolean;
  prebuildMapping?: boolean;
}

/**
 * Lead sources we connected through the provider's API: we install the
 * webhook on the customer's form, keep it pointed at our current public URL,
 * and remove it again on disconnect.
 */
@Injectable()
export class ConnectService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ConnectService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretBoxService,
    private readonly config: ConfigService<IntegrationEnv, true>,
    private readonly registry: ProviderRegistry,
    private readonly integrations: IntegrationsService,
    private readonly leadSources: LeadSourcesService,
    private readonly audit: AuditService,
  ) {}

  /** A provider cannot deliver to localhost or plain http; refuse up front instead of installing a dead webhook. */
  private assertIngestUrlIsReachable(): void {
    if (this.config.get('ALLOW_INSECURE_INGEST_URL', { infer: true })) return;
    const raw = this.config.get('PUBLIC_API_URL', { infer: true }) ?? '';
    let host = '';
    let protocol = '';
    try {
      ({ hostname: host, protocol } = new URL(raw));
    } catch {
      throw new BadRequestException({
        error: { code: 'PUBLIC_BASE_URL_INVALID', message: `PUBLIC_API_URL is not set to a URL ("${raw}").` },
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
            `PUBLIC_API_URL is "${raw}", which the form provider cannot reach. Point it at a public HTTPS ` +
            'origin (a tunnel locally), or set ALLOW_INSECURE_INGEST_URL=true when testing against a fake provider.',
        },
      });
    }
  }

  private ingestUrlIsReachable(): boolean {
    try {
      this.assertIngestUrlIsReachable();
      return true;
    } catch {
      return false;
    }
  }

  /** After a deploy that changed the public URL, re-point every installed webhook at it. */
  onApplicationBootstrap(): void {
    if (this.config.get('NODE_ENV', { infer: true }) === 'test' || !this.ingestUrlIsReachable()) return;
    void this.syncAllWebhookUrls();
  }

  private async syncAllWebhookUrls(): Promise<void> {
    const rows = await this.prisma.leadSource
      .findMany({
        where: { connectionMethod: ConnectionMethod.API, isActive: true, integrationId: { not: null }, externalFormId: { not: null } },
        select: { id: true, orgId: true },
      })
      .catch((error) => {
        this.logger.warn(`webhook URL sync skipped: ${(error as Error).message}`);
        return [];
      });
    for (const row of rows) {
      try {
        const result = await this.resync(row.orgId, row.id);
        if (result.urlUpdated) this.logger.log(`lead source ${row.id}: webhook re-pointed at the current public URL`);
      } catch (error) {
        this.logger.warn(`lead source ${row.id}: webhook URL sync failed: ${(error as Error).message}`);
      }
    }
  }

  async connectForm(orgId: string, input: ConnectFormInput, actorId: string) {
    this.assertIngestUrlIsReachable();
    const cred = await this.integrations.credentialFor(orgId, input.credentialId);
    const adapter = this.registry.get(cred.provider);
    const credential: ProviderCredential = { apiKey: cred.apiKey };

    let remoteName: string;
    try {
      remoteName = await this.formName(adapter, credential, input.externalFormId);
    } catch (error) {
      if (error instanceof ProviderApiError && error.kind === 'INVALID_CREDENTIAL') {
        await this.integrations.markInvalid(input.credentialId, error.kind);
      }
      throw this.integrations.toHttp(error);
    }

    const name = input.name?.trim() || remoteName;
    const fresh = this.leadSources.newSourceSecrets(orgId);
    const url = this.leadSources.ingestUrl(fresh.token, LeadSourceProvider.TALLY);
    try {
      await this.prisma.leadSource.create({
        data: {
          ...fresh.data,
          orgId,
          name: name.slice(0, 100),
          code: await this.leadSources.uniqueCode(orgId, name),
          provider: LeadSourceProvider.TALLY,
          connectionMethod: ConnectionMethod.API,
          integrationId: input.credentialId,
          externalFormId: input.externalFormId,
          externalFormName: remoteName,
          requireSignature: input.requireSignature ?? adapter.capabilities.supportsSigningSecret,
          remoteState: RemoteWebhookState.PENDING,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.prisma.leadSource.findFirst({
          where: { orgId, provider: LeadSourceProvider.TALLY, externalFormId: input.externalFormId, archivedAt: null },
          select: { id: true, name: true },
        });
        throw new ConflictException({
          error: {
            code: 'FORM_ALREADY_CONNECTED',
            message: `That form already feeds "${existing?.name ?? 'an existing lead source'}". Connecting it twice would deliver every submission twice.`,
            leadSourceId: existing?.id ?? null,
          },
        });
      }
      throw error;
    }

    let webhookId: string;
    try {
      const hook = await adapter.installWebhook(credential, {
        externalFormId: input.externalFormId,
        url,
        signingSecret: adapter.capabilities.supportsSigningSecret ? fresh.secret : null,
        externalRef: fresh.id,
      });
      webhookId = hook.externalWebhookId;
    } catch (error) {
      webhookId = await this.recoverFromInstallFailure(orgId, fresh.id, input, adapter, credential, url, error);
    }

    await this.prisma.leadSource.update({
      where: { id: fresh.id },
      data: {
        externalWebhookId: webhookId,
        remoteState: RemoteWebhookState.INSTALLED,
        remoteSyncedAt: new Date(),
        remoteErrorCode: null,
        remoteErrorMessage: null,
      },
    });

    const prebuild = input.prebuildMapping === false ? null : await this.prebuild(orgId, fresh.id, adapter, credential, input.externalFormId);
    await this.audit.record({
      orgId,
      actorType: 'user',
      actorId,
      action: 'lead_source.connected',
      entityType: 'lead_source',
      entityId: fresh.id,
      payload: { provider: cred.provider, externalFormId: input.externalFormId, webhookId },
    });

    const row = await this.prisma.leadSource.findUniqueOrThrow({ where: { id: fresh.id } });
    return {
      ...this.leadSources.toSummary(row, fresh.token),
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
   * An install that failed in a way that may still have reached the provider
   * is checked against the provider's own webhook list before the source is
   * deleted, so we never leave a live webhook pointing at nothing.
   */
  private async recoverFromInstallFailure(
    orgId: string,
    leadSourceId: string,
    input: ConnectFormInput,
    adapter: FormProviderAdapter,
    credential: ProviderCredential,
    url: string,
    error: unknown,
  ): Promise<string> {
    if (!(error instanceof ProviderApiError)) {
      await this.deleteProvisional(leadSourceId);
      throw error;
    }
    if (!error.mayHaveExecuted) {
      await this.deleteProvisional(leadSourceId);
      if (error.kind === 'INVALID_CREDENTIAL') await this.integrations.markInvalid(input.credentialId, error.kind);
      throw this.integrations.toHttp(error);
    }
    if (!adapter.capabilities.supportsWebhookList) {
      await this.markRemoteError(leadSourceId, error);
      throw this.unresolvable(leadSourceId);
    }
    try {
      const remote = await adapter.listWebhooks(credential, input.externalFormId);
      const ours = remote.find((w) => w.externalRef === leadSourceId) ?? remote.find((w) => w.url === url);
      if (ours) {
        this.logger.warn(`Install reported failure but the webhook exists; adopting ${ours.externalWebhookId}`);
        return ours.externalWebhookId;
      }
      await this.deleteProvisional(leadSourceId);
      throw this.integrations.toHttp(error);
    } catch (probeError) {
      if (probeError instanceof ConflictException || probeError instanceof BadRequestException) throw probeError;
      await this.markRemoteError(leadSourceId, error);
      throw this.unresolvable(leadSourceId);
    }
  }

  private unresolvable(leadSourceId: string) {
    return new ConflictException({
      error: {
        code: 'PROVIDER_UNAVAILABLE',
        message:
          'We could not confirm whether the webhook was created. The lead source was kept rather than deleted, ' +
          'because deleting it could leave a live webhook pointing nowhere. Retry with Resync.',
        leadSourceId,
      },
    });
  }

  private async prebuild(
    orgId: string,
    leadSourceId: string,
    adapter: FormProviderAdapter,
    credential: ProviderCredential,
    externalFormId: string,
  ) {
    try {
      const fields = await adapter.describeForm(credential, externalFormId);
      if (fields.length === 0) return null;
      const settings = await this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { defaultRegion: true } });
      const result = prebuildMappings(fields, settings?.defaultRegion ?? 'US');
      await this.prisma.$transaction(async (tx) => {
        await tx.leadSourceField.createMany({
          data: fields.map((f) => ({
            orgId,
            leadSourceId,
            fieldKey: f.key,
            label: f.label,
            fieldType: f.type,
            ...(f.options ? { options: f.options as unknown as Prisma.InputJsonValue } : {}),
            status: 'NEW' as const,
          })),
          skipDuplicates: true,
        });
        if (result.mappings.length > 0) {
          await tx.leadSourceFieldMapping.createMany({
            data: result.mappings.map((m) => ({
              orgId,
              leadSourceId,
              sourceFieldKey: m.sourceFieldKey,
              targetField: m.targetField,
              transform: m.transform as Prisma.InputJsonValue,
              isActive: true,
              confidence: m.confidence,
              origin: MappingOrigin.PREBUILT,
            })),
            skipDuplicates: true,
          });
        }
        await tx.leadSource.update({
          where: { id: leadSourceId },
          data: {
            mappingStatus: result.mappings.length ? MappingStatus.NEEDS_REVIEW : MappingStatus.UNCONFIGURED,
            mappingVersion: { increment: 1 },
            prebuiltAt: new Date(),
            schemaFingerprint: schemaFingerprint(fields),
          },
        });
      });
      return result;
    } catch (error) {
      this.logger.warn(`Pre-mapping failed for ${leadSourceId}; the first delivery will map it: ${(error as Error).message}`);
      return null;
    }
  }

  private async formName(adapter: FormProviderAdapter, credential: ProviderCredential, externalFormId: string): Promise<string> {
    try {
      let cursor: string | null = null;
      do {
        const page = await adapter.listForms(credential, cursor);
        const hit = page.items.find((f) => f.externalFormId === externalFormId);
        if (hit) return hit.name;
        cursor = page.nextCursor;
      } while (cursor);
    } catch (error) {
      if (error instanceof ProviderApiError && (error.kind === 'INVALID_CREDENTIAL' || error.kind === 'FORBIDDEN')) throw error;
    }
    return 'Connected form';
  }

  private async deleteProvisional(id: string): Promise<void> {
    await this.prisma.leadSource.delete({ where: { id } }).catch(() => undefined);
  }

  private async markRemoteError(id: string, error: ProviderApiError): Promise<void> {
    await this.prisma.leadSource.update({
      where: { id },
      data: {
        remoteState: RemoteWebhookState.ERROR,
        remoteErrorCode: error.kind,
        remoteErrorMessage: error.message,
        remoteSyncedAt: new Date(),
      },
    });
  }

  private async apiSource(orgId: string, leadSourceId: string): Promise<LeadSource & { integrationId: string; externalFormId: string }> {
    const row = await this.prisma.leadSource.findFirst({ where: { id: leadSourceId, orgId } });
    if (!row) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'No such lead source.' } });
    if (row.connectionMethod !== ConnectionMethod.API || !row.integrationId || !row.externalFormId) {
      throw new ConflictException({
        error: {
          code: 'NOT_API_CONNECTED',
          message: 'This source was set up by pasting the webhook URL manually, so there is nothing for us to sync.',
        },
      });
    }
    return row as LeadSource & { integrationId: string; externalFormId: string };
  }

  /** Reconciles our record with the provider: removes duplicate hooks, re-points a moved URL, notices a deleted one. */
  async resync(orgId: string, leadSourceId: string) {
    const row = await this.apiSource(orgId, leadSourceId);
    const cred = await this.integrations.credentialFor(orgId, row.integrationId);
    const adapter = this.registry.get(cred.provider);
    const credential: ProviderCredential = { apiKey: cred.apiKey };
    const token = this.leadSources.decryptToken(row);
    if (!token) throw new ConflictException({ error: { code: 'TOKEN_UNREADABLE', message: 'The ingest token cannot be read.' } });
    const url = this.leadSources.ingestUrl(token, row.provider);

    let remote;
    try {
      remote = await adapter.listWebhooks(credential, row.externalFormId);
    } catch (error) {
      if (error instanceof ProviderApiError && error.kind === 'INVALID_CREDENTIAL') {
        await this.integrations.markInvalid(row.integrationId, error.kind);
      }
      throw this.integrations.toHttp(error);
    }

    const mine = remote.filter((w) => w.externalRef === row.id || w.url === url);
    let removedDuplicates = 0;
    for (const extra of mine.slice(1)) {
      await adapter.uninstallWebhook(credential, { externalFormId: row.externalFormId, externalWebhookId: extra.externalWebhookId });
      removedDuplicates++;
    }
    if (mine.length === 0) {
      await this.prisma.leadSource.update({
        where: { id: row.id },
        data: { remoteState: RemoteWebhookState.UNINSTALLED, remoteSyncedAt: new Date() },
      });
      return { remoteState: RemoteWebhookState.UNINSTALLED, repaired: false, removedDuplicates, urlUpdated: false };
    }

    const hook = mine[0];
    let urlUpdated = false;
    if ((hook.url !== url || !hook.isEnabled) && adapter.capabilities.supportsWebhookUpdate && this.ingestUrlIsReachable()) {
      const secret = row.signingSecretEnc ? this.secrets.open(row.signingSecretEnc, aad.signingSecret(orgId, row.id)) : null;
      try {
        await adapter.updateWebhook(
          credential,
          { externalFormId: row.externalFormId, externalWebhookId: hook.externalWebhookId },
          { url, isEnabled: true, ...(adapter.capabilities.supportsSigningSecret && secret ? { signingSecret: secret } : {}) },
        );
        urlUpdated = true;
      } catch (error) {
        throw this.integrations.toHttp(error);
      }
    }

    await this.prisma.leadSource.update({
      where: { id: row.id },
      data: {
        externalWebhookId: hook.externalWebhookId,
        remoteState: RemoteWebhookState.INSTALLED,
        remoteSyncedAt: new Date(),
        remoteErrorCode: null,
        remoteErrorMessage: null,
      },
    });
    return {
      remoteState: RemoteWebhookState.INSTALLED,
      repaired: row.externalWebhookId !== hook.externalWebhookId || urlUpdated,
      removedDuplicates,
      urlUpdated,
    };
  }

  async reinstall(orgId: string, leadSourceId: string) {
    const row = await this.apiSource(orgId, leadSourceId);
    this.assertIngestUrlIsReachable();
    const cred = await this.integrations.credentialFor(orgId, row.integrationId);
    const adapter = this.registry.get(cred.provider);
    const token = this.leadSources.decryptToken(row);
    if (!token) throw new ConflictException({ error: { code: 'TOKEN_UNREADABLE', message: 'The ingest token cannot be read.' } });
    const secret = row.signingSecretEnc ? this.secrets.open(row.signingSecretEnc, aad.signingSecret(orgId, row.id)) : null;
    try {
      const hook = await adapter.installWebhook(
        { apiKey: cred.apiKey },
        {
          externalFormId: row.externalFormId,
          url: this.leadSources.ingestUrl(token, row.provider),
          signingSecret: adapter.capabilities.supportsSigningSecret ? secret : null,
          externalRef: row.id,
        },
      );
      await this.prisma.leadSource.update({
        where: { id: row.id },
        data: {
          externalWebhookId: hook.externalWebhookId,
          remoteState: RemoteWebhookState.INSTALLED,
          remoteSyncedAt: new Date(),
          remoteErrorCode: null,
          remoteErrorMessage: null,
        },
      });
      return { remoteState: RemoteWebhookState.INSTALLED, externalWebhookId: hook.externalWebhookId };
    } catch (error) {
      throw this.integrations.toHttp(error);
    }
  }

  /** Archives the source; its history stays, and its URL answers 410 from now on. */
  async disconnect(orgId: string, leadSourceId: string, actorId: string, removeRemote = true, force = false) {
    const row = await this.prisma.leadSource.findFirst({ where: { id: leadSourceId, orgId } });
    if (!row) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'No such lead source.' } });

    let remoteState: RemoteWebhookState = RemoteWebhookState.UNINSTALLED;
    let warning: string | null = null;
    const manageable =
      removeRemote && row.connectionMethod === ConnectionMethod.API && row.integrationId && row.externalWebhookId && row.externalFormId;
    if (manageable) {
      try {
        const cred = await this.integrations.credentialFor(orgId, row.integrationId!);
        await this.registry.get(cred.provider).uninstallWebhook(
          { apiKey: cred.apiKey },
          { externalFormId: row.externalFormId!, externalWebhookId: row.externalWebhookId! },
        );
      } catch (error) {
        if (!force) {
          throw new ConflictException({
            error: {
              code: 'CANNOT_REMOVE_REMOTE',
              message: `We could not remove the webhook from the provider (${
                error instanceof ProviderApiError ? error.kind : 'unknown error'
              }). Retry, or disconnect anyway with force and remove it there yourself.`,
              externalWebhookId: row.externalWebhookId,
            },
          });
        }
        remoteState = RemoteWebhookState.ORPHANED;
        warning =
          `The webhook ${row.externalWebhookId} may still exist on your form and will keep firing at a URL ` +
          'that now returns 410. Remove it in the provider to stop that.';
      }
    }

    await this.prisma.leadSource.update({
      where: { id: row.id },
      data: {
        archivedAt: new Date(),
        isActive: false,
        remoteState,
        externalWebhookId: remoteState === RemoteWebhookState.ORPHANED ? row.externalWebhookId : null,
      },
    });
    await this.audit.record({
      orgId,
      actorType: 'user',
      actorId,
      action: 'lead_source.disconnected',
      entityType: 'lead_source',
      entityId: row.id,
      payload: { remoteState, removeRemote },
    });
    return { disconnected: true, remoteState, warning };
  }
}
