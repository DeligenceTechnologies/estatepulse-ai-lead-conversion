import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { IntegrationProvider, type CalendarProvider, type CalendarWorkspaceType, type Integration, type Prisma } from '@prisma/client';
import { FEATURES } from '@/billing/billing-plans';
import { PrismaService } from '@/common/prisma/prisma.service';
import { SecretBoxService } from '@/common/service/secret-box.service';
import { ConnectionRefused } from '@/connections/connection-definition';
import { ConnectionsService } from '@/connections/connections.service';
import { PROVIDER_LABEL, type WorkspaceRole } from '../calendar.types';
import { CalClient } from '../providers/cal.client';
import { CalendlyClient } from '../providers/calendly.client';
import { ProviderHttpError } from '../providers/provider-http';
import {
  CALENDAR_UNAVAILABLE,
  CalendarAccessService,
  USAGE_FIELDS,
  rejectedMessage,
  type UsableConnection,
} from './calendar-access.service';
import { lockOrganization } from '@/common/prisma/lock-organization';
import { connectionHealth, inUse } from './connection-state';

const ADMIN_ROLES: readonly WorkspaceRole[] = ['owner', 'admin'];
const PROVIDERS: readonly CalendarProvider[] = ['calendly', 'cal'];
const CAL_KEY_REJECTED = 'Cal.com did not accept this API key.';

const SUMMARY_FIELDS = {
  integrationId: true,
  provider: true,
  status: true,
  accountEmail: true,
  accountName: true,
  workspaceType: true,
  workspaceName: true,
  workspaceRole: true,
  lastError: true,
  connectedAt: true,
  syncedAt: true,
} as const satisfies Prisma.CalendarConnectionSelect;

type ConnectionSummary = Prisma.CalendarConnectionGetPayload<{ select: typeof SUMMARY_FIELDS }>;

/** What a calendar keeps about its workspace, on top of the connected account. */
interface Workspace {
  workspaceType: CalendarWorkspaceType;
  workspaceId: string;
  workspaceName: string | null;
  workspaceSlug: string | null;
  workspaceRole: WorkspaceRole;
  scope: string | null;
}

/** What the integrations row of a calendar account keeps in config. */
interface CalendarAccountConfig {
  workspace?: Workspace;
}

/**
 * The organization's one calendar: Calendly (OAuth) or Cal.com (API key,
 * personal or team). Connecting the account and its credential are
 * ConnectionsService's; this links each connected account to a calendar
 * (workspace, sync state), switches between saved ones, and picks a Cal.com
 * team. Writes connections; never reads members, meetings or availability.
 */
@Injectable()
export class CalendarConnectionService implements OnModuleInit {
  private readonly logger = new Logger(CalendarConnectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretBoxService,
    private readonly access: CalendarAccessService,
    private readonly calendly: CalendlyClient,
    private readonly cal: CalClient,
    private readonly connections: ConnectionsService,
  ) {}

