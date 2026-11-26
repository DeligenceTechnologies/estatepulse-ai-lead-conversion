import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { CalendarProvider, CalendarWorkspaceType, Prisma } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';
import { ConnectionAlertService } from '@/common/service/connection-alert.service';
import { NangoService } from '@/integrations/nango/nango.service';
import { PROVIDER_LABEL, type ProviderAccount, type WorkspaceRole } from '../calendar.types';
import { CalClient, type CalAccount } from '../providers/cal.client';
import { CalendlyClient, type CalendlyAccount } from '../providers/calendly.client';
import { CalendarSyncService } from '../sync/calendar-sync.service';
import { CalendarAccessService, USAGE_FIELDS, lockOrganization, type UsableConnection } from './calendar-access.service';
import { connectionHealth, inUse } from './connection-state';
import { nangoReference, readNangoReference, type NangoReference } from './nango-reference';

const SUMMARY_FIELDS = {
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
  credentials: true,
} as const satisfies Prisma.CalendarConnectionSelect;

const ADMIN_ROLES: readonly WorkspaceRole[] = ['owner', 'admin'];
export const PERSONAL_WORKSPACE = 'personal';

/** A calendar an account can connect: its own, a Cal.com team, or its Calendly organization. */
export interface CalendarWorkspace {
  id: string;
  name: string;
  type: CalendarWorkspaceType;
  slug: string | null;
}

/** What is stored for the account and workspace a calendar books into. */
interface Activation {
  provider: CalendarProvider;
  account: ProviderAccount;
  workspace: CalendarWorkspace;
  /** The provider's id for the workspace (Cal.com: user or team id; Calendly: organization URI). */
  workspaceId: string;
  role: WorkspaceRole;
}

/**
 * The organization's one calendar (Calendly or Cal.com): its status,
 * connecting it through Nango (the Integrations page), and disconnecting.
 * Never reads members, meetings or availability.
 */
@Injectable()
export class CalendarConnectionService {
  private readonly logger = new Logger(CalendarConnectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CalendarAccessService,
    private readonly cal: CalClient,
    private readonly calendly: CalendlyClient,
    private readonly syncs: CalendarSyncService,
    private readonly nango: NangoService,
    private readonly connectionAlerts: ConnectionAlertService,
  ) {}

  /** The connection in use, or null. */
  async status(orgId: string) {
    const connection = await this.prisma.calendarConnection.findFirst({ where: inUse(orgId), select: SUMMARY_FIELDS });
    return {
      provider: connection?.provider ?? null,
      connection: connection
        ? {
            status: connectionHealth(connection),
            accountEmail: connection.accountEmail,
            accountName: connection.accountName,
            workspaceType: connection.workspaceType,
            workspaceName: connection.workspaceName,
            workspaceRole: connection.workspaceRole,
            connectedAt: connection.connectedAt,
            syncedAt: connection.syncedAt,
            lastError: connection.lastError,
            // Where it is managed: a Nango connection is reconnected and removed on the Integrations page.
            managedBy: readNangoReference(connection.credentials) ? ('integrations' as const) : ('calendar' as const),
          }
        : null,
    };
  }

