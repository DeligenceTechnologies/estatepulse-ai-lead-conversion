import { Inject, Injectable } from '@nestjs/common';
import { TENANT_PRISMA, type GuardedPrisma } from '../prisma/prisma.service';
import { SecretCipherService } from './secret-cipher.service';

/**
 * Per-org Telnyx credentials (Bring-Your-Own-Telnyx), persisted in the shared
 * `integrations` table (provider='telnyx'). API key encrypted at rest.
 */
const PROVIDER = 'telnyx';
const TYPE = 'voice'; // allowed: sms|voice|crm|calendar|other
const STATUS = 'active'; // allowed: active|inactive|error

export interface Creds {
  apiKey: string;
  publicKey: string;
  connectionId: string;
  messagingProfileId: string;
  fromNumber: string;
  assistantId: string;
  connectedAt: string | null;
}

export interface TelnyxPublicStatus {
  connected: boolean;
  hasAssistant: boolean;
  hasIntegration: boolean;
  status: string;
  apiKeyMasked: string;
  connectionId: string;
  messagingProfileId: string;
  /** True once a messaging profile is resolved — i.e. SMS can actually send. */
  hasMessaging: boolean;
  fromNumber: string;
  assistantId: string;
  connectedAt: string | null;
}

const EMPTY: Creds = {
  apiKey: '',
  publicKey: '',
  connectionId: '',
  messagingProfileId: '',
  fromNumber: '',
  assistantId: '',
  connectedAt: null,
};

/* eslint-disable @typescript-eslint/no-explicit-any */