  onModuleInit(): void {
    if (!this.secrets.enabled) this.logger.warn('Calendar connections are disabled: INTEGRATION_ENCRYPTION_KEY is not set.');
    const shared = {
      category: 'calendar' as const,
      feature: FEATURES.CALENDAR_INTEGRATION,
      impact: 'Leads cannot book meetings, and availability and meetings are not syncing.',
      // Webhook signing secrets are sealed, so a calendar needs the encryption key.
      unavailable: () => (this.secrets.enabled ? null : CALENDAR_UNAVAILABLE),
      afterConnected: (row: Integration, userId: string | null) => this.attach(row, userId),
      beforeDisconnect: (row: Integration) => this.releaseWebhook(row.id),
      disconnecting: async ({ tx, row }: { tx: Prisma.TransactionClient; row: Integration }) => {
        // Members, blocks and meetings synced from it go with it.
        await tx.calendarConnection.deleteMany({ where: { integrationId: row.id } });
      },
      broken: async (row: Integration) => {
        const connection = await this.prisma.calendarConnection.findUnique({ where: { integrationId: row.id }, select: USAGE_FIELDS });
        if (connection) await this.access.park(connection.orgId, connection);
      },
      recovered: async (row: Integration) => {
        const connection = await this.prisma.calendarConnection.findUnique({ where: { integrationId: row.id }, select: USAGE_FIELDS });
        if (!connection) return;
        // Only what a refresh failure parked is cleared: the same message, on the same connection.
        await this.prisma.calendarConnection.updateMany({
          where: { id: connection.id, lastError: rejectedMessage(connection.provider) },
          data: connection.status === 'error' ? { status: 'active', lastError: null } : { lastError: null },
        });
      },
      view: (row: Integration) => {
        const workspace = (row.config as CalendarAccountConfig | null)?.workspace;
        return { workspaceType: workspace?.workspaceType ?? null, workspaceName: workspace?.workspaceName ?? null };
      },
    };

    this.connections.register({
      ...shared,
      key: 'calendly',
      provider: IntegrationProvider.calendly,
      label: 'Calendly',
      description: 'Let leads book meetings on your Calendly organization.',
      auth: 'oauth',
      identify: async (token, raw) => {
        const account = await this.callProvider(() => this.calendly.currentUser(token), 'Calendly did not accept the authorization.');
        const role = await this.callProvider(() => this.calendly.roleOf(token, account.organizationUri, account.id), 'Calendly did not accept the authorization.');
        const workspace: Workspace = {
          workspaceType: 'organization',
          workspaceId: account.organizationUri,
          workspaceName: null,
          workspaceSlug: null,
          workspaceRole: requireAdmin('calendly', role),
          scope: typeof raw.scope === 'string' ? raw.scope.slice(0, 1000) : null,
        };
        return { accountId: account.id, email: account.email, name: account.name, config: { workspace } as unknown as Prisma.InputJsonObject };
      },
    });

    this.connections.register({
      ...shared,
      key: 'cal',
      provider: IntegrationProvider.cal,
      label: 'Cal.com',
      description: 'Let leads book meetings on your Cal.com account or team.',
      auth: 'apiKey',
      identify: async (apiKey) => {
        const account = await this.callProvider(() => this.cal.me(apiKey), CAL_KEY_REJECTED);
        // Personal to start with; a team is picked afterwards (setCalWorkspace).
        const workspace: Workspace = {
          workspaceType: 'personal',
          workspaceId: account.id,
          workspaceName: null,
          workspaceSlug: account.username,
          workspaceRole: 'owner',
          scope: null,
        };
        return { accountId: account.id, email: account.email, name: account.name, preview: `${apiKey.slice(0, 8)}…${apiKey.slice(-4)}`, config: { workspace } as unknown as Prisma.InputJsonObject };
      },
    });
  }

  /** The connection in use, plus what can be connected and what is saved but switched off. */
  async status(orgId: string) {
    const connections = await this.prisma.calendarConnection.findMany({ where: { orgId }, select: SUMMARY_FIELDS });
    const active = connections.find((connection) => connection.status !== 'inactive') ?? null;

    return {
      provider: active?.provider ?? null,
      connection: active ? toView(active) : null,
      providers: PROVIDERS.map((id) => {
        const reason = this.secrets.enabled ? null : CALENDAR_UNAVAILABLE;
        const saved = connections.find((connection) => connection.provider === id && connection.status === 'inactive');
        return {
          id,
          label: PROVIDER_LABEL[id],
          canConnect: reason === null,
          reason,
          saved: saved ? toView(saved) : null,
        };
      }),
    };
  }

  // --- Cal.com team ------------------------------------------------------------

  /** The account and teams the connected Cal.com key can see, to pick the workspace. */
  async listCalTeams(orgId: string) {
    const { apiKey } = await this.calAccount(orgId);
    const [account, teams] = await this.callProvider(() => Promise.all([this.cal.me(apiKey), this.cal.teams(apiKey)]), CAL_KEY_REJECTED);
    return {
      account: { email: account.email, name: account.name, username: account.username },
      teams: teams.filter((team) => !team.isOrganization).map(({ id, name, slug }) => ({ id, name, slug })),
    };
  }

