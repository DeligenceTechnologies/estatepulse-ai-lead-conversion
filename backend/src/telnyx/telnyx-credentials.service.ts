import { Injectable } from '@nestjs/common';
import { IntegrationProvider, IntegrationStatus, Prisma, type Integration } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { SecretBoxService } from '@/common/service/secret-box.service';
import { aad } from '@/common/utils/crypto';

const TELNYX_API = 'https://api.telnyx.com/v2';

export interface TelnyxCreds {
  label: string;
  apiKey: string;
  publicKey: string;
  connectionId: string;
  messagingProfileId: string;
  fromNumber: string;
  assistantId: string;
  connectedAt: string | null;
}

interface TelnyxConfig {
  publicKey?: string;
  connectionId?: string;
  messagingProfileId?: string;
  assistantId?: string;
}

export interface TelnyxPublicStatus {
  accountId: string;
  label: string;
  accountCount: number;
  connected: boolean;
  hasAssistant: boolean;
  hasIntegration: boolean;
  status: string;
  apiKeyMasked: string;
  connectionId: string;
  messagingProfileId: string;
  hasMessaging: boolean;
  fromNumber: string;
  assistantId: string;
  connectedAt: string | null;
}

export interface TelnyxAccount {
  id: string;
  label: string;
  apiKeyMasked: string;
  fromNumber: string;
  assistantId: string;
  connectionId: string;
  messagingProfileId: string;
  hasMessaging: boolean;
  active: boolean;
  connectedAt: string | null;
}

const PROVIDER = IntegrationProvider.telnyx;
const mask = (key: string): string => (key ? `${key.slice(0, 6)}…${key.slice(-4)}` : '');

/**
 * The organization's own Telnyx accounts. Several may be on file (one per
 * market, say) but exactly one is active, and every call and text goes
 * through it; a partial unique index holds that, and every write that
 * activates an account switches the others off first, in one transaction.
 */
