import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { CalendarProvider, CalendarWorkspaceType, Prisma } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';
import { SecretBoxService } from '@/common/service/secret-box.service';
import {
  PROVIDER_LABEL,
  type CalCredentials,
  type CalendlyCredentials,
  type CalendlyOAuthState,
  type WorkspaceRole,
} from '../calendar.types';
import { CalClient } from '../providers/cal.client';
import { CalendlyClient } from '../providers/calendly.client';
import { ProviderHttpError } from '../providers/provider-http';
import {
  CALENDAR_UNAVAILABLE,
  CalendarAccessService,
  USAGE_FIELDS,
  lockOrganization,
  type UsableConnection,
} from './calendar-access.service';
import { connectionHealth, inUse } from './connection-state';
import type { CalConnectDto } from './dto/cal-connect.dto';

export const OAUTH_STATE_TTL_MS = 10 * 60_000;
const ADMIN_ROLES: readonly WorkspaceRole[] = ['owner', 'admin'];
const PROVIDERS: readonly CalendarProvider[] = ['calendly', 'cal'];
const CAL_KEY_REJECTED = 'Cal.com did not accept this API key.';
const CALENDLY_REJECTED = 'Calendly did not accept the authorization.';
const CALENDLY_UNAVAILABLE = 'Calendly is not available yet. Please contact support or connect Cal.com instead.';

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
} as const satisfies Prisma.CalendarConnectionSelect;

type ConnectionSummary = Prisma.CalendarConnectionGetPayload<{ select: typeof SUMMARY_FIELDS }>;

interface NewConnection {
  provider: CalendarProvider;
  accountId: string;
  accountEmail: string | null;
  accountName: string | null;
  workspaceType: CalendarWorkspaceType;
  workspaceId: string;
  workspaceName: string | null;
  workspaceSlug: string | null;
  workspaceRole: WorkspaceRole;
  credentials: CalendlyCredentials | CalCredentials;
  tokenExpiresAt: Date | null;
}

