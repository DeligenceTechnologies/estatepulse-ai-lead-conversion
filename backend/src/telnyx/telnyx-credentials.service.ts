import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { IntegrationProvider, IntegrationStatus, Prisma, type Integration } from '@prisma/client';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { ConnectionAlertService } from '@/common/service/connection-alert.service';
import { sha256Hex } from '@/common/utils/crypto';
import { ConnectionRefused } from '@/connections/connection-definition';
import { ConnectionsService } from '@/connections/connections.service';
import { NangoError } from '@/nango/nango.service';
import { normalizePhone } from './phone';

const TELNYX_API = 'https://api.telnyx.com/v2';

export interface TelnyxCreds {
  label: string;
  /** Read from Nango on every load, never stored here. Empty when the account must be reconnected. */
  apiKey: string;
  publicKey: string;
  connectionId: string;
  messagingProfileId: string;
  fromNumber: string;
  assistantId: string;
  connectedAt: string | null;
  /** Telnyx refused this key on a live call or text, and the owners were told. */
  keyRejected?: boolean;
}

interface TelnyxConfig {
  publicKey?: string;
  connectionId?: string;
  messagingProfileId?: string;
  assistantId?: string;
  /** Number and public key saved: the account can place calls. Until then it waits as "needs setup". */
  setupDone?: boolean;
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
  hasPublicKey: boolean;
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
  hasPublicKey: boolean;
  active: boolean;
  connectedAt: string | null;
}

const PROVIDER = IntegrationProvider.telnyx;
/** integrations.last_error_code while Telnyx is refusing the active key; latches the owners' alert. */
const KEY_REJECTED = 'TELNYX_KEY_REJECTED';
const mask = (key: string): string => (key ? `${key.slice(0, 6)}…${key.slice(-4)}` : '');

/**
 * The organization's own Telnyx accounts. Several may be on file (one per
 * market, say) but exactly one is active, and every call and text goes
 * through it; a partial unique index holds that, and every write that
 * activates an account switches the others off first, in one transaction.
 *
 * Each account's API key is held by Nango (the "telnyx" integration); the row
 * keeps the connection id and the non-secret setup (public key, number, apps).
 */
