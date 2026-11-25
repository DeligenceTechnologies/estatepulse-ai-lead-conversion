import { HttpException, Injectable, Logger } from '@nestjs/common';
import { IntegrationStatus, Prisma, type Integration, type IntegrationProvider } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AuditService } from '@/audit/audit.service';
import { EntitlementService } from '@/billing/entitlements/entitlement.service';
import { httpError } from '@/common/errors/app-error';
import { lockOrganization } from '@/common/prisma/lock-organization';
import { PrismaService } from '@/common/prisma/prisma.service';
import { ConnectionAlertService } from '@/common/service/connection-alert.service';
import { NANGO_INTEGRATIONS, type NangoIntegration } from '@/nango/nango.constants';
import { NangoConnectionRegistry } from '@/nango/nango-connection.registry';
import { NangoError, NangoService, type NangoSession } from '@/nango/nango.service';
import { ConnectionRefused, type ConnectionCategory, type ConnectionDefinition } from './connection-definition';

/** The code a connection is parked with when its credential stops working. */
export const REAUTH_REQUIRED = 'REAUTH_REQUIRED';

const TX_LIMITS = { maxWait: 10_000, timeout: 20_000 } as const;

export type ConnectionState = 'connected' | 'needs_setup' | 'broken';

export interface ConnectionView {
  id: string;
  provider: NangoIntegration;
  state: ConnectionState;
  label: string | null;
  accountEmail: string | null;
  accountName: string | null;
  preview: string | null;
  errorCode: string | null;
  connectedAt: Date;
  lastVerifiedAt: Date | null;
  details: Record<string, unknown>;
}

export interface ProviderView {
  key: NangoIntegration;
  label: string;
  description: string;
  category: ConnectionCategory;
  auth: 'oauth' | 'apiKey';
  multiple: boolean;
  /** Null when it can be connected; otherwise why not (server setting, plan). */
  unavailable: string | null;
  connections: ConnectionView[];
}

/** A row that can be used right now, with the Nango connection it reads its credential from. */
export type UsableRow = Integration & { nangoConnectionId: string };

/** How a provider client reports a refused credential, so `withCredential` can retry once and park. */
export interface CredentialErrors {
  /** The provider answered 401: try once more with a refreshed token. */
  unauthorized(error: unknown): boolean;
  /** The grant is dead or a scope is missing: park the connection. Returns the code to park it with, or null. */
  reauth(error: unknown): string | null;
  /** The error to throw when the connection must be reconnected. */
  reauthError(message: string): Error;
  /** The error to throw when Nango or the provider did not answer. */
  unavailableError(message: string, status: number): Error;
}

/**
 * The one connect flow for every provider (see ConnectionDefinition).
 *
 * The browser gets a Nango Connect session, the person signs in or enters a
 * key in Nango's window, and the browser reports back only the connection id.
 * `complete` checks with Nango that the connection is the caller's
 * organization's, reads the account, and writes one integrations row. If the
 * tab closes first, Nango's "creation" webhook finishes it from the queue.
 *
 * Provider code never sees a refresh token or stores a key: it asks this
 * service for the current credential when it calls the provider's API.
 */
