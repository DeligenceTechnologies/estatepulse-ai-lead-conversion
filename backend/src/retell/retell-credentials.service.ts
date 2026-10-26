import { Injectable } from '@nestjs/common';
import { IntegrationProvider, IntegrationStatus, Prisma, type Integration } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { SecretBoxService } from '@/common/service/secret-box.service';
import { aad } from '@/common/utils/crypto';

export interface RetellCreds {
  id: string;
  apiKey: string;
  /** The workspace's designated webhook key: the only key Retell signs webhooks and tool calls with. */
  webhookKey: string;
  agentId: string;
  llmId: string;
  fromNumber: string;
  /** Active = the organization calls through Retell now; inactive = set up, waiting for the switch. */
  active: boolean;
  connectedAt: string;
}

interface RetellConfig {
  agentId?: string;
  llmId?: string;
}

interface Sealed {
  apiKey: string;
  webhookKey: string;
}

export type RetellPatch = Partial<Pick<RetellCreds, 'apiKey' | 'webhookKey' | 'agentId' | 'llmId' | 'fromNumber'>>;

const PROVIDER = IntegrationProvider.retell;
const mask = (key: string): string => (key ? `${key.slice(0, 6)}…${key.slice(-4)}` : '');

/**
 * The organization's Retell account: one integrations row, both keys sealed
 * to it. A new account starts inactive; only the provider switch makes it the
 * organization's calling account, since an organization calls through Telnyx
 * or Retell, never both.
 */
@Injectable()
export class RetellCredentialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretBoxService,
  ) {}

  async getCreds(orgId: string): Promise<RetellCreds | null> {
    const row = await this.row(orgId);
    return row ? this.fromRow(row) : null;
  }

  /** Updates the account, creating it (inactive) on first save. */
  async save(orgId: string, patch: RetellPatch): Promise<RetellCreds> {
    const row = await this.row(orgId);
    const current = row ? this.fromRow(row) : null;
    const next = {
      apiKey: patch.apiKey ?? current?.apiKey ?? '',
      webhookKey: patch.webhookKey ?? current?.webhookKey ?? '',
      agentId: patch.agentId ?? current?.agentId ?? '',
      llmId: patch.llmId ?? current?.llmId ?? '',
      fromNumber: patch.fromNumber ?? current?.fromNumber ?? '',
    };
    const id = row?.id ?? randomUUID();
    const columns = {
      credentials: this.secrets.seal(JSON.stringify({ apiKey: next.apiKey, webhookKey: next.webhookKey } satisfies Sealed), aad.integration(orgId, id)),
      credentialPreview: mask(next.apiKey),
      phoneNumber: next.fromNumber || null,
      externalAccountId: next.agentId || null,
      config: { agentId: next.agentId, llmId: next.llmId } satisfies RetellConfig as Prisma.InputJsonObject,
    };
    const saved = row
      ? await this.prisma.integration.update({ where: { id }, data: columns })
      : await this.prisma.integration.create({ data: { id, orgId, provider: PROVIDER, status: IntegrationStatus.inactive, ...columns } });
    return this.fromRow(saved);
  }

  /** Forgets the account. Refused while it is the organization's calling account. */
  async remove(orgId: string): Promise<void> {
    const row = await this.row(orgId);
    if (!row) return;
    if (row.status === IntegrationStatus.active) {
      throw new AppError('CONFLICT', 'Retell is this organization’s calling provider. Switch to Telnyx before disconnecting it.');
    }
    await this.prisma.integration.deleteMany({ where: { orgId, provider: PROVIDER } });
  }

  async publicStatus(orgId: string) {
    const c = await this.getCreds(orgId);
    return {
      connected: Boolean(c?.apiKey),
      active: Boolean(c?.active),
      apiKeyMasked: mask(c?.apiKey ?? ''),
      hasWebhookKey: Boolean(c?.webhookKey),
      agentId: c?.agentId ?? '',
      fromNumber: c?.fromNumber ?? '',
      connectedAt: c?.connectedAt ?? null,
    };
  }

  private row(orgId: string) {
    return this.prisma.integration.findFirst({ where: { orgId, provider: PROVIDER, revokedAt: null }, orderBy: { updatedAt: 'desc' } });
  }

  private fromRow(row: Integration): RetellCreds {
    const config = (row.config ?? {}) as RetellConfig;
    let sealed: Sealed = { apiKey: '', webhookKey: '' };
    try {
      sealed = { ...sealed, ...(JSON.parse(this.secrets.open(row.credentials, aad.integration(row.orgId, row.id))) as Partial<Sealed>) };
    } catch {
      // An unreadable secret reads as no key: the account shows as needing reconnection.
    }
    return {
      id: row.id,
      apiKey: sealed.apiKey,
      webhookKey: sealed.webhookKey,
      agentId: config.agentId ?? '',
      llmId: config.llmId ?? '',
      fromNumber: row.phoneNumber ?? '',
      active: row.status === IntegrationStatus.active,
      connectedAt: row.createdAt.toISOString(),
    };
  }
}