/**
 * Connecting the organization's one calendar: Calendly (OAuth) or Cal.com (API
 * key, personal or team), switching between saved ones, and disconnecting.
 * Writes connections; never reads members, meetings or availability.
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
  ) {}

  onModuleInit(): void {
    if (!this.secrets.enabled) {
      this.logger.warn('Calendar connections are disabled: INTEGRATION_ENCRYPTION_KEY is not set.');
    }
    const missing = this.calendly.missingConfig;
    if (missing.length) {
      this.logger.warn(`Calendly is disabled: missing ${missing.join(', ')}.`);
    }
  }

  /** The connection in use, plus what can be connected and what is saved but switched off. */
  async status(orgId: string) {
    const connections = await this.prisma.calendarConnection.findMany({ where: { orgId }, select: SUMMARY_FIELDS });
    const active = connections.find((connection) => connection.status !== 'inactive') ?? null;

    return {
      provider: active?.provider ?? null,
      connection: active ? toView(active) : null,
      providers: PROVIDERS.map((id) => {
        const reason = this.unavailableReason(id);
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

  // --- Calendly (OAuth) -------------------------------------------------------

  /** The URL to send the person to, and the nonce the caller must keep in their browser's cookie. */
  startCalendly(orgId: string, userId: string) {
    this.assertCanConnect('calendly');
    const nonce = randomBytes(32).toString('base64url');
    const state: CalendlyOAuthState = {
      orgId,
      userId,
      expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
      nonceHash: sha256(nonce),
    };
    return { authorizeUrl: this.calendly.authorizeUrl(this.secrets.seal(JSON.stringify(state))), nonce };
  }

  async completeCalendly(code: string, sealedState: string, nonce: string | undefined): Promise<void> {
    this.assertCanConnect('calendly');
    const { orgId, userId } = this.readState(sealedState, nonce);
    // The person who started may have been removed from the organization since.
    const user = await this.prisma.user.findFirst({ where: { id: userId, orgId }, select: { id: true } });
    if (!user) {
      throw new ForbiddenException('You are no longer a member of this organization.');
    }
    const grant = await this.callProvider(() => this.calendly.exchangeCode(code), CALENDLY_REJECTED);

    try {
      const [account, role] = await this.callProvider(
        () =>
          Promise.all([
            this.calendly.currentUser(grant.accessToken),
            this.calendly.roleOf(grant.accessToken, grant.organizationUri, grant.userUri),
          ]),
        CALENDLY_REJECTED,
      );
      await this.save(orgId, userId, {
        provider: 'calendly',
        accountId: account.id,
        accountEmail: account.email,
        accountName: account.name,
        workspaceType: 'organization',
        workspaceId: grant.organizationUri,
        workspaceName: null,
        workspaceSlug: null,
        workspaceRole: this.requireAdmin('calendly', role),
        credentials: { accessToken: grant.accessToken, refreshToken: grant.refreshToken },
        tokenExpiresAt: grant.expiresAt,
      });
    } catch (error) {
      // Never leave a grant behind that we did not store.
      await this.access.revokeCalendly(grant.accessToken);
      throw error;
    }
  }

  // --- Cal.com (API key) ------------------------------------------------------

  async listCalTeams(apiKey: string) {
    this.assertCanConnect('cal');
    const [account, teams] = await this.callProvider(
      () => Promise.all([this.cal.me(apiKey), this.cal.teams(apiKey)]),
      CAL_KEY_REJECTED,
    );
    return {
      account: { email: account.email, name: account.name, username: account.username },
      teams: teams.filter((team) => !team.isOrganization).map(({ id, name, slug }) => ({ id, name, slug })),
    };
  }

  async connectCal(orgId: string, userId: string, { apiKey, teamId }: CalConnectDto) {
    this.assertCanConnect('cal');
    const account = await this.callProvider(() => this.cal.me(apiKey), CAL_KEY_REJECTED);
    const base = {
      provider: 'cal' as const,
      accountId: account.id,
      accountEmail: account.email,
      accountName: account.name,
      credentials: { apiKey },
      tokenExpiresAt: null,
    };

    if (teamId === undefined || teamId === null) {
      await this.save(orgId, userId, {
        ...base,
        workspaceType: 'personal',
        workspaceId: account.id,
        workspaceName: null,
        workspaceSlug: account.username,
        workspaceRole: 'owner',
      });
      return this.status(orgId);
    }

    const teams = await this.callProvider(() => this.cal.teams(apiKey), CAL_KEY_REJECTED);
    const team = teams.find((candidate) => candidate.id === teamId);
    if (!team) {
      throw new NotFoundException('This API key cannot see that Cal.com team.');
    }
    if (team.isOrganization) {
      throw new BadRequestException('Cal.com organizations are not supported. Pick one of its teams instead.');
    }

    const members = await this.callProvider(() => this.cal.members(apiKey, String(team.id)), CAL_KEY_REJECTED);
    const role = members.find((member) => member.externalId === account.id)?.role ?? null;

    await this.save(orgId, userId, {
      ...base,
      workspaceType: 'team',
      workspaceId: String(team.id),
      workspaceName: team.name,
      workspaceSlug: team.slug,
      workspaceRole: this.requireAdmin('cal', role),
    });
    return this.status(orgId);
  }

  // --- switch and disconnect --------------------------------------------------

  /** Switches back to a saved connection after checking it still works. */
  async activate(orgId: string, provider: CalendarProvider) {
    this.assertCanConnect(provider);
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
        where: { id: connection.id, status: 'inactive', credentials: connection.credentials, lastError: null },
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

  /** Removes the active connection and everything synced from it. Idempotent. */
  async disconnect(orgId: string): Promise<void> {
    const connection = await this.prisma.calendarConnection.findFirst({
      where: inUse(orgId),
      select: USAGE_FIELDS,
    });
    if (!connection) return;

    await this.access.removeWebhook(connection);
    await this.prisma.calendarConnection.deleteMany({ where: { id: connection.id } });
    if (connection.provider === 'calendly') {
      await this.access.revokeStoredCalendly(connection.credentials);
    }
  }

  // --- helpers ----------------------------------------------------------------

  private unavailableReason(provider: CalendarProvider): string | null {
    if (!this.secrets.enabled) return CALENDAR_UNAVAILABLE;
    if (provider === 'calendly' && !this.calendly.configured) return CALENDLY_UNAVAILABLE;
    return null;
  }

  private assertCanConnect(provider: CalendarProvider): void {
    const reason = this.unavailableReason(provider);
    if (reason) throw new ServiceUnavailableException(reason);
  }

  /** Only an owner or admin can read every member's calendar. */
  private requireAdmin(provider: CalendarProvider, role: WorkspaceRole | null): WorkspaceRole {
    if (!role || !ADMIN_ROLES.includes(role)) {
      const where = provider === 'calendly' ? 'Calendly organization' : 'Cal.com team';
      throw new ForbiddenException(
        `Connect an account that is an owner or admin of your ${where}, so every member's calendar can be read.`,
      );
    }
    return role;
  }

  private readState(sealed: string, nonce: string | undefined): CalendlyOAuthState {
    const state = this.access.unseal<CalendlyOAuthState>(sealed);
    if (!state?.orgId || !state.userId || typeof state.expiresAt !== 'number' || typeof state.nonceHash !== 'string') {
      throw new BadRequestException('This Calendly sign-in link is not valid. Start again from Settings.');
    }
    if (state.expiresAt < Date.now()) {
      throw new BadRequestException('This Calendly sign-in link has expired. Start again from Settings.');
    }
    // Finishing needs the cookie set when this sign-in started, so a link
    // started by someone else cannot attach your Calendly to their organization.
    if (!nonce || !safeEqual(sha256(nonce), state.nonceHash)) {
      throw new BadRequestException('Finish connecting Calendly in the same browser you started in. Start again from Settings.');
    }
    return state;
  }

  /**
   * Stores a new connection as the one in use; the one it replaces is kept,
   * switched off. Replacing the same provider clears its synced members, so
   * nothing from the old workspace lingers.
   */
  private async save(orgId: string, userId: string, connection: NewConnection): Promise<void> {
    const where = { orgId_provider: { orgId, provider: connection.provider } };
    const previous = await this.prisma.calendarConnection.findUnique({ where, select: USAGE_FIELDS });
    if (previous) await this.access.removeWebhook(previous);
    const user = await this.prisma.user.findFirst({ where: { id: userId, orgId }, select: { id: true } });
    const data = {
      ...connection,
      status: 'active' as const,
      credentials: this.secrets.seal(JSON.stringify(connection.credentials)),
      lastError: null,
      connectedById: user?.id ?? null,
      connectedAt: new Date(),
      syncedAt: null,
      syncError: null,
      syncLeaseUntil: null,
      webhookId: null,
      webhookSecret: null,
      webhookAttemptAt: null,
    };

    const switchedOff = await this.prisma.$transaction(async (tx) => {
      await lockOrganization(tx, orgId);
      const others = await this.switchOff(tx, orgId, previous?.id ?? null);
      const saved = await tx.calendarConnection.upsert({ where, create: { orgId, ...data }, update: data, select: { id: true } });
      await tx.calendarMember.deleteMany({ where: { connectionId: saved.id } });
      return others;
    });
    await this.forgetWebhooks(switchedOff);

    if (previous && connection.provider === 'calendly') {
      await this.access.revokeStoredCalendly(previous.credentials);
    }
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
  private async callProvider<T>(call: () => Promise<T>, rejectedMessage: string): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof ProviderHttpError)) throw error;
      this.logger.warn(`${error.message} (HTTP ${error.status})`);
      if (error.credentialRejected || error.status === 400) throw new BadRequestException(rejectedMessage);
      if (error.status === 403) throw new ForbiddenException(error.message);
      throw new BadGatewayException(error.message);
    }
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function toView(connection: ConnectionSummary) {
  return {
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