@Injectable()
export class TelnyxCredentialsService implements OnModuleInit {
  private readonly logger = new Logger('TelnyxCredentials');

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectionAlerts: ConnectionAlertService,
    private readonly connections: ConnectionsService,
  ) {}

  onModuleInit(): void {
    this.connections.register({
      key: 'telnyx',
      provider: PROVIDER,
      label: 'Telnyx',
      description: 'AI voice calls and SMS to your leads, from your own numbers.',
      category: 'calling',
      auth: 'apiKey',
      multiple: true,
      needsSetup: true,
      impact: 'AI calls and text messages to leads are failing.',
      unavailable: () => null,
      identify: async (apiKey) => {
        // Telnyx has no "who am I"; a key that can read the account balance is a working key, and identifies itself.
        const res = await fetch(`${TELNYX_API}/balance`, { headers: { Authorization: `Bearer ${apiKey}` } }).catch(() => null);
        if (!res) throw new Error('Telnyx did not respond');
        if (res.status === 401 || res.status === 403) throw new ConnectionRefused(400, 'TELNYX_KEY_REJECTED', 'Telnyx did not accept that API key. Copy a V2 key (starts with "KEY") from Telnyx → Account Settings → API Keys.');
        if (!res.ok) throw new Error(`Telnyx answered HTTP ${res.status}`);
        return { accountId: `key:${sha256Hex(apiKey).slice(0, 32)}`, name: 'Telnyx account', preview: mask(apiKey) };
      },
      view: (row) => {
        const c = this.fromRow(row);
        return { active: row.status === IntegrationStatus.active, fromNumber: c.fromNumber, hasAssistant: Boolean(c.assistantId), keyRejected: Boolean(c.keyRejected) };
      },
    });
  }

  /** One account's setup and key, whether or not it is the one in use. */
  async accountCreds(orgId: string, accountId: string): Promise<TelnyxCreds> {
    return this.load(await this.ownedRow(orgId, accountId));
  }

  async getCreds(orgId: string): Promise<TelnyxCreds | null> {
    const row = await this.activeRow(orgId);
    return row ? this.load(row) : null;
  }

  /** The API key of one of this organization's Telnyx accounts (to verify it and list its numbers). */
  async keyFor(orgId: string, accountId: string): Promise<string> {
    const row = await this.ownedRow(orgId, accountId);
    const key = (await this.load(row)).apiKey;
    if (!key) throw new AppError('VALIDATION_ERROR', 'The Telnyx API key for this account can no longer be read. Reconnect it.');
    return key;
  }

  /**
   * Telnyx refused the active key on a live call or text. Flags the account and
   * emails the owners once; later refusals of the same key stay quiet until it
   * works again (keyAccepted) or a key is saved.
   */
  async keyRejected(orgId: string): Promise<void> {
    const row = await this.activeRow(orgId);
    if (row) await this.flagRejected(row);
  }

  private async flagRejected(row: Integration): Promise<void> {
    const orgId = row.orgId;
    const brokenAt = new Date();
    const flagged = await this.prisma.integration.updateMany({
      where: { id: row.id, orgId, status: IntegrationStatus.active, OR: [{ lastErrorCode: null }, { lastErrorCode: { not: KEY_REJECTED } }] },
      data: { lastErrorCode: KEY_REJECTED, lastErrorAt: brokenAt },
    });
    if (flagged.count === 0) return;
    this.connectionAlerts.connectionBroken({
      orgId,
      connectionId: row.id,
      providerLabel: 'Telnyx',
      account: row.label || row.phoneNumber,
      impact: 'AI calls and text messages to leads are failing.',
      reconnectPath: '/integrations',
      brokenAt,
    });
  }

  /** A call or text went through with a key flagged as refused: clear the flag so a later refusal alerts again. */
  async keyAccepted(orgId: string, creds: TelnyxCreds): Promise<void> {
    if (!creds.keyRejected) return;
    await this.prisma.integration.updateMany({
      where: { orgId, provider: PROVIDER, status: IntegrationStatus.active, lastErrorCode: KEY_REJECTED },
      data: { lastErrorCode: null, lastErrorAt: null },
    });
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

  /**
   * Saves an account's setup (number, public key, apps, assistant) and makes it
   * the one in use. Without `accountId` it is the account in use, or the most
   * recent one. The key itself is only ever connected through Nango Connect.
   */
  async saveCreds(orgId: string, patch: Partial<TelnyxCreds>, accountId?: string): Promise<TelnyxCreds> {
    const existing = accountId ? await this.ownedRow(orgId, accountId) : ((await this.activeRow(orgId)) ?? (await this.latestRow(orgId)));
    if (!existing) throw new AppError('VALIDATION_ERROR', 'Connect a Telnyx API key first.');
    const current = await this.load(existing);
    const next = { ...current, ...patch };
    const saved = await this.prisma.$transaction(async (tx) => {
      await this.deactivateAll(tx, orgId, existing.id);
      return tx.integration.update({ where: { id: existing.id }, data: { ...this.columns(next), status: IntegrationStatus.active } });
    });
    return { ...next, connectedAt: saved.createdAt.toISOString(), keyRejected: false };
  }

  async listAccounts(orgId: string): Promise<TelnyxAccount[]> {
    const rows = await this.prisma.integration.findMany({ where: { orgId, provider: PROVIDER, revokedAt: null }, orderBy: { createdAt: 'asc' } });
    return rows
      .map((row) => {
        const c = this.fromRow(row);
        return {
          id: row.id,
          label: c.label,
          apiKeyMasked: row.credentialPreview ?? '',
          fromNumber: c.fromNumber,
          assistantId: c.assistantId,
          connectionId: c.connectionId,
          messagingProfileId: c.messagingProfileId,
          hasMessaging: Boolean(c.messagingProfileId),
          hasPublicKey: Boolean(c.publicKey),
          active: row.status === IntegrationStatus.active,
          connectedAt: c.connectedAt,
        };
      })
      .sort((a, b) => Number(b.active) - Number(a.active));
  }

  async activateAccount(orgId: string, id: string): Promise<void> {
    const row = await this.ownedRow(orgId, id);
    if (row.status === IntegrationStatus.invalid) throw new AppError('VALIDATION_ERROR', 'Reconnect this Telnyx API key before switching to it.');
    if (!this.fromRow(row).fromNumber) throw new AppError('VALIDATION_ERROR', 'Finish setting up this Telnyx account (number and public key) first.');
    await this.prisma.$transaction(async (tx) => {
      await this.deactivateAll(tx, orgId, id);
      await tx.integration.update({ where: { id }, data: { status: IntegrationStatus.active } });
    });
  }

  async renameAccount(orgId: string, id: string, label: string): Promise<void> {
    await this.ownedRow(orgId, id);
    await this.prisma.integration.update({ where: { id }, data: { label } });
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
    const hasKey = Boolean(row?.nangoConnectionId && row.status !== IntegrationStatus.invalid && this.fromRow(row).fromNumber);
    return {
      accountId: row?.id ?? '',
      label: c?.label ?? '',
      accountCount: rows.length,
      connected: Boolean(hasKey && active),
      hasAssistant: Boolean(c?.assistantId && active),
      hasIntegration: Boolean(row),
      status: row ? row.status : 'none',
      apiKeyMasked: hasKey && active ? (row?.credentialPreview ?? '') : '',
      connectionId: c?.connectionId ?? '',
      messagingProfileId: c?.messagingProfileId ?? '',
      hasMessaging: Boolean(c && active && c.messagingProfileId),
      hasPublicKey: Boolean(c?.publicKey),
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

  private activeRow(orgId: string) {
    return this.prisma.integration.findFirst({ where: { orgId, provider: PROVIDER, status: IntegrationStatus.active, revokedAt: null } });
  }

  private latestRow(orgId: string) {
    return this.prisma.integration.findFirst({ where: { orgId, provider: PROVIDER, revokedAt: null }, orderBy: { updatedAt: 'desc' } });
  }

  private async ownedRow(orgId: string, id: string): Promise<Integration> {
    const row = await this.prisma.integration.findFirst({ where: { id, orgId, provider: PROVIDER, revokedAt: null } });
    if (!row) throw new AppError('NOT_FOUND', 'Telnyx account not found.');
    return row;
  }

  private deactivateAll(tx: Prisma.TransactionClient, orgId: string, exceptId?: string) {
    return tx.integration.updateMany({
      where: { orgId, provider: PROVIDER, status: IntegrationStatus.active, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
      data: { status: IntegrationStatus.inactive },
    });
  }

  private columns(c: TelnyxCreds) {
    const config: TelnyxConfig = {
      publicKey: c.publicKey,
      connectionId: c.connectionId,
      messagingProfileId: c.messagingProfileId,
      assistantId: c.assistantId,
      setupDone: Boolean(c.publicKey && c.fromNumber),
    };
    return {
      label: c.label || null,
      // A saved account starts clean; if its key is refused, the owners hear about it again.
      lastErrorCode: null,
      lastErrorAt: null,
      // The webhooks look an org up by the normalized number, so that is the only shape stored.
      phoneNumber: normalizePhone(c.fromNumber) || null,
      config: config as Prisma.InputJsonObject,
    };
  }

  /** The row with its API key read from Nango. A refused or missing key comes back empty, flagged for the owners. */
  private async load(row: Integration): Promise<TelnyxCreds> {
    const creds = this.fromRow(row);
    if (!row.nangoConnectionId || row.status === IntegrationStatus.invalid) return creds;
    try {
      return { ...creds, apiKey: await this.connections.credential(row) };
    } catch (error) {
      if (!(error instanceof NangoError && error.kind === 'REAUTH')) throw error;
      this.logger.warn(`Telnyx account ${row.id}: its Nango connection is gone; reconnect required`);
      await this.flagRejected(row);
      return creds;
    }
  }

  /** The row's setup without its key. */
  private fromRow(row: Integration): TelnyxCreds {
    const config = (row.config ?? {}) as TelnyxConfig;
    return {
      label: row.label ?? '',
      apiKey: '',
      publicKey: config.publicKey ?? '',
      connectionId: config.connectionId ?? '',
      messagingProfileId: config.messagingProfileId ?? '',
      fromNumber: row.phoneNumber ?? '',
      assistantId: config.assistantId ?? '',
      connectedAt: row.createdAt.toISOString(),
      keyRejected: row.lastErrorCode === KEY_REJECTED,
    };
  }
}

function pickCallControlApp(apps: { id?: string; active?: boolean; webhook_event_url?: string }[]): string {
  const pick = apps.find((a) => a.active && a.webhook_event_url) ?? apps.find((a) => a.active) ?? apps[0];
  return pick?.id ? String(pick.id) : '';
}
