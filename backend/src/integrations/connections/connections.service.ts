import { randomBytes } from 'node:crypto';
import { ConflictException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConnectionMethod, Prisma, type IntegrationConnection, type IntegrationConnectionStatus } from '@prisma/client';
import type { ApiPublicConnectionFull } from '@nangohq/node';
import { AuditService } from '@/audit/audit.service';
import type { AuthContext } from '@/auth/auth.types';
import { AppError, httpError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { AdapterRegistry } from '../adapters/adapter.registry';
import type { AccountIdentity, AdapterContext, IntegrationAdapter, SetupResource } from '../adapters/adapter.interface';
import { ProviderClient } from '../adapters/provider-client';
import type { ConnectSessionView, ConnectionView } from '../integrations.types';
import { NangoError, NangoService, type SessionOwner } from '../nango/nango.service';
import { ProviderNotReadyError, ProvidersService } from '../providers/providers.service';
import { SyncService, runView } from '../sync/sync.service';
import { WriteBackService } from '../sync/write-back.service';

export interface ConnectionFilter {
  provider?: string;
  status?: IntegrationConnectionStatus;
  includeDisconnected?: boolean;
}

/** Where a link request came from: the browser (after Connect UI) or a verified Nango webhook. */
type LinkOrigin = { kind: 'browser'; auth: AuthContext } | { kind: 'webhook' };

const CONNECTION_INCLUDE = {
  leadSource: { select: { id: true, name: true } },
  syncRuns: { orderBy: { queuedAt: 'desc' }, take: 1 },
} as const satisfies Prisma.IntegrationConnectionInclude;

type ConnectionRow = Prisma.IntegrationConnectionGetPayload<{ include: typeof CONNECTION_INCLUDE }>;

/**
 * The organization's connected accounts. Every read and write is scoped by the
 * organization from the signed-in session; an id from the browser is only ever
 * looked up together with that organization, so another tenant's connection is
 * simply "not found".
 *
 * A connection is linked only after Nango confirms it AND its tags (written by
 * this server when it created the session) name the caller's organization. A
 * connection id sent by a browser is never trusted on its own.
 */
@Injectable()
export class ConnectionsService {
  private readonly logger = new Logger(ConnectionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly nango: NangoService,
    private readonly providers: ProvidersService,
    private readonly adapters: AdapterRegistry,
    private readonly sync: SyncService,
    private readonly audit: AuditService,
    private readonly writeBack: WriteBackService,
  ) {}

  // ---------------------------------------------------------------------------
  // Connect
  // ---------------------------------------------------------------------------

  /** A Nango Connect session for a NEW account of `providerId`. Existing accounts are untouched. */
  async startConnect(auth: AuthContext, providerId: string): Promise<ConnectSessionView> {
    let integrationKey: string;
    try {
      ({ integration: { unique_key: integrationKey } } = await this.providers.connectable(providerId));
    } catch (error) {
      if (error instanceof ProviderNotReadyError) {
        throw httpError(error.readiness === 'unsupported' ? 422 : 503, error.readiness === 'unsupported' ? 'INTEGRATION_UNSUPPORTED' : 'INTEGRATION_NOT_CONFIGURED', error.message);
      }
      throw error;
    }
    const session = await this.nango.createSession(integrationKey, await this.owner(auth));
    this.audit.quietly({
      orgId: auth.organizationId,
      actorType: 'user',
      actorId: auth.userId,
      action: 'integration.connect_started',
      entityType: 'integration_provider',
      payload: { provider: providerId, providerConfigKey: integrationKey },
    });
    return { ...session, providerConfigKey: integrationKey, ...this.nango.connectUi };
  }

  /** A session that re-authorizes one existing account in place (same Nango connection id). */
  async startReconnect(auth: AuthContext, id: string): Promise<ConnectSessionView> {
    const connection = await this.owned(auth.organizationId, id);
    if (connection.status === 'disconnected') throw new ConflictException('This account was disconnected. Connect it again as a new account.');
    const session = await this.nango.createReconnectSession(connection.providerConfigKey, connection.nangoConnectionId, await this.owner(auth));
    return { ...session, providerConfigKey: connection.providerConfigKey, ...this.nango.connectUi };
  }

  /**
   * Links the connection Nango's Connect UI just reported. Idempotent: the
   * browser and the `creation` webhook may both arrive, in either order.
   */
  async confirm(auth: AuthContext, providerConfigKey: string, nangoConnectionId: string): Promise<ConnectionView> {
    const row = await this.link(providerConfigKey, nangoConnectionId, { kind: 'browser', auth });
    return this.view(row);
  }

  /** From a verified `auth` webhook (creation / override): same linking, organization from the tags. */
  async linkFromWebhook(providerConfigKey: string, nangoConnectionId: string): Promise<void> {
    await this.link(providerConfigKey, nangoConnectionId, { kind: 'webhook' });
  }

  private async link(providerConfigKey: string, nangoConnectionId: string, origin: LinkOrigin): Promise<ConnectionRow> {
    const known = await this.providers.integrationByKey(providerConfigKey);
    if (!known) throw new NotFoundException('That integration is not available.');
    const { adapter } = known;

    let remote: ApiPublicConnectionFull;
    try {
      remote = await this.nango.getConnection(providerConfigKey, nangoConnectionId);
    } catch (error) {
      if (error instanceof NangoError && (error.kind === 'REAUTH' || error.kind === 'REJECTED')) {
        throw new NotFoundException('That connection was not found. Start the connection again.');
      }
      throw this.nango.toHttp(error, adapter.displayName);
    }

    const owner = this.nango.ownerOf(remote);
    const orgId = origin.kind === 'browser' ? origin.auth.organizationId : owner.organizationId;
    if (!orgId || owner.organizationId !== orgId || remote.provider_config_key !== providerConfigKey) {
      this.logger.warn(`Refused to link ${providerConfigKey} connection ${nangoConnectionId}: not tagged for organization ${orgId ?? '(none)'}`);
      throw new NotFoundException('That connection was not found. Start the connection again.');
    }
    const actorId = origin.kind === 'browser' ? origin.auth.userId : owner.userId;

    const existing = await this.prisma.integrationConnection.findUnique({ where: { nangoConnectionId } });
    if (existing && existing.orgId !== orgId) {
      // Cannot happen with server-written tags; refuse loudly rather than move a row between tenants.
      this.logger.error(`Connection ${nangoConnectionId} belongs to organization ${existing.orgId}, not ${orgId}`);
      throw new NotFoundException('That connection was not found.');
    }

    const ctx = this.context({ id: existing?.id ?? 'new', orgId, providerConfigKey, nangoConnectionId, settings: existing?.settings ?? {} });
    const identity = await this.identify(adapter, ctx);

    const accountData = {
      accountName: identity.accountName?.slice(0, 255) ?? null,
      accountEmail: identity.accountEmail?.slice(0, 255) ?? null,
      externalAccountId: identity.externalAccountId?.slice(0, 255) ?? null,
      metadata: (identity.metadata ?? {}) as Prisma.InputJsonValue,
    };

    if (existing) {
      // A reconnect (override) or a repeat confirm: the grant works again.
      const wasBroken = existing.status !== 'connected';
      const row = await this.prisma.integrationConnection.update({
        where: { id: existing.id },
        data: {
          ...accountData,
          status: 'connected',
          disconnectedAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          lastErrorAt: null,
          // A reconnect is how an owner grants the write scope: a paused write-back resumes.
          writeBackError: null,
          writeBackErrorAt: null,
        },
        include: CONNECTION_INCLUDE,
      });
      // Reconnected, or the same grant confirmed again: whatever the adapter fed (the calendar) resumes.
      await this.lifecycle(row, 'accessRestored');
      if (wasBroken) {
        this.audit.quietly({
          orgId,
          actorType: actorId ? 'user' : 'webhook',
          actorId,
          action: 'integration.reconnected',
          entityType: 'integration_connection',
          entityId: row.id,
          payload: { provider: adapter.provider },
        });
      }
      return row;
    }

    let row: ConnectionRow;
    try {
      row = await this.prisma.$transaction(async (tx) => {
        const leadSourceId = adapter.import ? await this.createLeadSource(tx, orgId, adapter, accountData.accountName) : null;
        const created = await tx.integrationConnection.create({
          data: {
            orgId,
            provider: adapter.provider,
            providerConfigKey,
            nangoConnectionId,
            status: 'connected',
            ...accountData,
            leadSourceId,
            connectedById: actorId,
            // Two-way from the start where the provider supports it; a grant without write access pauses it with the reason.
            writeBackEnabled: Boolean(adapter.writeBack),
          },
          include: CONNECTION_INCLUDE,
        });
        await this.audit.record(
          {
            orgId,
            actorType: actorId ? 'user' : 'webhook',
            actorId,
            action: 'integration.connected',
            entityType: 'integration_connection',
            entityId: created.id,
            payload: { provider: adapter.provider, providerConfigKey, account: accountData.accountName },
          },
          tx,
        );
        return created;
      });
    } catch (error) {
      // The webhook and the browser raced: the other one created it first.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = await this.prisma.integrationConnection.findUnique({ where: { nangoConnectionId }, include: CONNECTION_INCLUDE });
        if (raced && raced.orgId === orgId) return raced;
      }
      throw error;
    }

    // A provider whose setup is optional (HubSpot) starts importing right away.
    if (adapter.import && (!adapter.setup || adapter.setup.state({}).complete)) await this.queueQuietly(orgId, row.id, 'connected', actorId);
    return row;
  }

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  async list(orgId: string, filter: ConnectionFilter): Promise<ConnectionView[]> {
    const rows = await this.prisma.integrationConnection.findMany({
      where: {
        orgId,
        ...(filter.provider ? { provider: filter.provider } : {}),
        ...(filter.status ? { status: filter.status } : filter.includeDisconnected ? {} : { status: { not: 'disconnected' } }),
      },
      orderBy: [{ provider: 'asc' }, { createdAt: 'asc' }],
      include: CONNECTION_INCLUDE,
    });
    return Promise.all(rows.map((r) => this.view(r)));
  }

  async get(orgId: string, id: string): Promise<ConnectionView> {
    const row = await this.prisma.integrationConnection.findFirst({ where: { id, orgId }, include: CONNECTION_INCLUDE });
    if (!row) throw new NotFoundException('That connection was not found.');
    return this.view(row);
  }

  // ---------------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------------

  async listResources(orgId: string, id: string, kind: string, parentId: string | null): Promise<SetupResource[]> {
    const connection = await this.usable(orgId, id);
    const adapter = this.adapterOf(connection);
    if (!adapter.setup || !adapter.setup.resourceKinds.includes(kind)) {
      throw new AppError('VALIDATION_ERROR', `${adapter.displayName} has no "${kind}" to choose from.`);
    }
    return this.callProvider(connection, adapter, () => adapter.setup!.listResources(this.context(connection), kind, parentId));
  }

  async updateSettings(auth: AuthContext, id: string, input: Record<string, unknown>): Promise<ConnectionView> {
    const connection = await this.usable(auth.organizationId, id);
    const adapter = this.adapterOf(connection);
    if (!adapter.setup) throw new AppError('VALIDATION_ERROR', `${adapter.displayName} has nothing to set up.`);
    const settings = await this.callProvider(connection, adapter, () => adapter.setup!.saveSettings(this.context(connection, auth.userId), input));
    const sourceName = adapter.import?.sourceName(settings);

    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.integrationConnection.update({
        where: { id: connection.id },
        data: { settings: settings as Prisma.InputJsonValue },
        include: CONNECTION_INCLUDE,
      });
      if (sourceName && updated.leadSourceId) {
        await tx.leadSource.update({ where: { id: updated.leadSourceId }, data: { name: sourceName.slice(0, 100) } });
      }
      await this.audit.record(
        {
          orgId: auth.organizationId,
          actorType: 'user',
          actorId: auth.userId,
          action: 'integration.settings_updated',
          entityType: 'integration_connection',
          entityId: connection.id,
          payload: { provider: adapter.provider, summary: adapter.setup!.state(settings).summary },
        },
        tx,
      );
      return updated;
    });

    // Setup just became complete: import now rather than waiting for a click.
    if (adapter.import && adapter.setup.state(settings).complete) await this.queueQuietly(auth.organizationId, row.id, 'manual', auth.userId);
    return this.get(auth.organizationId, row.id);
  }

  // ---------------------------------------------------------------------------
  // Disconnect
  // ---------------------------------------------------------------------------

  /**
   * Removes the account: Nango deletes the grant (and revokes it where the
   * provider supports that), the row is kept as `disconnected` for history,
   * queued syncs are cancelled and the lead source archived. Leads stay.
   */
  async disconnect(auth: AuthContext, id: string): Promise<ConnectionView> {
    const connection = await this.owned(auth.organizationId, id);
    if (connection.status === 'disconnected') return this.get(auth.organizationId, id);
    await this.lifecycle(connection, 'beforeDisconnect');
    try {
      await this.nango.deleteConnection(connection.providerConfigKey, connection.nangoConnectionId);
    } catch (error) {
      // Not deleted at Nango = the grant still works. Say so instead of pretending.
      throw this.nango.toHttp(error, this.adapters.get(connection.provider)?.displayName ?? connection.provider);
    }

    await this.sync.cancelActive(connection.id, 'The account was disconnected.');
    await this.prisma.$transaction(async (tx) => {
      await tx.integrationConnection.update({
        where: { id: connection.id },
        data: { status: 'disconnected', disconnectedAt: new Date() },
      });
      if (connection.leadSourceId) {
        await tx.leadSource.update({ where: { id: connection.leadSourceId }, data: { isActive: false, archivedAt: new Date() } });
      }
      await this.audit.record(
        {
          orgId: auth.organizationId,
          actorType: 'user',
          actorId: auth.userId,
          action: 'integration.disconnected',
          entityType: 'integration_connection',
          entityId: connection.id,
          payload: { provider: connection.provider, account: connection.accountName },
        },
        tx,
      );
    });
    await this.lifecycle(connection, 'disconnected');
    return this.get(auth.organizationId, id);
  }

  // ---------------------------------------------------------------------------
  // Webhook-driven state
  // ---------------------------------------------------------------------------

  /** Nango could not refresh the grant, or it was deleted in the dashboard. */
  async markReauthRequired(nangoConnectionId: string, reason: string): Promise<void> {
    const updated = await this.prisma.integrationConnection.updateMany({
      where: { nangoConnectionId, status: { in: ['connected', 'error'] } },
      data: { status: 'reauth_required', lastErrorCode: 'REAUTH_REQUIRED', lastErrorMessage: reason.slice(0, 500), lastErrorAt: new Date() },
    });
    if (updated.count) {
      const row = await this.prisma.integrationConnection.findUnique({
        where: { nangoConnectionId },
        select: { id: true, orgId: true, provider: true, providerConfigKey: true, nangoConnectionId: true, settings: true },
      });
      if (row) {
        await this.lifecycle(row, 'accessLost', reason);
        this.audit.quietly({
          orgId: row.orgId,
          actorType: 'webhook',
          action: 'integration.reauth_required',
          entityType: 'integration_connection',
          entityId: row.id,
          payload: { provider: row.provider },
        });
      }
    }
  }

  /** A refresh succeeded after a failure: the account works again. */
  async markHealthy(nangoConnectionId: string): Promise<void> {
    const healed = await this.prisma.integrationConnection.updateMany({
      where: { nangoConnectionId, status: { in: ['reauth_required', 'error'] } },
      data: { status: 'connected', lastErrorCode: null, lastErrorMessage: null, lastErrorAt: null },
    });
    if (!healed.count) return;
    const row = await this.prisma.integrationConnection.findUnique({ where: { nangoConnectionId } });
    if (row) await this.lifecycle(row, 'accessRestored');
  }

  /** Deleted in Nango (dashboard or API) without going through EstatePulse. */
  async markDeletedRemotely(nangoConnectionId: string): Promise<void> {
    const row = await this.prisma.integrationConnection.findUnique({ where: { nangoConnectionId } });
    if (!row || row.status === 'disconnected') return;
    await this.markReauthRequired(nangoConnectionId, 'This account was removed from Nango. Reconnect it, or disconnect it here.');
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async view(row: ConnectionRow): Promise<ConnectionView> {
    const adapter = this.adapters.get(row.provider);
    const settings = (row.settings ?? {}) as Record<string, unknown>;
    const { name } = await this.providers.displayOf(row.provider);
    const latest = row.syncRuns[0] ?? null;
    return {
      id: row.id,
      provider: row.provider,
      providerName: name,
      providerConfigKey: row.providerConfigKey,
      status: row.status,
      accountName: row.accountName,
      accountEmail: row.accountEmail,
      externalAccountId: row.externalAccountId,
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      setup: adapter?.setup ? adapter.setup.state(settings) : null,
      settings,
      canSync: this.sync.blocker(row) === null,
      lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
      lastError: row.lastErrorCode || row.lastErrorMessage
        ? { code: row.lastErrorCode, message: row.lastErrorMessage, at: row.lastErrorAt?.toISOString() ?? null }
        : null,
      latestRun: latest ? runView(latest) : null,
      leadSource: row.leadSource,
      twoWay: await this.writeBack.view(row),
      connectedAt: row.createdAt.toISOString(),
      disconnectedAt: row.disconnectedAt?.toISOString() ?? null,
    };
  }

  private async owned(orgId: string, id: string): Promise<IntegrationConnection> {
    const row = await this.prisma.integrationConnection.findFirst({ where: { id, orgId } });
    if (!row) throw new NotFoundException('That connection was not found.');
    return row;
  }

  /** Owned AND able to call the provider now. */
  private async usable(orgId: string, id: string): Promise<IntegrationConnection> {
    const row = await this.owned(orgId, id);
    if (row.status === 'disconnected') throw new ConflictException('This account was disconnected.');
    if (row.status === 'reauth_required') throw httpError(409, 'INTEGRATION_REAUTH_REQUIRED', 'Reconnect this account to continue.');
    return row;
  }

  private adapterOf(row: { provider: string }): IntegrationAdapter {
    const adapter = this.adapters.get(row.provider);
    if (!adapter) throw new ConflictException('EstatePulse no longer supports this integration.');
    return adapter;
  }

  private context(
    row: Pick<IntegrationConnection, 'id' | 'orgId' | 'providerConfigKey' | 'nangoConnectionId'> & { settings: unknown },
    actorId: string | null = null,
  ): AdapterContext {
    return {
      connectionId: row.id,
      orgId: row.orgId,
      settings: (row.settings ?? {}) as Record<string, unknown>,
      client: new ProviderClient(this.nango, row.providerConfigKey, row.nangoConnectionId),
      actorId,
    };
  }

  /** Runs an adapter lifecycle hook. Best effort: logged, never thrown, never undoes the change that triggered it. */
  private async lifecycle(
    row: Pick<IntegrationConnection, 'id' | 'orgId' | 'provider' | 'providerConfigKey' | 'nangoConnectionId'> & { settings: unknown },
    hook: keyof NonNullable<IntegrationAdapter['lifecycle']>,
    reason = '',
  ): Promise<void> {
    const run = this.adapters.get(row.provider)?.lifecycle?.[hook];
    if (!run) return;
    try {
      await run(this.context(row), reason);
    } catch (error) {
      this.logger.warn(`${row.provider} ${hook} hook failed for connection ${row.id}: ${(error as Error).message}`);
    }
  }

  /** A provider call on behalf of a request: a dead grant parks the connection; errors become HTTP answers. */
  private async callProvider<T>(row: IntegrationConnection, adapter: IntegrationAdapter, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof NangoError && error.kind === 'REAUTH') {
        await this.markReauthRequired(row.nangoConnectionId, `${adapter.displayName} access was revoked or has expired. Reconnect to continue.`);
      }
      throw this.nango.toHttp(error, adapter.displayName);
    }
  }

  private async identify(adapter: IntegrationAdapter, ctx: AdapterContext): Promise<AccountIdentity> {
    try {
      return await adapter.identify(ctx);
    } catch (error) {
      if (error instanceof NangoError && error.kind === 'REAUTH') {
        throw httpError(409, 'INTEGRATION_REAUTH_REQUIRED', `${adapter.displayName} did not accept the new connection. Try connecting again.`);
      }
      // The account works but we could not read its name: link it anyway, unnamed.
      this.logger.warn(`Could not identify the ${adapter.provider} account: ${(error as Error).message}`);
      return { accountName: null, accountEmail: null, externalAccountId: null };
    }
  }

  private async createLeadSource(tx: Prisma.TransactionClient, orgId: string, adapter: IntegrationAdapter, account: string | null): Promise<string> {
    const name = `${adapter.displayName}${account ? ` · ${account}` : ''}`.slice(0, 100);
    // Unique per organization; random suffix because one org may connect many accounts of one provider.
    const code = `${adapter.provider}-${randomBytes(4).toString('hex')}`.slice(0, 50);
    const source = await tx.leadSource.create({
      data: {
        orgId,
        name,
        code,
        ...(adapter.leadSourceProvider ? { provider: adapter.leadSourceProvider } : {}),
        connectionMethod: ConnectionMethod.SYNC,
      },
      select: { id: true },
    });
    return source.id;
  }

  private async queueQuietly(orgId: string, connectionId: string, trigger: 'connected' | 'manual', userId: string | null): Promise<void> {
    try {
      await this.sync.enqueue(orgId, connectionId, trigger, userId);
    } catch (error) {
      // The connection is linked either way; the owner can press Sync.
      this.logger.warn(`Could not queue the first sync of ${connectionId}: ${(error as Error).message}`);
    }
  }

  private async owner(auth: AuthContext): Promise<SessionOwner> {
    const [user, org] = await Promise.all([
      this.prisma.user.findFirst({ where: { id: auth.userId, orgId: auth.organizationId }, select: { email: true, firstName: true, lastName: true } }),
      this.prisma.organization.findUnique({ where: { id: auth.organizationId }, select: { name: true } }),
    ]);
    return {
      organizationId: auth.organizationId,
      organizationName: org?.name ?? null,
      userId: auth.userId,
      email: user?.email ?? null,
      displayName: user ? `${user.firstName} ${user.lastName}`.trim() : null,
    };
  }
}