  /** Removes the active connection and everything synced from it. Idempotent. */
  async disconnect(orgId: string): Promise<void> {
    const connection = await this.prisma.calendarConnection.findFirst({ where: inUse(orgId), select: USAGE_FIELDS });
    if (!connection) return;
    await this.access.removeWebhook(connection);
    await this.prisma.calendarConnection.deleteMany({ where: { id: connection.id } });

    // The account stays connected on the Integrations page, but no longer books: its setup starts over.
    const ref = readNangoReference(connection.credentials);
    if (ref) {
      await this.prisma.integrationConnection.updateMany({
        where: { orgId, nangoConnectionId: ref.connectionId },
        data: { settings: {} },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Cal.com through Nango
  // ---------------------------------------------------------------------------

  /** What the API key can connect. Provider errors (ProviderHttpError) propagate to the caller. */
  async calWorkspaces(apiKey: string): Promise<{ account: CalAccount; workspaces: CalendarWorkspace[] }> {
    const [account, teams] = await Promise.all([this.cal.me(apiKey), this.cal.teams(apiKey)]);
    return {
      account,
      workspaces: [
        { id: PERSONAL_WORKSPACE, name: `My calendar${account.name ? ` (${account.name})` : ''}`, type: 'personal', slug: account.username },
        ...teams
          // Cal.com organizations are not supported; their teams are listed on their own.
          .filter((team) => !team.isOrganization)
          .map((team) => ({ id: String(team.id), name: team.name, type: 'team' as const, slug: team.slug })),
      ],
    };
  }

  /**
   * Makes a Nango-held Cal.com account the organization's calendar, booking
   * into `workspaceId` (its own calendar or one of its teams). Re-validated
   * against Cal.com every time: nothing from the browser is trusted.
   */
  async useNangoCal(
    orgId: string,
    userId: string | null,
    input: { ref: NangoReference; apiKey: string; workspaceId: string },
  ): Promise<CalendarWorkspace> {
    const { ref, apiKey, workspaceId } = input;
    const account = await this.cal.me(apiKey);

    if (workspaceId === PERSONAL_WORKSPACE) {
      const workspace: CalendarWorkspace = { id: PERSONAL_WORKSPACE, name: account.name ?? account.email ?? 'My calendar', type: 'personal', slug: account.username };
      return this.activate(orgId, userId, ref, { provider: 'cal', account, workspace, workspaceId: account.id, role: 'owner' });
    }

    const teams = await this.cal.teams(apiKey);
    const team = teams.find((candidate) => String(candidate.id) === workspaceId);
    if (!team) throw new NotFoundException('This Cal.com account cannot see that team. Pick another one.');
    if (team.isOrganization) throw new BadRequestException('Cal.com organizations are not supported. Pick one of its teams instead.');
    const members = await this.cal.members(apiKey, String(team.id));
    const role = members.find((member) => member.externalId === account.id)?.role ?? null;
    if (!role || !ADMIN_ROLES.includes(role)) {
      throw new ForbiddenException('Connect a Cal.com account that is an owner or admin of this team, so every member’s calendar can be read.');
    }
    const workspace: CalendarWorkspace = { id: String(team.id), name: team.name, type: 'team', slug: team.slug };
    return this.activate(orgId, userId, ref, { provider: 'cal', account, workspace, workspaceId: String(team.id), role });
  }

  // ---------------------------------------------------------------------------
  // Calendly through Nango
  // ---------------------------------------------------------------------------

  /** The Calendly organization the token's user is in: the only calendar a Calendly account can connect. */
  async calendlyWorkspaces(accessToken: string): Promise<{ account: CalendlyAccount; workspaces: CalendarWorkspace[] }> {
    const account = await this.calendly.currentUser(accessToken);
    return {
      account,
      workspaces: [{ id: account.organizationUri, name: 'Your Calendly organization', type: 'organization', slug: null }],
    };
  }

  /**
   * Makes a Nango-held Calendly account the organization's calendar. Its user
   * must be an owner or admin of their Calendly organization, so every
   * member's availability can be read and booked.
   */
  async useNangoCalendly(
    orgId: string,
    userId: string | null,
    input: { ref: NangoReference; accessToken: string; workspaceId: string },
  ): Promise<CalendarWorkspace> {
    const { ref, accessToken, workspaceId } = input;
    const account = await this.calendly.currentUser(accessToken);
    if (!account.organizationUri) throw new BadRequestException('This Calendly account is not in a Calendly organization.');
    // The person may have switched organizations in Calendly since the screen was loaded.
    if (workspaceId !== account.organizationUri) {
      throw new NotFoundException('This Calendly account is no longer in that organization. Reload and try again.');
    }
    const role = await this.calendly.roleOf(accessToken, account.organizationUri, account.id);
    if (!role || !ADMIN_ROLES.includes(role)) {
      throw new ForbiddenException(
        'Connect a Calendly account that is an owner or admin of your Calendly organization, so every member’s calendar can be read.',
      );
    }
    const workspace: CalendarWorkspace = { id: account.organizationUri, name: 'Your Calendly organization', type: 'organization', slug: null };
    return this.activate(orgId, userId, ref, { provider: 'calendly', account, workspace, workspaceId: account.organizationUri, role });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle of a Nango-held calendar (both providers)
  // ---------------------------------------------------------------------------

  /** Before the Nango connection is deleted (its credentials still work): removes the provider webhook. Best effort. */
  async releaseNangoWebhook(orgId: string, ref: NangoReference): Promise<void> {
    const connection = await this.prisma.calendarConnection.findFirst({
      where: { orgId, credentials: nangoReference(ref) },
      select: USAGE_FIELDS,
    });
    if (connection) await this.access.removeWebhook(connection);
  }

  /** The Nango connection was deleted: the calendar it served goes, with everything synced from it. */
  async forgetNango(orgId: string, ref: NangoReference): Promise<void> {
    this.nango.forgetApiKey(ref.providerConfigKey, ref.connectionId);
    const removed = await this.prisma.calendarConnection.deleteMany({ where: { orgId, credentials: nangoReference(ref) } });
    if (removed.count) this.logger.log(`Calendar connection removed with Nango connection ${ref.connectionId}.`);
  }

  /** The grant stopped working (revoked, refresh failed, removed from Nango): booking pauses until it is reconnected. */
  async nangoBroken(orgId: string, ref: NangoReference, message: string): Promise<void> {
    this.nango.forgetApiKey(ref.providerConfigKey, ref.connectionId);
    const credentials = nangoReference(ref);
    const lastError = message.slice(0, 500);
    const row = await this.prisma.calendarConnection.findFirst({ where: { orgId, credentials }, select: { id: true, provider: true } });
    if (!row) return;
    const parked = await this.prisma.calendarConnection.updateMany({
      where: { id: row.id, status: 'active' },
      data: { status: 'error', lastError },
    });
    await this.prisma.calendarConnection.updateMany({ where: { id: row.id, status: 'inactive' }, data: { lastError } });
    if (parked.count) {
      this.connectionAlerts.connectionBroken({
        orgId,
        connectionId: row.id,
        providerLabel: PROVIDER_LABEL[row.provider],
        impact: 'Leads cannot book meetings, and availability and meetings are not syncing.',
        reconnectPath: '/integrations',
        brokenAt: new Date(),
      });
    }
  }

  /** Reconnected (possibly with new credentials): booking resumes after a fresh sync. */
  async nangoRestored(orgId: string, ref: NangoReference): Promise<void> {
    this.nango.forgetApiKey(ref.providerConfigKey, ref.connectionId);
    const credentials = nangoReference(ref);
    const restored = await this.prisma.calendarConnection.updateMany({
      where: { orgId, credentials, status: 'error' },
      data: { status: 'active', lastError: null, syncedAt: null, syncError: null, syncLeaseUntil: null },
    });
    await this.prisma.calendarConnection.updateMany({ where: { orgId, credentials, status: 'inactive' }, data: { lastError: null } });
    if (!restored.count) return;

    const row = await this.prisma.calendarConnection.findFirst({ where: { orgId, credentials, status: 'active' }, select: USAGE_FIELDS });
    if (!row) return;
    // The webhook may belong to the old grant: remove it with the new one, and let the sync register a fresh one.
    await this.access.removeWebhook(row);
    await this.prisma.calendarConnection.updateMany({
      where: { id: row.id },
      data: { webhookId: null, webhookSecret: null, webhookAttemptAt: null },
    });
    this.syncSoon(row.id, row.provider);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Stores the connection as the organization's one calendar, then: every
   * other Nango-held calendar account goes back to "choose a calendar" (only
   * one books), and the first sync starts now instead of within five minutes.
   */
  private async activate(orgId: string, userId: string | null, ref: NangoReference, activation: Activation): Promise<CalendarWorkspace> {
    const id = await this.save(orgId, userId, ref, activation);

    const others = await this.prisma.calendarConnection.findMany({ where: { orgId, id: { not: id } }, select: { credentials: true } });
    const otherNangoIds = others.map((other) => readNangoReference(other.credentials)?.connectionId).filter((x): x is string => Boolean(x));
    await this.prisma.integrationConnection.updateMany({
      where: {
        orgId,
        nangoConnectionId: { not: ref.connectionId },
        status: { not: 'disconnected' },
        // Accounts of the same integration (whose calendar was just replaced) and of the calendar just switched off.
        OR: [{ providerConfigKey: ref.providerConfigKey }, { nangoConnectionId: { in: otherNangoIds } }],
      },
      data: { settings: {} },
    });

    this.syncSoon(id, activation.provider);
    return activation.workspace;
  }

  private syncSoon(connectionId: string, provider: CalendarProvider): void {
    void this.syncs.sync(connectionId).catch((error: unknown) => {
      this.logger.warn(`${PROVIDER_LABEL[provider]} sync of ${connectionId} failed: ${(error as Error).message}; the scheduled sync retries.`);
    });
  }

  /**
   * Stores the connection as the one in use. A connection of the same provider
   * is overwritten and its members cleared, so nothing from the old workspace
   * lingers; another provider in use is switched off (kept, not deleted).
   */
  private async save(orgId: string, userId: string | null, ref: NangoReference, activation: Activation): Promise<string> {
    const { provider, account, workspace, workspaceId, role } = activation;
    const where = { orgId_provider: { orgId, provider } };
    const previous = await this.prisma.calendarConnection.findUnique({ where, select: USAGE_FIELDS });
    if (previous) await this.access.removeWebhook(previous);
    const user = userId ? await this.prisma.user.findFirst({ where: { id: userId, orgId }, select: { id: true } }) : null;

    const data = {
      provider,
      status: 'active' as const,
      accountId: account.id.slice(0, 255),
      accountEmail: account.email?.slice(0, 255) ?? null,
      accountName: account.name?.slice(0, 255) ?? null,
      workspaceType: workspace.type,
      workspaceId: workspaceId.slice(0, 255),
      workspaceName: workspace.type === 'team' ? workspace.name.slice(0, 255) : null,
      workspaceSlug: workspace.slug?.slice(0, 255) ?? null,
      workspaceRole: role,
      credentials: nangoReference(ref),
      // Nango owns token expiry and refresh.
      tokenExpiresAt: null,
      scope: null,
      lastError: null,
      connectedById: user?.id ?? null,
      connectedAt: new Date(),
      syncedAt: null,
      syncError: null,
      syncLeaseUntil: null,
      webhookId: null,
      webhookSecret: null,
      webhookAttemptAt: null,
      meetingsSyncedAt: null,
      meetingsError: null,
    };

    const { id, switchedOff } = await this.prisma.$transaction(async (tx) => {
      await lockOrganization(tx, orgId);
      const others = await this.switchOff(tx, orgId, previous?.id ?? null);
      const saved = await tx.calendarConnection.upsert({ where, create: { orgId, ...data }, update: data, select: { id: true } });
      await tx.calendarMember.deleteMany({ where: { connectionId: saved.id } });
      return { id: saved.id, switchedOff: others };
    });
    // Best effort, after commit: a connection not in use gets no webhooks.
    await Promise.all(switchedOff.map((connection) => this.access.removeWebhook(connection)));
    return id;
  }

  /** Switches off whichever connection is in use (other than `keepId`), inside the caller's locked transaction. */
  private async switchOff(tx: Prisma.TransactionClient, orgId: string, keepId: string | null): Promise<UsableConnection[]> {
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
}