@Injectable()
export class ConnectionsService {
  private readonly logger = new Logger('Connections');
  private readonly byKey = new Map<NangoIntegration, ConnectionDefinition>();
  private readonly byProvider = new Map<IntegrationProvider, ConnectionDefinition>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly nango: NangoService,
    private readonly registry: NangoConnectionRegistry,
    private readonly audit: AuditService,
    private readonly alerts: ConnectionAlertService,
    private readonly entitlements: EntitlementService,
  ) {}

  /** Called by each provider module on init. */
  register(def: ConnectionDefinition): void {
    this.byKey.set(def.key, def);
    this.byProvider.set(def.provider, def);
    this.registry.register(def.key, {
      reconcile: async ({ organizationId, userId, connectionId }) => {
        const linked = await this.prisma.integration.findFirst({
          where: { nangoConnectionId: connectionId, revokedAt: null, status: { not: IntegrationStatus.invalid } },
          select: { id: true },
        });
        if (linked) return;
        try {
          await this.complete(organizationId, userId, def.key, connectionId);
        } catch (error) {
          // A refusal is final (the connection was handed back); only an outage is worth Nango's retry.
          if (error instanceof HttpException && error.getStatus() < 500) {
            this.logger.warn(`${def.label} connection ${connectionId} was not finished: ${error.message}`);
            return;
          }
          throw error;
        }
      },
      refreshFailed: (connectionId) => this.breakByConnection(connectionId),
      deleted: (connectionId) => this.breakByConnection(connectionId),
      refreshRecovered: (connectionId) => this.recoverByConnection(connectionId),
    });
  }

  definition(key: string): ConnectionDefinition {
    const def = this.byKey.get(key as NangoIntegration);
    if (!def) throw httpError(404, 'PROVIDER_UNKNOWN', `There is no integration called "${key}".`);
    return def;
  }

  // --- catalog -----------------------------------------------------------------

  /** Every provider, what is connected to each, and whether more can be. */
  async catalog(orgId: string): Promise<ProviderView[]> {
    const rows = await this.prisma.integration.findMany({
      where: { orgId, revokedAt: null, provider: { in: [...this.byProvider.keys()] } },
      orderBy: { createdAt: 'asc' },
    });
    const defs = [...this.byKey.values()];
    const [locked, missing] = await Promise.all([
      Promise.all(defs.map((def) => (def.feature ? this.entitlements.hasFeature(orgId, def.feature) : true))),
      Promise.all(defs.map((def) => (this.nango.configured ? this.nango.missingInDashboard(def.key) : null))),
    ]);
    return defs.map((def, i) => ({
      key: def.key,
      label: def.label,
      description: def.description,
      category: def.category,
      auth: def.auth,
      multiple: Boolean(def.multiple),
      unavailable:
        this.unavailable(def) ?? missing[i] ?? (locked[i] ? null : `${def.label} is not included in your plan. Upgrade to connect it.`),
      connections: rows.filter((row) => row.provider === def.provider).map((row) => this.view(row)),
    }));
  }

  view(row: Integration): ConnectionView {
    const def = this.byProvider.get(row.provider);
    return {
      id: row.id,
      provider: def?.key ?? (row.provider as NangoIntegration),
      state: stateOf(row),
      label: row.label,
      accountEmail: row.accountEmail,
      accountName: row.accountName,
      preview: row.credentialPreview,
      errorCode: row.lastErrorCode,
      connectedAt: row.createdAt,
      lastVerifiedAt: row.lastVerifiedAt,
      details: def?.view?.(row) ?? {},
    };
  }

  // --- connecting --------------------------------------------------------------

  /**
   * A Nango Connect session for one provider, tagged with the caller's
   * organization. With `reconnectId` it re-authorizes that row's connection in
   * place (same connection id), which is how a broken one is repaired.
   */
  async session(orgId: string, userId: string, key: string, reconnectId?: string | null): Promise<NangoSession> {
    const def = this.definition(key);
    await this.assertAvailable(def, orgId);
    let reconnect: string | null = null;
    if (reconnectId) {
      const row = await this.prisma.integration.findFirst({ where: { id: reconnectId, orgId, provider: def.provider, revokedAt: null } });
      if (!row) throw httpError(404, 'CONNECTION_NOT_FOUND', `That ${def.label} connection does not exist.`);
      reconnect = row.nangoConnectionId;
    }
    return this.nango.createSession(def.key, { organizationId: orgId, userId }, reconnect);
  }

  /**
   * Links the Nango connection the browser just finished. Idempotent: the
   * webhook may finish the same connection too, and the second run changes nothing.
   */
  async complete(orgId: string, userId: string | null, key: string, connectionId: string): Promise<ConnectionView> {
    const def = this.definition(key);
    await this.assertAvailable(def, orgId);
    const owned = await this.nango.ownedConnection(def.key, connectionId, orgId);
    // The person who started may have left the organization since.
    const member = userId ? await this.prisma.user.findFirst({ where: { id: userId, orgId }, select: { id: true } }) : null;
    const actorId = member?.id ?? null;

    const linked = await this.prisma.integration.findFirst({ where: { nangoConnectionId: connectionId, revokedAt: null } });
    if (linked && linked.status !== IntegrationStatus.invalid) return this.view(linked);

    let credential: string;
    try {
      credential = await this.nango.accessToken(def.key, connectionId);
    } catch (error) {
      throw this.nango.toHttp(def.key, error);
    }
    // From here a live grant exists in Nango: any refusal hands it back, unless a row already uses it.
    const refuse = async (refusal: ConnectionRefused) => {
      if (!linked) {
        if (refusal.revokeAtProvider && def.revoke) await this.quietly(`revoke ${def.label}`, () => def.revoke!(credential, null));
        await this.nango.deleteQuietly(def.key, connectionId);
      }
      return httpError(refusal.status, refusal.code, refusal.message);
    };

    let account;
    try {
      account = await def.identify(credential, owned.raw);
    } catch (error) {
      if (error instanceof ConnectionRefused) throw await refuse(error);
      if (error instanceof HttpException) {
        await this.nango.deleteQuietly(def.key, connectionId);
        throw error;
      }
      this.logger.warn(`${def.label} identify failed: ${(error as Error).message}`);
      throw await refuse(new ConnectionRefused(502, 'ACCOUNT_UNREADABLE', `${def.label} did not say which account was connected. Try again.`));
    }

    let saved: { row: Integration; replaced: string | null };
    try {
      saved = await this.prisma.$transaction(async (tx) => {
        // Two tabs, or a tab and the webhook, finishing at once must not both pass the one-account check.
        await lockOrganization(tx, orgId);
        const live = await tx.integration.findMany({ where: { orgId, provider: def.provider, revokedAt: null } });
        const existing = live.find((row) => row.externalAccountId === account.accountId) ?? null;
        if (!def.multiple) {
          const other = live.find((row) => row.externalAccountId !== account.accountId);
          if (other) {
            throw new ConnectionRefused(
              409,
              'ACCOUNT_CONFLICT',
              `This organization is already connected to ${other.accountEmail ?? other.accountName ?? `another ${def.label} account`}. Disconnect it first to use a different account.`,
              true,
            );
          }
        }
        const replaced = existing?.nangoConnectionId && existing.nangoConnectionId !== connectionId ? existing.nangoConnectionId : null;
        const id = existing?.id ?? randomUUID();
        const config = { ...asObject(existing?.config), ...(account.config ?? {}) } as Prisma.InputJsonObject;
        const status = existing
          ? existing.status === IntegrationStatus.invalid
            ? IntegrationStatus.active
            : existing.status
          : def.needsSetup
            ? IntegrationStatus.inactive
            : IntegrationStatus.active;
        const data = {
          nangoConnectionId: connectionId,
          label: existing?.label ?? account.name ?? account.email ?? account.accountId,
          accountEmail: account.email ?? null,
          accountName: account.name ?? null,
          externalAccountId: account.accountId,
          credentialPreview: account.preview ?? (def.auth === 'oauth' ? 'oauth' : null),
          config,
          status,
          lastVerifiedAt: new Date(),
          lastErrorAt: null,
          lastErrorCode: null,
        };
        const row = existing
          ? await tx.integration.update({ where: { id }, data })
          : await tx.integration.create({ data: { id, orgId, provider: def.provider, ...data } });

        // Lead sources connected through this account before a disconnect come back with it.
        const retired = await tx.integration.findMany({
          where: { orgId, provider: def.provider, externalAccountId: account.accountId, revokedAt: { not: null } },
          select: { id: true },
        });
        const reattached = retired.length
          ? (await tx.leadSource.updateMany({ where: { orgId, integrationId: { in: retired.map((r) => r.id) } }, data: { integrationId: id } })).count
          : 0;

        const reconnected = Boolean(existing || retired.length);
        const extra = (await def.connected?.({ orgId, userId: actorId, row, account, reconnected, tx })) ?? {};
        await this.audit.record(
          {
            orgId,
            actorType: actorId ? 'user' : 'system',
            actorId: actorId ?? undefined,
            action: `${def.key}.${reconnected ? 'reconnected' : 'connected'}`,
            entityType: 'integration',
            entityId: id,
            payload: { accountId: account.accountId, account: account.email ?? account.name, reattached, ...account.audit, ...extra },
          },
          tx,
        );
        return { row, replaced };
      }, TX_LIMITS);
    } catch (error) {
      if (error instanceof ConnectionRefused) throw await refuse(error);
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // A partial unique index: this account is live in another organization. Which one is not said.
        throw await refuse(
          new ConnectionRefused(409, 'ACCOUNT_IN_USE', `This ${def.label} account is already connected to another EstatePulse organization. Disconnect it there first.`),
        );
      }
      throw error;
    }

    if (saved.replaced) await this.nango.deleteQuietly(def.key, saved.replaced);
    await def.afterConnected?.(saved.row, actorId);
    this.logger.log(`${def.label} connected for organization ${orgId} (${saved.row.id})`);
    return this.view(saved.row);
  }

  // --- disconnecting -----------------------------------------------------------

  /**
   * Stops using the account and deletes its credential from Nango, keeping the
   * data: lead sources and leads stay, and connecting the same account again
   * picks them back up.
   */
  async disconnect(orgId: string, userId: string, id: string, force = false): Promise<void> {
    const row = await this.prisma.integration.findFirst({ where: { id, orgId, revokedAt: null } });
    const def = row ? this.byProvider.get(row.provider) : undefined;
    if (!row || !def) throw httpError(404, 'CONNECTION_NOT_FOUND', 'That connection does not exist.');

    let credential: string | null = null;
    if (row.nangoConnectionId) {
      try {
        credential = await this.nango.accessToken(def.key, row.nangoConnectionId);
      } catch (error) {
        this.logger.warn(`${def.label} ${row.id}: no credential to clean up with: ${(error as Error).message}`);
      }
    }
    if (def.beforeDisconnect) await this.quietly(`${def.label} clean-up`, () => def.beforeDisconnect!(row, credential));

    try {
      await this.prisma.$transaction(async (tx) => {
        const extra = (await def.disconnecting?.({ orgId, userId, row, force, tx })) ?? {};
        await tx.integration.update({
          where: { id: row.id },
          data: { status: IntegrationStatus.revoked, revokedAt: new Date(), nangoConnectionId: null },
        });
        await this.audit.record(
          { orgId, actorType: 'user', actorId: userId, action: `${def.key}.disconnected`, entityType: 'integration', entityId: row.id, payload: { accountId: row.externalAccountId, ...extra } },
          tx,
        );
      }, TX_LIMITS);
    } catch (error) {
      if (error instanceof ConnectionRefused) throw httpError(error.status, error.code, error.message);
      throw error;
    }

    if (credential && def.revoke) await this.quietly(`revoke ${def.label}`, () => def.revoke!(credential!, row));
    if (row.nangoConnectionId) await this.nango.deleteQuietly(def.key, row.nangoConnectionId);
    this.logger.log(`${def.label} disconnected for organization ${orgId} (${row.id})`);
  }

  // --- using a connection ------------------------------------------------------

  /** A live row of this organization, or null. */
  find(orgId: string, id: string, key?: NangoIntegration): Promise<Integration | null> {
    if (!id) return Promise.resolve(null);
    const provider = key ? this.definition(key).provider : undefined;
    return this.prisma.integration.findFirst({ where: { id, orgId, revokedAt: null, ...(provider ? { provider } : {}) } });
  }

  /** The organization's live rows for one provider, oldest first. */
  rows(orgId: string, key: NangoIntegration): Promise<Integration[]> {
    return this.prisma.integration.findMany({
      where: { orgId, provider: this.definition(key).provider, revokedAt: null },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** The current credential (access token or API key) for a row. Throws NangoError. */
  async credential(row: Pick<Integration, 'id' | 'provider' | 'nangoConnectionId'>, forceRefresh = false): Promise<string> {
    const def = this.byProvider.get(row.provider);
    if (!def || !row.nangoConnectionId) throw new NangoError('REAUTH', 'This connection has no credential', 0);
    const credential = await this.nango.accessToken(def.key, row.nangoConnectionId, forceRefresh);
    void this.prisma.integration
      .updateMany({ where: { id: row.id, status: { not: IntegrationStatus.invalid } }, data: { lastVerifiedAt: new Date() } })
      .catch(() => undefined);
    return credential;
  }

  /**
   * Runs `fn` with a valid credential for this organization's row. A 401 asks
   * Nango for a fresh token and retries once; a second 401, a grant Nango can
   * no longer refresh, or a refused scope parks the connection and throws the
   * provider's reauth error, which no caller retries.
   */
  async withCredential<T>(orgId: string, id: string, key: NangoIntegration, errors: CredentialErrors, fn: (credential: string, row: Integration) => Promise<T>): Promise<T> {
    const label = this.definition(key).label;
    const row = await this.find(orgId, id, key);
    if (!row) throw errors.reauthError(`${label} was disconnected`);
    if (row.status === IntegrationStatus.invalid || !row.nangoConnectionId) throw errors.reauthError(`${label} needs to be reconnected`);

    const attempt = async (forceRefresh: boolean): Promise<T> => {
      let credential: string;
      try {
        credential = await this.credential(row, forceRefresh);
      } catch (error) {
        if (error instanceof NangoError && error.kind === 'REAUTH') {
          await this.markBroken(row.id, REAUTH_REQUIRED);
          throw errors.reauthError(error.message);
        }
        if (error instanceof NangoError) throw errors.unavailableError(error.message, error.status);
        throw error;
      }
      return fn(credential, row);
    };

    try {
      return await attempt(false);
    } catch (error) {
      const code = errors.reauth(error);
      if (code) await this.markBroken(row.id, code);
      if (!errors.unauthorized(error)) throw error;
    }
    try {
      return await attempt(true);
    } catch (error) {
      if (errors.unauthorized(error)) {
        await this.markBroken(row.id, REAUTH_REQUIRED);
        throw errors.reauthError(`${label} refused a freshly issued token`);
      }
      const code = errors.reauth(error);
      if (code) await this.markBroken(row.id, code);
      throw error;
    }
  }

  // --- broken and recovered ------------------------------------------------------

  /** Parks a working connection and emails the owners, once per break. */
  async markBroken(id: string, code: string = REAUTH_REQUIRED): Promise<void> {
    const brokenAt = new Date();
    const changed = await this.prisma.integration.updateMany({
      where: { id, status: { in: [IntegrationStatus.active, IntegrationStatus.inactive] }, revokedAt: null },
      data: { status: IntegrationStatus.invalid, lastErrorAt: brokenAt, lastErrorCode: code },
    });
    if (changed.count === 0) return;
    const row = await this.prisma.integration.findUnique({ where: { id } });
    const def = row ? this.byProvider.get(row.provider) : undefined;
    if (!row || !def) return;
    this.logger.warn(`${def.label} connection ${id} needs to be reconnected (${code})`);
    this.alerts.connectionBroken({
      orgId: row.orgId,
      connectionId: id,
      providerLabel: def.label,
      account: row.accountEmail ?? row.accountName,
      impact: def.impact,
      reconnectPath: '/integrations',
      brokenAt,
    });
    this.audit.quietly({ orgId: row.orgId, actorType: 'system', action: `${def.key}.reauthorization_required`, entityType: 'integration', entityId: id, payload: { code } });
    if (def.broken) await this.quietly(`${def.label} broken hook`, () => def.broken!(row));
  }

  private async breakByConnection(connectionId: string): Promise<void> {
    const row = await this.prisma.integration.findFirst({ where: { nangoConnectionId: connectionId, revokedAt: null }, select: { id: true } });
    if (row) await this.markBroken(row.id, REAUTH_REQUIRED);
  }

  /** A refresh that works again clears only what a refresh failure parked. */
  private async recoverByConnection(connectionId: string): Promise<void> {
    const row = await this.prisma.integration.findFirst({
      where: { nangoConnectionId: connectionId, revokedAt: null, status: IntegrationStatus.invalid, lastErrorCode: REAUTH_REQUIRED },
    });
    if (!row) return;
    const def = this.byProvider.get(row.provider);
    const status = def?.needsSetup && !asObject(row.config).setupDone ? IntegrationStatus.inactive : IntegrationStatus.active;
    await this.prisma.integration.update({ where: { id: row.id }, data: { status, lastErrorAt: null, lastErrorCode: null } });
    if (def?.recovered) await this.quietly(`${def.label} recovered hook`, () => def.recovered!(row));
  }

  // --- helpers -------------------------------------------------------------------

  private unavailable(def: ConnectionDefinition): string | null {
    if (!this.nango.configured) return `${def.label} cannot be connected on this server yet (Nango is not configured).`;
    return def.unavailable();
  }

  private async assertAvailable(def: ConnectionDefinition, orgId: string): Promise<void> {
    const reason = this.unavailable(def);
    if (reason) throw httpError(503, 'PROVIDER_UNAVAILABLE', reason);
    if (def.feature) await this.entitlements.assertFeature(orgId, def.feature);
  }

  private async quietly(what: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.logger.warn(`${what} failed: ${(error as Error).message}`);
    }
  }
}

function stateOf(row: Integration): ConnectionState {
  if (row.status === IntegrationStatus.invalid) return 'broken';
  if (row.status === IntegrationStatus.inactive && !asObject(row.config).setupDone) return 'needs_setup';
  return 'connected';
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Every integration key Nango knows, for validating route params. */
export const CONNECTION_KEYS = Object.keys(NANGO_INTEGRATIONS) as NangoIntegration[];
