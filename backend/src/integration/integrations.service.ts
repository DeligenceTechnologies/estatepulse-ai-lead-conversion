import { BadRequestException, ConflictException, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { IntegrationProvider, IntegrationStatus, type Integration } from '@prisma/client';
import { httpError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { sha256Hex } from '@/common/utils/crypto';
import { ConnectionRefused } from '@/connections/connection-definition';
import { ConnectionsService } from '@/connections/connections.service';
import { NangoError } from '@/nango/nango.service';
import { ProviderRegistry } from './providers/provider.registry';
import { ProviderApiError, type ProviderCredential } from './providers/types';

/** Form providers' adapter codes ('TALLY', 'TYPEFORM') and how their accounts are stored. */
const FORM_PROVIDERS: Record<string, IntegrationProvider> = {
  TALLY: IntegrationProvider.tally,
  TYPEFORM: IntegrationProvider.typeform,
};
const ADAPTER_CODE: Partial<Record<IntegrationProvider, string>> = { tally: 'TALLY', typeform: 'TYPEFORM' };

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

/**
 * Form-provider accounts (Tally, Typeform) as connections, used to install
 * and repair webhooks on the customer's forms. Connecting, the credential
 * (Tally's API key, Typeform's OAuth grant) and disconnecting are
 * ConnectionsService's.
 */
@Injectable()
export class IntegrationsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ProviderRegistry,
    private readonly connections: ConnectionsService,
  ) {}

  onModuleInit(): void {
    const forms = [
      { code: 'TALLY', key: 'tally' as const, provider: IntegrationProvider.tally, auth: 'apiKey' as const },
      { code: 'TYPEFORM', key: 'typeform' as const, provider: IntegrationProvider.typeform, auth: 'oauth' as const },
    ];
    for (const form of forms) {
      if (!this.registry.has(form.code)) continue;
      const adapter = this.registry.get(form.code);
      const label = adapter.displayName;
      this.connections.register({
        key: form.key,
        provider: form.provider,
        label,
        description: `Install the lead webhook on your ${label} forms in one click.`,
        category: 'leads',
        auth: form.auth,
        multiple: true,
        impact: `New ${label} form submissions are not reaching your lead sources.`,
        unavailable: () => null,
        identify: async (credential) => {
          let account;
          try {
            account = await adapter.verifyCredential({ apiKey: credential });
          } catch (error) {
            if (error instanceof ProviderApiError && error.kind === 'INVALID_CREDENTIAL') {
              throw new ConnectionRefused(400, 'PROVIDER_INVALID_CREDENTIAL', `${label} did not accept that key.`);
            }
            throw error;
          }
          // An API key identifies itself; an OAuth token changes on every refresh, so Typeform is matched by account.
          const accountId = account.externalAccountId || sha256Hex(credential);
          return {
            accountId,
            email: account.email,
            name: account.displayName,
            preview: form.auth === 'apiKey' ? `${credential.slice(0, 8)}…${credential.slice(-4)}` : null,
          };
        },
        // Two presses when forms still use it: those forms go on delivering leads, but we can no longer repair or remove their webhooks.
        disconnecting: async ({ tx, orgId, row, force }) => {
          const sources = await tx.leadSource.findMany({ where: { orgId, integrationId: row.id, archivedAt: null }, select: { id: true, name: true } });
          if (sources.length > 0 && !force) {
            const one = sources.length === 1;
            throw new ConnectionRefused(
              409,
              'CREDENTIAL_IN_USE',
              `${sources.length} connected form${one ? '' : 's'} still ${one ? 'uses' : 'use'} this account. Disconnecting leaves ` +
                `${one ? 'that form' : 'those forms'} delivering leads that we can no longer manage or repair.`,
            );
          }
          await tx.leadSource.updateMany({ where: { orgId, integrationId: row.id }, data: { integrationId: null, remoteState: 'ORPHANED' } });
          return { orphanedLeadSources: sources.length };
        },
        view: (row) => ({ adapter: ADAPTER_CODE[row.provider] }),
      });
    }
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
    const apiKey = await this.keyFor(row);
    try {
      const account = await adapter.verifyCredential({ apiKey });
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
    return { apiKey: await this.keyFor(row), provider: ADAPTER_CODE[row.provider]! };
  }

  /** active -> invalid, emailing the owners once on the transition (ConnectionsService.markBroken). */
  async markInvalid(id: string, code: string) {
    await this.connections.markBroken(id, code);
    return this.prisma.integration.findUniqueOrThrow({ where: { id } });
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

  /** The credential Nango holds for this row. */
  private async keyFor(row: Integration): Promise<string> {
    const label = this.registry.get(ADAPTER_CODE[row.provider]!).displayName;
    try {
      return await this.connections.credential(row);
    } catch (error) {
      if (error instanceof NangoError && error.kind === 'REAUTH') {
        await this.markInvalid(row.id, 'REAUTH_REQUIRED');
        throw httpError(409, 'CREDENTIAL_RECONNECT_REQUIRED', `${label} needs to be reconnected. Connect ${label} again to continue.`);
      }
      if (error instanceof NangoError) throw httpError(502, 'PROVIDER_UNAVAILABLE', `Could not reach ${label}. Try again shortly.`);
      throw error;
    }
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