  /** Points the Cal.com calendar at the owner's personal account (null) or one of their teams. */
  async setCalWorkspace(orgId: string, userId: string, teamId: number | null) {
    const { row, apiKey } = await this.calAccount(orgId);
    const account = await this.callProvider(() => this.cal.me(apiKey), CAL_KEY_REJECTED);
    let workspace: Workspace;
    if (teamId === null) {
      workspace = { workspaceType: 'personal', workspaceId: account.id, workspaceName: null, workspaceSlug: account.username, workspaceRole: 'owner', scope: null };
    } else {
      const teams = await this.callProvider(() => this.cal.teams(apiKey), CAL_KEY_REJECTED);
      const team = teams.find((candidate) => candidate.id === teamId);
      if (!team) throw new NotFoundException('This API key cannot see that Cal.com team.');
      if (team.isOrganization) throw new BadRequestException('Cal.com organizations are not supported. Pick one of its teams instead.');
      const members = await this.callProvider(() => this.cal.members(apiKey, String(team.id)), CAL_KEY_REJECTED);
      const role = members.find((member) => member.externalId === account.id)?.role ?? null;
      workspace = {
        workspaceType: 'team',
        workspaceId: String(team.id),
        workspaceName: team.name,
        workspaceSlug: team.slug,
        workspaceRole: requireAdmin('cal', role),
        scope: null,
      };
    }
    const config = { ...((row.config as Record<string, unknown>) ?? {}), workspace } as unknown as Prisma.InputJsonObject;
    const updated = await this.prisma.integration.update({ where: { id: row.id }, data: { config } });
    await this.attach(updated, userId);
    return this.status(orgId);
  }

  private async calAccount(orgId: string): Promise<{ row: Integration; apiKey: string }> {
    const [row] = await this.connections.rows(orgId, 'cal');
    if (!row) throw new NotFoundException('Connect Cal.com first.');
    try {
      return { row, apiKey: await this.connections.credential(row) };
    } catch {
      throw new ConflictException('Cal.com needs to be reconnected.');
    }
  }

  // --- switch -----------------------------------------------------------------

  /** Switches back to a saved connection after checking it still works. */
  async activate(orgId: string, provider: CalendarProvider) {
    const label = PROVIDER_LABEL[provider];
    const connection = await this.prisma.calendarConnection.findUnique({
      where: { orgId_provider: { orgId, provider } },
      select: USAGE_FIELDS,
    });
    if (!connection) {
      throw new NotFoundException(`${label} has not been connected yet. Connect it first.`);
    }
    if (connection.status === 'active') {
      return this.status(orgId);
    }
    if (connectionHealth(connection) === 'error') {
      throw new ConflictException(connection.lastError ?? `${label} needs to be reconnected.`);
    }

    await this.access.verify(orgId, connection);

    const switchedOff = await this.prisma.$transaction(async (tx) => {
      await lockOrganization(tx, orgId);
      const others = await this.switchOff(tx, orgId, connection.id);
      // Only the exact saved connection that was just verified is switched on;
      // a reconnect or another switch in the meantime wins instead.
      const switchedOn = await tx.calendarConnection.updateMany({
        where: {
          id: connection.id,
          status: 'inactive',
          integrationId: connection.integrationId,
          lastError: null,
        },
        // Its synced data is stale: the first read waits for a fresh sync.
        data: { status: 'active', syncedAt: null, syncError: null, syncLeaseUntil: null },
      });
      if (switchedOn.count === 0) {
        throw new ConflictException(`${label} changed while switching. Refresh and try again.`);
      }
      return others;
    });
    await this.forgetWebhooks(switchedOff);
    return this.status(orgId);
  }

  // --- linking a connected account ------------------------------------------------

