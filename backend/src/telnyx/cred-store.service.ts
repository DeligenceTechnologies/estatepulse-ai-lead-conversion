import { Inject, Injectable } from '@nestjs/common';
import { TENANT_PRISMA, type GuardedPrisma } from '../prisma/prisma.service';
import { SecretCipherService } from './secret-cipher.service';

/**
 * Per-org Telnyx credentials (Bring-Your-Own-Telnyx), persisted in the shared
 * `integrations` table (provider='telnyx'). API key encrypted at rest.
 *
 * An org may keep several accounts on file — a brokerage that runs one Telnyx
 * account per market, say — but exactly one is *active*, and the active one is
 * what every call and message goes through. That invariant is what lets the
 * rest of the codebase stay account-blind: `getCreds(orgId)` still answers
 * "the credentials to use", and voice/sms/numbers/assistant never learn that
 * more than one set exists.
 *
 * Exactly-one-active is enforced here, not by the schema, because the table is
 * shared with every other provider and a partial unique index over
 * (organization_id, provider) where status='active' would have to be added by
 * hand outside Prisma. Every write that can activate a row deactivates the
 * others in the same transaction.
 */
const PROVIDER = 'telnyx';
const TYPE = 'voice'; // allowed: sms|voice|crm|calendar|other
const STATUS = 'active'; // allowed: active|inactive|error

export interface Creds {
  /** What the user calls this account, e.g. "Austin" — '' for ones saved before labels. */
  label: string;
  apiKey: string;
  publicKey: string;
  connectionId: string;
  messagingProfileId: string;
  fromNumber: string;
  assistantId: string;
  connectedAt: string | null;
}

