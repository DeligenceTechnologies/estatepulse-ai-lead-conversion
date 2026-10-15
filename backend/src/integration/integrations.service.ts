import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { IntegrationProvider, IntegrationStatus, type Integration } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '@/common/prisma/prisma.service';
import { SecretBoxService } from '@/common/service/secret-box.service';
import { aad, sha256Hex } from '@/common/utils/crypto';
import { ProviderRegistry } from './providers/provider.registry';
import { ProviderApiError, type ProviderCredential } from './providers/types';

/** Form providers' adapter codes ('TALLY') and how their accounts are stored. */
const FORM_PROVIDERS: Record<string, IntegrationProvider> = { TALLY: IntegrationProvider.tally };
const ADAPTER_CODE: Partial<Record<IntegrationProvider, string>> = { tally: 'TALLY' };

export interface ProviderCredentialSummary {
  id: string;
  provider: string;
  label: string | null;
  credentialPreview: string;
  accountEmail: string | null;
  accountName: string | null;
  status: string;
  lastVerifiedAt: Date | null;
  lastErrorCode: string | null;
  createdAt: Date;
  leadSourceCount: number;
}

/** Form-provider API keys (Tally today), kept so we can install and repair webhooks on the customer's forms. */
@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretBoxService,
    private readonly registry: ProviderRegistry,
  ) {}

  async connect(orgId: string, providerCode: string, apiKey: string, label?: string) {
    const key = (apiKey ?? '').trim();
    if (!key) throw new BadRequestException({ error: { code: 'CREDENTIAL_REQUIRED', message: 'An API key is required.' } });
    const adapter = this.registry.get(providerCode);
    const provider = FORM_PROVIDERS[adapter.provider];
    let account;
    try {
      account = await adapter.verifyCredential({ apiKey: key });
    } catch (error) {
      throw this.toHttp(error);
    }

    const credentialHash = sha256Hex(key);
    const verified = {
      status: IntegrationStatus.active,
      lastVerifiedAt: new Date(),
      lastErrorAt: null,
      lastErrorCode: null,
      accountEmail: account.email,
      accountName: account.displayName,
      externalAccountId: account.externalAccountId,
    };
    const existing = await this.prisma.integration.findFirst({
      where: { orgId, provider, credentialHash, revokedAt: null },
    });
    if (existing) {
      const refreshed = await this.prisma.integration.update({
        where: { id: existing.id },
        data: { ...verified, ...(label ? { label } : {}) },
      });
      return this.toSummary(refreshed, await this.countSources(orgId, refreshed.id));
    }

    const id = randomUUID();
    const created = await this.prisma.integration.create({
      data: {
        id,
        orgId,
        provider,
        label: label ?? account.email ?? adapter.displayName,
        credentials: this.secrets.seal(key, aad.integration(orgId, id)),
        credentialHash,
        credentialPreview: `${key.slice(0, 8)}…${key.slice(-4)}`,
        ...verified,
      },
    });
    this.logger.log(`Connected ${adapter.provider} for org ${orgId}`);
    return this.toSummary(created, 0);
  }

  async list(orgId: string, providerCode?: string) {
    const providers = providerCode
      ? [FORM_PROVIDERS[providerCode.toUpperCase()]].filter(Boolean)
      : Object.values(FORM_PROVIDERS);
    const rows = await this.prisma.integration.findMany({
      where: { orgId, provider: { in: providers }, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return Promise.all(rows.map(async (row) => this.toSummary(row, await this.countSources(orgId, row.id))));
  }

  async verify(orgId: string, id: string) {
    const row = await this.mustFind(orgId, id);
    const adapter = this.registry.get(ADAPTER_CODE[row.provider]!);
    try {
      const account = await adapter.verifyCredential({ apiKey: this.decrypt(row) });
      const ok = await this.prisma.integration.update({
        where: { id: row.id },
        data: {
          status: IntegrationStatus.active,
          lastVerifiedAt: new Date(),
          lastErrorAt: null,
          lastErrorCode: null,
          accountEmail: account.email,
          accountName: account.displayName,
        },
      });
      return this.toSummary(ok, await this.countSources(orgId, row.id));
    } catch (error) {
      if (error instanceof ProviderApiError && error.kind === 'INVALID_CREDENTIAL') {
        const bad = await this.markInvalid(row.id, error.kind);
        return this.toSummary(bad, await this.countSources(orgId, row.id));
      }
      throw this.toHttp(error);
    }
  }

  async revoke(orgId: string, id: string, force = false) {
    const row = await this.mustFind(orgId, id);
    const sources = await this.prisma.leadSource.findMany({
      where: { orgId, integrationId: id, archivedAt: null },
      select: { id: true, name: true },
    });
    if (sources.length > 0 && !force) {
      const one = sources.length === 1;
      throw new ConflictException({
        error: {
          code: 'CREDENTIAL_IN_USE',
          message:
            `${sources.length} connected form${one ? '' : 's'} still ${one ? 'uses' : 'use'} this key. Removing it leaves ` +
            `${one ? 'that form' : 'those forms'} delivering leads that we can no longer manage or repair.`,
          leadSources: sources,
        },
      });
    }
    await this.prisma.$transaction([
      this.prisma.integration.update({
        where: { id: row.id },
        data: { status: IntegrationStatus.revoked, revokedAt: new Date() },
      }),
      this.prisma.leadSource.updateMany({
        where: { orgId, integrationId: id },
        data: { integrationId: null, remoteState: 'ORPHANED' },
      }),
    ]);
    return { revoked: true, orphanedLeadSources: sources.length };
  }

  async connectedFormIds(orgId: string): Promise<Map<string, string>> {
    const rows = await this.prisma.leadSource.findMany({
      where: { orgId, archivedAt: null, externalFormId: { not: null } },
      select: { id: true, externalFormId: true },
    });
    return new Map(rows.map((r) => [r.externalFormId!, r.id]));
  }

  async credentialFor(orgId: string, id: string): Promise<ProviderCredential & { provider: string }> {
    const row = await this.mustFind(orgId, id);
    if (row.status === IntegrationStatus.revoked) {
      throw new ConflictException({
        error: { code: 'CREDENTIAL_REVOKED', message: 'That connection was disconnected. Reconnect it first.' },
      });
    }
    return { apiKey: this.decrypt(row), provider: ADAPTER_CODE[row.provider]! };
  }

  markInvalid(id: string, code: string) {
    return this.prisma.integration.update({
      where: { id },
      data: { status: IntegrationStatus.invalid, lastErrorAt: new Date(), lastErrorCode: code },
    });
  }

  toHttp(error: unknown) {
    if (!(error instanceof ProviderApiError)) return error;
    const body = { error: { code: `PROVIDER_${error.kind}`, message: error.message } };
    switch (error.kind) {
      case 'INVALID_CREDENTIAL':
      case 'INVALID_REQUEST':
        return new BadRequestException(body);
      case 'NOT_FOUND':
        return new NotFoundException(body);
      default:
        return new ConflictException(body);
    }
  }

  private async mustFind(orgId: string, id: string) {
    const row = await this.prisma.integration.findFirst({
      where: { id, orgId, provider: { in: Object.values(FORM_PROVIDERS) } },
    });
    if (!row) throw new NotFoundException({ error: { code: 'CREDENTIAL_NOT_FOUND', message: 'No such connection.' } });
    return row;
  }

  private decrypt(row: Pick<Integration, 'id' | 'orgId' | 'credentials'>): string {
    return this.secrets.open(row.credentials, aad.integration(row.orgId, row.id));
  }

  private countSources(orgId: string, integrationId: string) {
    return this.prisma.leadSource.count({ where: { orgId, integrationId, archivedAt: null } });
  }

  private toSummary(row: Integration, leadSourceCount: number): ProviderCredentialSummary {
    return {
      id: row.id,
      provider: ADAPTER_CODE[row.provider] ?? row.provider,
      label: row.label,
      credentialPreview: row.credentialPreview ?? '',
      accountEmail: row.accountEmail,
      accountName: row.accountName,
      status: row.status.toUpperCase(),
      lastVerifiedAt: row.lastVerifiedAt,
      lastErrorCode: row.lastErrorCode,
      createdAt: row.createdAt,
      leadSourceCount,
    };
  }
}