@Injectable()
export class TelnyxCredentialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretBoxService,
  ) {}

  async getCreds(orgId: string): Promise<TelnyxCreds | null> {
    const row = await this.activeRow(orgId);
    return row ? this.fromRow(row) : null;
  }

  async isConnected(orgId: string): Promise<boolean> {
    return Boolean((await this.getCreds(orgId))?.apiKey);
  }

  /** The organization whose active account sends from `phoneNumber`. */
  async orgForNumber(phoneNumber: string): Promise<string | null> {
    const rows = await this.prisma.integration.findMany({
      where: { provider: PROVIDER, phoneNumber, revokedAt: null },
      select: { orgId: true, status: true },
    });
    return (rows.find((r) => r.status === IntegrationStatus.active) ?? rows[0])?.orgId ?? null;
  }

  /** Updates the account in use (or the most recent one), creating it on first save. */
  async saveCreds(orgId: string, patch: Partial<TelnyxCreds>): Promise<TelnyxCreds> {
    const existing = (await this.activeRow(orgId)) ?? (await this.latestRow(orgId));
    const current = existing ? this.fromRow(existing) : null;
    const next = { ...(current ?? emptyCreds()), ...patch };
    return this.prisma
      .$transaction(async (tx) => {
        await this.deactivateAll(tx, orgId, existing?.id);
        const row = existing
          ? await tx.integration.update({ where: { id: existing.id }, data: { ...this.columns(orgId, existing.id, next), status: IntegrationStatus.active } })
          : await this.insert(tx, orgId, next);
        return this.fromRow(row);
      })
      .catch((error) => this.oneCallingProvider(orgId, error));
  }

  async createAccount(orgId: string, creds: Partial<TelnyxCreds>): Promise<string> {
    return this.prisma
      .$transaction(async (tx) => {
        await this.deactivateAll(tx, orgId);
        return (await this.insert(tx, orgId, { ...emptyCreds(), ...creds })).id;
      })
      .catch((error) => this.oneCallingProvider(orgId, error));
  }

  async listAccounts(orgId: string): Promise<TelnyxAccount[]> {
    const rows = await this.prisma.integration.findMany({ where: { orgId, provider: PROVIDER, revokedAt: null }, orderBy: { createdAt: 'asc' } });
    return rows
      .map((row) => {
        const c = this.fromRow(row);
        return {
          id: row.id,
          label: c.label,
          apiKeyMasked: mask(c.apiKey),
          fromNumber: c.fromNumber,
          assistantId: c.assistantId,
          connectionId: c.connectionId,
          messagingProfileId: c.messagingProfileId,
          hasMessaging: Boolean(c.messagingProfileId),
          active: row.status === IntegrationStatus.active,
          connectedAt: c.connectedAt,
        };
      })
      .sort((a, b) => Number(b.active) - Number(a.active));
  }

  async activateAccount(orgId: string, id: string): Promise<void> {
    await this.ownedRow(orgId, id);
    await this.prisma
      .$transaction(async (tx) => {
        await this.deactivateAll(tx, orgId, id);
        await tx.integration.update({ where: { id }, data: { status: IntegrationStatus.active } });
      })
      .catch((error) => this.oneCallingProvider(orgId, error));
  }

  async renameAccount(orgId: string, id: string, label: string): Promise<void> {
    await this.ownedRow(orgId, id);
    await this.prisma.integration.update({ where: { id }, data: { label } });
  }

  async deleteAccount(orgId: string, id: string): Promise<void> {
    await this.ownedRow(orgId, id);
    await this.prisma.integration.delete({ where: { id } });
  }

  /** Switches every account off; the saved credentials stay for a later reconnect. */
  async clearCreds(orgId: string): Promise<void> {
    await this.prisma.integration.updateMany({ where: { orgId, provider: PROVIDER }, data: { status: IntegrationStatus.inactive } });
  }

  async reconnect(orgId: string, accountId?: string): Promise<void> {
    const target = accountId ? await this.ownedRow(orgId, accountId) : await this.latestRow(orgId);
    if (target) await this.activateAccount(orgId, target.id);
  }

  async publicStatus(orgId: string): Promise<TelnyxPublicStatus> {
    const rows = await this.prisma.integration.findMany({
      where: { orgId, provider: PROVIDER, revokedAt: null },
      orderBy: { updatedAt: 'desc' },
    });
    const row = rows.find((r) => r.status === IntegrationStatus.active) ?? rows[0] ?? null;
    const active = row?.status === IntegrationStatus.active;
    const c = row ? this.fromRow(row) : null;
    return {
      accountId: row?.id ?? '',
      label: c?.label ?? '',
      accountCount: rows.length,
      connected: Boolean(c?.apiKey && active),
      hasAssistant: Boolean(c?.assistantId && active),
      hasIntegration: Boolean(row),
      status: row ? row.status : 'none',
      apiKeyMasked: c && active ? mask(c.apiKey) : '',
      connectionId: c?.connectionId ?? '',
      messagingProfileId: c?.messagingProfileId ?? '',
      hasMessaging: Boolean(c && active && c.messagingProfileId),
      fromNumber: c?.fromNumber ?? '',
      assistantId: c && active ? c.assistantId : '',
      connectedAt: c?.connectedAt ?? null,
    };
  }

  /** The Call Control application calls are placed through: one with a webhook URL if there is one. */
  async findCallControlApp(apiKey: string): Promise<string> {
    return apiKey ? pickCallControlApp(await this.listCallControlApps(apiKey)) : '';
  }

  async findMessagingProfile(apiKey: string, fromNumber: string): Promise<string> {
    if (!apiKey) return '';
    try {
      if (fromNumber) {
        const res = await fetch(`${TELNYX_API}/phone_numbers?filter[phone_number]=${encodeURIComponent(fromNumber)}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        const id = res.ok ? ((await res.json()) as { data?: { messaging_profile_id?: string }[] }).data?.[0]?.messaging_profile_id : null;
        if (id) return String(id);
      }
      const res = await fetch(`${TELNYX_API}/messaging_profiles?page[size]=50`, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!res.ok) return '';
      const profiles = ((await res.json()) as { data?: { id?: string; enabled?: boolean }[] }).data ?? [];
      const pick = profiles.find((p) => p.enabled) ?? profiles[0];
      return pick?.id ? String(pick.id) : '';
    } catch {
      return '';
    }
  }

  /** The stored connection id, re-discovered when Telnyx no longer has it. */
  async ensureConnectionId(orgId: string, creds: TelnyxCreds): Promise<string> {
    if (!creds.apiKey) return creds.connectionId;
    const apps = await this.listCallControlApps(creds.apiKey);
    if (!apps.length || apps.some((a) => String(a.id) === creds.connectionId)) return creds.connectionId;
    const id = pickCallControlApp(apps);
    if (id && id !== creds.connectionId) await this.saveCreds(orgId, { connectionId: id });
    return id || creds.connectionId;
  }

  private async listCallControlApps(apiKey: string): Promise<{ id?: string; active?: boolean; webhook_event_url?: string }[]> {
    try {
      const res = await fetch(`${TELNYX_API}/call_control_applications?page[size]=50`, { headers: { Authorization: `Bearer ${apiKey}` } });
      return res.ok ? (((await res.json()) as { data?: [] }).data ?? []) : [];
    } catch {
      return [];
    }
  }

  /**
   * One calling provider per organization (integrations_one_active_calling):
   * activating a Telnyx account while Retell is the provider is refused by the
   * database, and said so plainly. Any other error is rethrown unchanged.
   */
  private async oneCallingProvider(orgId: string, error: unknown): Promise<never> {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const retell = await this.prisma.integration.count({ where: { orgId, provider: IntegrationProvider.retell, status: IntegrationStatus.active } });
      if (retell) throw new AppError('CONFLICT', 'Retell is this organization’s calling provider. Switch to Telnyx in Settings → Calling first, then connect the Telnyx account.');
    }
    throw error;
  }

  private activeRow(orgId: string) {
    return this.prisma.integration.findFirst({ where: { orgId, provider: PROVIDER, status: IntegrationStatus.active, revokedAt: null } });
  }

  private latestRow(orgId: string) {
    return this.prisma.integration.findFirst({ where: { orgId, provider: PROVIDER, revokedAt: null }, orderBy: { updatedAt: 'desc' } });
  }

  private async ownedRow(orgId: string, id: string): Promise<Integration> {
    const row = await this.prisma.integration.findFirst({ where: { id, orgId, provider: PROVIDER } });
    if (!row) throw new AppError('NOT_FOUND', 'Telnyx account not found.');
    return row;
  }

  private deactivateAll(tx: Prisma.TransactionClient, orgId: string, exceptId?: string) {
    return tx.integration.updateMany({
      where: { orgId, provider: PROVIDER, status: IntegrationStatus.active, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
      data: { status: IntegrationStatus.inactive },
    });
  }

  private insert(tx: Prisma.TransactionClient, orgId: string, creds: TelnyxCreds) {
    const id = randomUUID();
    return tx.integration.create({
      data: { id, orgId, provider: PROVIDER, status: IntegrationStatus.active, ...this.columns(orgId, id, creds) },
    });
  }

  private columns(orgId: string, id: string, c: TelnyxCreds) {
    const config: TelnyxConfig = {
      publicKey: c.publicKey,
      connectionId: c.connectionId,
      messagingProfileId: c.messagingProfileId,
      assistantId: c.assistantId,
    };
    return {
      label: c.label || null,
      credentials: this.secrets.seal(c.apiKey, aad.integration(orgId, id)),
      credentialPreview: mask(c.apiKey),
      phoneNumber: c.fromNumber || null,
      externalAccountId: c.assistantId || null,
      config: config as Prisma.InputJsonObject,
    };
  }

  private fromRow(row: Integration): TelnyxCreds {
    const config = (row.config ?? {}) as TelnyxConfig;
    let apiKey = '';
    try {
      apiKey = row.credentials ? this.secrets.open(row.credentials, aad.integration(row.orgId, row.id)) : '';
    } catch {
      apiKey = '';
    }
    return {
      label: row.label ?? '',
      apiKey,
      publicKey: config.publicKey ?? '',
      connectionId: config.connectionId ?? '',
      messagingProfileId: config.messagingProfileId ?? '',
      fromNumber: row.phoneNumber ?? '',
      assistantId: config.assistantId ?? '',
      connectedAt: row.createdAt.toISOString(),
    };
  }
}

function emptyCreds(): TelnyxCreds {
  return { label: '', apiKey: '', publicKey: '', connectionId: '', messagingProfileId: '', fromNumber: '', assistantId: '', connectedAt: null };
}

function pickCallControlApp(apps: { id?: string; active?: boolean; webhook_event_url?: string }[]): string {
  const pick = apps.find((a) => a.active && a.webhook_event_url) ?? apps.find((a) => a.active) ?? apps[0];
  return pick?.id ? String(pick.id) : '';
}