  /**
   * Makes a connected calendar account the organization's calendar in use;
   * the one it replaces is kept, switched off. A new workspace clears the
   * synced members, so nothing from the old one lingers.
   */
  private async attach(row: Integration, userId: string | null): Promise<void> {
    const workspace = (row.config as CalendarAccountConfig | null)?.workspace;
    if (!workspace || !row.externalAccountId) throw new BadGatewayException('The calendar account was connected without its workspace. Connect it again.');
    const provider = row.provider === IntegrationProvider.calendly ? 'calendly' : 'cal';
    const where = { orgId_provider: { orgId: row.orgId, provider } } as const;
    const previous = await this.prisma.calendarConnection.findUnique({ where, select: USAGE_FIELDS });
    if (previous) await this.access.removeWebhook(previous);
    const data = {
      integrationId: row.id,
      accountId: row.externalAccountId,
      accountEmail: row.accountEmail,
      accountName: row.accountName,
      ...workspace,
      status: 'active' as const,
      lastError: null,
      connectedById: userId,
      connectedAt: new Date(),
      syncedAt: null,
      syncError: null,
      syncLeaseUntil: null,
      webhookId: null,
      webhookSecret: null,
      webhookAttemptAt: null,
    };
    const switchedOff = await this.prisma.$transaction(async (tx) => {
      await lockOrganization(tx, row.orgId);
      const others = await this.switchOff(tx, row.orgId, previous?.id ?? null);
      const saved = await tx.calendarConnection.upsert({ where, create: { orgId: row.orgId, provider, ...data }, update: data, select: { id: true } });
      if (!previous || previous.workspaceId !== workspace.workspaceId) await tx.calendarMember.deleteMany({ where: { connectionId: saved.id } });
      return others;
    });
    await this.forgetWebhooks(switchedOff);
  }

  private async releaseWebhook(integrationId: string): Promise<void> {
    const connection = await this.prisma.calendarConnection.findUnique({ where: { integrationId }, select: USAGE_FIELDS });
    if (connection) await this.access.removeWebhook(connection);
  }

  /**
   * Switches off whichever connection is in use (other than `keepId`), inside
   * the caller's locked transaction. A connection that is not in use gets no
   * webhooks, so its registration is cleared here and deleted at the provider
   * by `forgetWebhooks` once the transaction commits.
   */
  private async switchOff(
    tx: Prisma.TransactionClient,
    orgId: string,
    keepId: string | null,
  ): Promise<UsableConnection[]> {
    const where = { ...inUse(orgId), ...(keepId ? { id: { not: keepId } } : {}) };
    const others = await tx.calendarConnection.findMany({ where, select: USAGE_FIELDS });
    if (others.length) {
      await tx.calendarConnection.updateMany({
        where: { id: { in: others.map((other) => other.id) } },
        data: { status: 'inactive', syncLeaseUntil: null, webhookId: null, webhookSecret: null, webhookAttemptAt: null },
      });
    }
    return others;
  }

  /** Best effort, after commit: removes the provider webhooks of connections just switched off. */
  private async forgetWebhooks(connections: UsableConnection[]): Promise<void> {
    await Promise.all(connections.map((connection) => this.access.removeWebhook(connection)));
  }

  /** Turns a provider failure during connect into a clear 4xx/502 for the person connecting. */
  private async callProvider<T>(call: () => Promise<T>, rejectedText: string): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof ProviderHttpError)) throw error;
      this.logger.warn(`${error.message} (HTTP ${error.status})`);
      if (error.credentialRejected || error.status === 400) throw new BadRequestException(rejectedText);
      if (error.status === 403) throw new ForbiddenException(error.message);
      throw new BadGatewayException(error.message);
    }
  }
}

/** Only an owner or admin can read every member's calendar. */
function requireAdmin(provider: CalendarProvider, role: WorkspaceRole | null): WorkspaceRole {
  if (!role || !ADMIN_ROLES.includes(role)) {
    const where = provider === 'calendly' ? 'Calendly organization' : 'Cal.com team';
    throw new ConnectionRefused(403, 'CALENDAR_NOT_ADMIN', `Connect an account that is an owner or admin of your ${where}, so every member's calendar can be read.`, true);
  }
  return role;
}

function toView(connection: ConnectionSummary) {
  return {
    integrationId: connection.integrationId,
    status: connectionHealth(connection),
    accountEmail: connection.accountEmail,
    accountName: connection.accountName,
    workspaceType: connection.workspaceType,
    workspaceName: connection.workspaceName,
    workspaceRole: connection.workspaceRole,
    connectedAt: connection.connectedAt,
    syncedAt: connection.syncedAt,
    lastError: connection.lastError,
  };
}