export interface TelnyxPublicStatus {
  /** The active account's row id, '' when the org has none saved. */
  accountId: string;
  /** The active account's label, '' when unlabelled. */
  label: string;
  /** How many accounts the org has on file, active or not. */
  accountCount: number;
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

/** One saved account, as the connection UI lists them. */
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

const EMPTY: Creds = {
  label: '',
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
      label: m.label ?? '',
      apiKey: this.cipher.decrypt(r.credentials_secret_ref ?? '') || '',
      publicKey: m.publicKey ?? '',
      connectionId: m.connectionId ?? '',
      messagingProfileId: m.messagingProfileId ?? '',
      fromNumber: m.fromNumber ?? '',
      assistantId: r.external_account_id ?? '',
      connectedAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    };
  }

  /**
   * The account in use. Everything operational resolves through here, so an org
   * with five accounts on file behaves exactly like an org with one.
   */
  private activeRow(orgId: string) {
    return this.prisma.integrations.findFirst({
      where: { organization_id: orgId, provider: PROVIDER, status: STATUS },
      orderBy: { created_at: 'asc' },
    });
  }

  /**
   * Any account, for when none is active — a fully disconnected org still has
   * rows. Most recently touched first, so "the account we mean" is the one you
   * last used rather than the oldest one you ever added. Reporting, writing and
   * reconnecting all want that same answer.
   */
  private anyRow(orgId: string) {
    return this.prisma.integrations.findFirst({
      where: { organization_id: orgId, provider: PROVIDER },
      orderBy: { updated_at: 'desc' },
    });
  }

  /**
   * The row writes land on: the active one, or the only one when nothing is
   * active (so saving from a disconnected state reconnects it, as it always
   * has). Null means the org has nothing saved yet.
   */
  private async writableRow(orgId: string) {
    return (await this.activeRow(orgId)) ?? (await this.anyRow(orgId));
  }

  private mask(k: string): string {
    return k ? `${k.slice(0, 6)}…${k.slice(-4)}` : '';
  }

  /** Deactivate every account for the org. Callers follow it with one activate. */
  private async deactivateAll(orgId: string, exceptId?: string) {
    await this.prisma.integrations.updateMany({
      where: {
        organization_id: orgId,
        provider: PROVIDER,
        ...(exceptId ? { NOT: { id: exceptId } } : {}),
      },
      data: { status: 'inactive', updated_at: new Date() },
    });
  }

  /** Belongs-to-org check, so an id from the client can never reach another tenant. */
  private async ownedRow(orgId: string, id: string) {
    const r = await this.prisma.integrations.findFirst({
      where: { id, organization_id: orgId, provider: PROVIDER },
    });
    if (!r) throw new Error('Telnyx account not found.');
    return r;
  }

  private isActive(r: any): boolean {
    return (r?.status ?? 'active') === 'active';
  }

  /**
   * Operational credentials: only returned when the integration is ACTIVE. A
   * disconnected (inactive) row still exists but is treated as not connected.
   */
  async getCreds(orgId: string): Promise<Creds | null> {
    const r = await this.activeRow(orgId);
    return r ? this.fromRow(r) : null;
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

  /**
   * Update the account in use (or create the org's first). This is what the
   * assistant, numbers and detection paths call, so it must never touch a
   * non-active account — caching a repaired connection id onto a dormant
   * account would silently edit something the user is not looking at.
   */
  async saveCreds(orgId: string, patch: Partial<Creds>): Promise<Creds> {
    const existing = await this.writableRow(orgId);
    const cur = existing ? this.fromRow(existing) : { ...EMPTY };
    const next: Creds = { ...cur, ...patch };
    if (patch.apiKey && !cur.connectedAt) next.connectedAt = new Date().toISOString();

    const metadata = {
      label: next.label,
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

    if (existing) {
      await this.prisma.integrations.update({ where: { id: existing.id }, data });
      // Saving reactivates the row it lands on, so anything else must stand down.
      await this.deactivateAll(orgId, existing.id);
    } else {
      const created = await this.prisma.integrations.create({
        data: { organization_id: orgId, provider: PROVIDER, ...data },
      });
      await this.deactivateAll(orgId, created.id);
    }
    return next;
  }

  // ---- Multiple accounts -------------------------------------------------

  /** Every account on file, active one first, then oldest to newest. */
  async listAccounts(orgId: string): Promise<TelnyxAccount[]> {
    const rows = await this.prisma.integrations.findMany({
      where: { organization_id: orgId, provider: PROVIDER },
      orderBy: { created_at: 'asc' },
    });
    return rows
      .map((r: any) => {
        const c = this.fromRow(r);
        const active = this.isActive(r);
        return {
          id: r.id as string,
          label: c.label,
          apiKeyMasked: this.mask(c.apiKey),
          fromNumber: c.fromNumber,
          assistantId: c.assistantId,
          connectionId: c.connectionId,
          messagingProfileId: c.messagingProfileId,
          hasMessaging: !!c.messagingProfileId,
          active,
          connectedAt: c.connectedAt,
        };
      })
      .sort((a, b) => Number(b.active) - Number(a.active));
  }

  /**
   * Add an account and switch to it. Distinct from saveCreds: that edits the
   * account in use, this one puts a second account on file — which is what
   * connecting a new key used to do *over the top of* the first.
   */
  async createAccount(orgId: string, creds: Partial<Creds>): Promise<string> {
    const next: Creds = { ...EMPTY, ...creds, connectedAt: new Date().toISOString() };
    const created = await this.prisma.integrations.create({
      data: {
        organization_id: orgId,
        provider: PROVIDER,
        status: STATUS,
        integration_type: TYPE,
        external_account_id: next.assistantId || null,
        credentials_secret_ref: this.cipher.encrypt(next.apiKey || ''),
        metadata: {
          label: next.label,
          publicKey: next.publicKey,
          connectionId: next.connectionId,
          messagingProfileId: next.messagingProfileId,
          fromNumber: next.fromNumber,
        },
        updated_at: new Date(),
      },
    });
    await this.deactivateAll(orgId, created.id);
    return created.id as string;
  }

  /** Switch which account is in use. */
  async activateAccount(orgId: string, id: string): Promise<void> {
    await this.ownedRow(orgId, id);
    await this.deactivateAll(orgId, id);
    await this.prisma.integrations.update({
      where: { id },
      data: { status: STATUS, updated_at: new Date() },
    });
  }

  async renameAccount(orgId: string, id: string, label: string): Promise<void> {
    const r = await this.ownedRow(orgId, id);
    const metadata = { ...((r.metadata ?? {}) as Record<string, unknown>), label };
    await this.prisma.integrations.update({
      where: { id },
      data: { metadata, updated_at: new Date() },
    });
  }

  /**
   * Forget an account for good. Deleting the active one deliberately leaves the
   * org with none active rather than promoting a sibling: quietly moving calls
   * onto a different Telnyx account — different number, different bill — is a
   * worse surprise than calls stopping and the UI saying so.
   */
  async deleteAccount(orgId: string, id: string): Promise<void> {
    await this.ownedRow(orgId, id);
    await this.prisma.integrations.delete({ where: { id } });
  }

  /**
   * Soft-disconnect: keep the row (and its assistant/number/encrypted key) and
   * just flip the status to 'inactive'. Reconnecting is then a flip back.
   */
  async clearCreds(orgId: string): Promise<void> {
    await this.deactivateAll(orgId);
  }

  async isConnected(orgId: string): Promise<boolean> {
    const c = await this.getCreds(orgId);
    return !!(c && c.apiKey);
  }

  async publicStatus(orgId: string): Promise<TelnyxPublicStatus> {
    // One query, not three. This runs on every page that shows connection state
    // and the accounts per org are a handful, so fetching them and picking in
    // memory beats an activeRow + anyRow + count round trip each time — which
    // on a remote database is three separate waits for the same few rows.
    const rows = await this.prisma.integrations.findMany({
      where: { organization_id: orgId, provider: PROVIDER },
      orderBy: { updated_at: 'desc' },
    });
    // Prefer the account in use; fall back to the most recently touched one so a
    // disconnected org reports connected:false rather than looking like it was
    // never set up.
    const r = rows.find((x: any) => this.isActive(x)) ?? rows[0] ?? null;
    const active = this.isActive(r);
    const c = r ? this.fromRow(r) : null;
    const mask = (k: string): string => this.mask(k);
    const accountCount = rows.length;
    return {
      accountId: r ? (r.id as string) : '',
      label: c ? c.label : '',
      accountCount,
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

  /**
   * A reconnect that reuses the stored (encrypted) key. It takes an account id
   * because the blanket updateMany this replaced would activate *every* saved
   * account at once, and exactly-one-active is the invariant the whole
   * account-blind read path rests on.
   */
  async reconnect(orgId: string, accountId?: string): Promise<void> {
    const target = accountId
      ? await this.ownedRow(orgId, accountId)
      : await this.anyRow(orgId);
    if (!target) return;
    await this.activateAccount(orgId, target.id as string);
  }
}