@Injectable()
export class CredStoreService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma,
    private readonly cipher: SecretCipherService,
  ) {}

  private fromRow(r: any): Creds {
    const m = (r.metadata ?? {}) as Record<string, string>;
    return {
      apiKey: this.cipher.decrypt(r.credentials_secret_ref ?? '') || '',
      publicKey: m.publicKey ?? '',
      connectionId: m.connectionId ?? '',
      messagingProfileId: m.messagingProfileId ?? '',
      fromNumber: m.fromNumber ?? '',
      assistantId: r.external_account_id ?? '',
      connectedAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    };
  }

  private rowFor(orgId: string) {
    return this.prisma.integrations.findFirst({
      where: { organization_id: orgId, provider: PROVIDER },
      orderBy: { created_at: 'asc' },
    });
  }

  private isActive(r: any): boolean {
    return (r?.status ?? 'active') === 'active';
  }

  /**
   * Operational credentials: only returned when the integration is ACTIVE. A
   * disconnected (inactive) row still exists but is treated as not connected.
   */
  async getCreds(orgId: string): Promise<Creds | null> {
    const r = await this.rowFor(orgId);
    return r && this.isActive(r) ? this.fromRow(r) : null;
  }

  /**
   * Outbound calls (/v2/calls) require a **Call Control Application** id with a
   * webhook URL — NOT the number's connection, which is the AI assistant's
   * inbound connection and which Telnyx rejects with error 10015. The connect
   * flow never captured a Call Control app, so it is resolved from the account
   * and cached, and the user never has to enter a connection id by hand.
   */
  private async listCallControlApps(apiKey: string): Promise<any[]> {
    try {
      const res = await fetch('https://api.telnyx.com/v2/call_control_applications?page[size]=50', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) return [];
      return ((await res.json()) as any).data ?? [];
    } catch {
      return [];
    }
  }

  /** Pick a usable Call Control app id (active, webhook URL preferred). '' if none. */
  private pickCallControlApp(apps: any[]): string {
    const pick =
      apps.find((a) => a.active && a.webhook_event_url) ?? apps.find((a) => a.active) ?? apps[0];
    return pick?.id ? String(pick.id) : '';
  }

  /**
   * Validation for the connect flow: does this API key have a Call Control app
   * we can place outbound calls through? Returns the id, or '' if it has none.
   */
  async findCallControlApp(apiKey: string): Promise<string> {
    if (!apiKey) return '';
    return this.pickCallControlApp(await this.listCallControlApps(apiKey));
  }

  /**
   * Messaging (SMS) needs a Messaging Profile. Prefer the profile the from-number
   * is already assigned to; otherwise fall back to the account's first enabled
   * profile. '' if the account has no messaging profile at all.
   */
  async findMessagingProfile(apiKey: string, fromNumber: string): Promise<string> {
    if (!apiKey) return '';
    try {
      if (fromNumber) {
        const r = await fetch(
          `https://api.telnyx.com/v2/phone_numbers?filter[phone_number]=${encodeURIComponent(fromNumber)}`,
          { headers: { Authorization: `Bearer ${apiKey}` } },
        );
        if (r.ok) {
          const id = ((await r.json()) as any).data?.[0]?.messaging_profile_id;
          if (id) return String(id);
        }
      }
      const r2 = await fetch('https://api.telnyx.com/v2/messaging_profiles?page[size]=50', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!r2.ok) return '';
      const profs: any[] = ((await r2.json()) as any).data ?? [];
      const pick = profs.find((x) => x.enabled) ?? profs[0];
      return pick?.id ? String(pick.id) : '';
    } catch {
      return '';
    }
  }

  /** The org's messaging profile, deriving and caching it from the number if unset. */
  async ensureMessagingProfile(orgId: string, c: Creds): Promise<string> {
    if (c.messagingProfileId) return c.messagingProfileId;
    const id = await this.findMessagingProfile(c.apiKey, c.fromNumber);
    if (id) await this.saveCreds(orgId, { messagingProfileId: id });
    return id;
  }

  /**
   * Keeps a valid Call Control app, or repairs a stale/invalid one — which is
   * what a previously mis-derived assistant connection is.
   */
  async ensureConnectionId(orgId: string, c: Creds): Promise<string> {
    if (!c.apiKey) return c.connectionId || '';
    const apps = await this.listCallControlApps(c.apiKey);
    if (!apps.length) return c.connectionId || '';
    // already valid
    if (c.connectionId && apps.some((a) => String(a.id) === c.connectionId)) return c.connectionId;
    const id = this.pickCallControlApp(apps);
    if (id && id !== c.connectionId) await this.saveCreds(orgId, { connectionId: id }); // cache/repair
    return id || c.connectionId || '';
  }

  async saveCreds(orgId: string, patch: Partial<Creds>): Promise<Creds> {
    const existing = await this.rowFor(orgId);
    const cur = existing ? this.fromRow(existing) : { ...EMPTY };
    const next: Creds = { ...cur, ...patch };
    if (patch.apiKey && !cur.connectedAt) next.connectedAt = new Date().toISOString();

    const metadata = {
      publicKey: next.publicKey,
      connectionId: next.connectionId,
      messagingProfileId: next.messagingProfileId,
      fromNumber: next.fromNumber,
    };
    const data = {
      status: STATUS,
      integration_type: TYPE,
      external_account_id: next.assistantId || null,
      credentials_secret_ref: this.cipher.encrypt(next.apiKey || ''),
      metadata,
      updated_at: new Date(),
    };

    if (existing) await this.prisma.integrations.update({ where: { id: existing.id }, data });
    else await this.prisma.integrations.create({ data: { organization_id: orgId, provider: PROVIDER, ...data } });
    return next;
  }

  /**
   * Soft-disconnect: keep the row (and its assistant/number/encrypted key) and
   * just flip the status to 'inactive'. Reconnecting is then a flip back.
   */
  async clearCreds(orgId: string): Promise<void> {
    await this.prisma.integrations.updateMany({
      where: { organization_id: orgId, provider: PROVIDER },
      data: { status: 'inactive', updated_at: new Date() },
    });
  }

  async isConnected(orgId: string): Promise<boolean> {
    const c = await this.getCreds(orgId);
    return !!(c && c.apiKey);
  }

  async publicStatus(orgId: string): Promise<TelnyxPublicStatus> {
    // Read the raw row so a disconnected-but-present integration reports
    // connected:false rather than looking like it was never set up.
    const r = await this.rowFor(orgId);
    const active = this.isActive(r);
    const c = r ? this.fromRow(r) : null;
    const mask = (k: string): string => (k ? `${k.slice(0, 6)}…${k.slice(-4)}` : '');
    return {
      connected: !!(c && c.apiKey && active),
      hasAssistant: !!(c && c.assistantId && active),
      hasIntegration: !!r, // a row exists (active or inactive)
      status: r ? (r.status ?? 'active') : 'none',
      apiKeyMasked: c && active ? mask(c.apiKey) : '',
      connectionId: c ? c.connectionId : '',
      messagingProfileId: c ? c.messagingProfileId : '',
      hasMessaging: !!(c && active && c.messagingProfileId), // SMS ready (profile resolved)
      fromNumber: c ? c.fromNumber : '',
      assistantId: c && active ? c.assistantId : '',
      connectedAt: c ? c.connectedAt : null,
    };
  }

  /** A reconnect that reuses the stored (encrypted) key — re-activates the row. */
  async reconnect(orgId: string): Promise<void> {
    await this.prisma.integrations.updateMany({
      where: { organization_id: orgId, provider: PROVIDER },
      data: { status: 'active', updated_at: new Date() },
    });
  }
}
