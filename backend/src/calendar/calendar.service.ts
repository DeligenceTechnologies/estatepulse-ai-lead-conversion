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
import type { WorkingDayDto } from '@/common/utils/working-hours';
import { isTimeZone } from '@/common/utils/zoned-time';
import { DEFAULT_ROLES } from '@/role/permissions';
import { UserService } from '@/user/user.service';
import {
  PROVIDER_LABEL,
  type CalCredentials,
  type CalendlyCredentials,
  type CalendlyOAuthState,
  type SchedulingEventType,
  type SchedulingMember,
  type WorkspaceRole,
} from './calendar.types';
import type { CalConnectDto } from './dto/cal-connect.dto';
import { CalClient } from './providers/cal.client';
import { CalendlyClient, type CalendlyGrant } from './providers/calendly.client';
import { ProviderHttpError } from './providers/provider-http';

const OAUTH_STATE_TTL_MS = 10 * 60_000;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
const ADMIN_ROLES: readonly WorkspaceRole[] = ['owner', 'admin'];
const PROVIDERS: readonly CalendarProvider[] = ['calendly', 'cal'];
const CAL_KEY_REJECTED = 'Cal.com did not accept this API key.';
const CALENDLY_REJECTED = 'Calendly did not accept the authorization.';
const CALENDAR_UNAVAILABLE = 'Calendar connections are not available yet. Please contact support.';
const CALENDLY_UNAVAILABLE = 'Calendly is not available yet. Please contact support or connect Cal.com instead.';

const SUMMARY_FIELDS = {
  provider: true,
  status: true,
  isActive: true,
  accountEmail: true,
  accountName: true,
  workspaceType: true,
  workspaceName: true,
  workspaceRole: true,
  lastError: true,
  connectedAt: true,
} as const satisfies Prisma.CalendarConnectionSelect;

const USAGE_FIELDS = {
  id: true,
  orgId: true,
  provider: true,
  status: true,
  workspaceType: true,
  workspaceId: true,
  workspaceSlug: true,
  credentials: true,
  tokenExpiresAt: true,
  lastError: true,
  webhookId: true,
} as const satisfies Prisma.CalendarConnectionSelect;

type ConnectionSummary = Prisma.CalendarConnectionGetPayload<{ select: typeof SUMMARY_FIELDS }>;
export type UsableConnection = Prisma.CalendarConnectionGetPayload<{ select: typeof USAGE_FIELDS }>;

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

class CredentialsChanged extends Error {}

@Injectable()
export class CalendarService implements OnModuleInit {
  private readonly logger = new Logger(CalendarService.name);
  private readonly refreshes = new Map<string, Promise<string>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretBoxService,
    private readonly calendly: CalendlyClient,
    private readonly cal: CalClient,
    private readonly users: UserService,
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

  async status(orgId: string) {
    const connections = await this.prisma.calendarConnection.findMany({ where: { orgId }, select: SUMMARY_FIELDS });
    const active = connections.find((connection) => connection.isActive) ?? null;

    return {
      provider: active?.provider ?? null,
      connection: active ? toView(active) : null,
      providers: PROVIDERS.map((id) => {
        const reason = this.unavailableReason(id);
        const saved = connections.find((connection) => connection.provider === id && !connection.isActive);
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

  startCalendly(orgId: string, userId: string) {
    this.assertCanConnect('calendly');
    const state: CalendlyOAuthState = { orgId, userId, expiresAt: Date.now() + OAUTH_STATE_TTL_MS };
    return { authorizeUrl: this.calendly.authorizeUrl(this.secrets.seal(JSON.stringify(state))) };
  }

  async completeCalendly(code: string, sealedState: string): Promise<void> {
    this.assertCanConnect('calendly');
    const { orgId, userId } = this.readState(sealedState);
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
      await this.revokeCalendly(grant.accessToken);
      throw error;
    }
  }

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
    if (connection.status === 'error') {
      throw new ConflictException(connection.lastError ?? `${label} needs to be reconnected.`);
    }

    try {
      await this.withCredentials(orgId, connection, (secret) =>
        provider === 'calendly' ? this.calendly.currentUser(secret) : this.cal.me(secret),
      );
    } catch (error) {
      if (error instanceof CredentialsChanged) throw new ConflictException(error.message);
      throw error;
    }

    await this.prisma.$transaction(async (tx) => {
      await lockOrganization(tx, orgId);
      await tx.calendarConnection.updateMany({ where: { orgId, isActive: true }, data: { isActive: false } });
      await tx.calendarConnection.update({ where: { id: connection.id }, data: { isActive: true } });
    });
    return this.status(orgId);
  }

  async disconnect(orgId: string): Promise<void> {
    const connection = await this.prisma.calendarConnection.findFirst({
      where: { orgId, isActive: true },
      select: USAGE_FIELDS,
    });
    if (!connection) return;

    await this.removeWebhook(connection);
    await this.prisma.calendarConnection.deleteMany({ where: { id: connection.id } });
    if (connection.provider === 'calendly') {
      await this.revokeCalendly(this.unseal<CalendlyCredentials>(connection.credentials)?.refreshToken);
    }
  }

  async addMemberAsAgent(orgId: string, externalId: string) {
    const member = (await this.fetchMembers(orgId)).find((candidate) => candidate.externalId === externalId);
    if (!member) {
      throw new NotFoundException('This person is no longer a member of the connected calendar. Refresh the list.');
    }
    const email = member.email.trim().toLowerCase();
    if (!email) {
      throw new BadRequestException(`${member.name} has no email address in the calendar, so they cannot sign in.`);
    }

    const existing = await this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { orgId: true },
    });
    if (existing) {
      throw new ConflictException(
        existing.orgId === orgId
          ? `${email} is already on EstatePulse.`
          : `${email} already belongs to another EstatePulse account.`,
      );
    }

    const [agentRole, settings] = await Promise.all([
      this.prisma.role.findFirst({
        where: { orgId, isSystem: false, name: { equals: DEFAULT_ROLES.AGENT.name, mode: 'insensitive' } },
        select: { id: true },
      }),
      this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { timezone: true, workingHours: true } }),
    ]);
    if (!agentRole) {
      throw new ConflictException('This organization has no "Agent" role. Create it under Roles, then try again.');
    }

    const { firstName, lastName } = splitName(member.name, email);
    const created = await this.users.create({
      orgId,
      firstName,
      lastName,
      email,
      timezone: (isTimeZone(member.timezone) ? member.timezone : settings?.timezone) ?? undefined,
      workingHours: (settings?.workingHours as unknown as WorkingDayDto[] | undefined) ?? undefined,
      roleIds: [agentRole.id],
    });

    return {
      user: { id: created.id, name: `${created.firstName} ${created.lastName}`.trim(), email: created.email },
      // TODO => production me uncomment
      // credentialsEmail: created.credentialsEmail,
    };
  }

  eventTypes(orgId: string): Promise<SchedulingEventType[]> {
    return this.useActive(orgId, (connection, secret) => {
      if (connection.provider === 'calendly') return this.calendly.eventTypes(secret, connection.workspaceId);
      if (connection.workspaceType === 'personal') return this.cal.personalEventTypes(secret, connection.workspaceSlug);
      return this.cal.teamEventTypes(secret, connection.workspaceId, connection.workspaceSlug);
    });
  }

  fetchMembers(orgId: string): Promise<SchedulingMember[]> {
    return this.useActive(orgId, (connection, secret) => this.membersFor(connection, secret));
  }

  membersFor(connection: UsableConnection, secret: string): Promise<SchedulingMember[]> {
    if (connection.provider === 'calendly') return this.calendly.members(secret, connection.workspaceId);
    if (connection.workspaceType === 'personal') return this.cal.personalMember(secret).then((member) => [member]);
    return this.cal.members(secret, connection.workspaceId);
  }

  private unavailableReason(provider: CalendarProvider): string | null {
    if (!this.secrets.enabled) return CALENDAR_UNAVAILABLE;
    if (provider === 'calendly' && !this.calendly.configured) return CALENDLY_UNAVAILABLE;
    return null;
  }

  private assertCanConnect(provider: CalendarProvider): void {
    const reason = this.unavailableReason(provider);
    if (reason) throw new ServiceUnavailableException(reason);
  }

  private requireAdmin(provider: CalendarProvider, role: WorkspaceRole | null): WorkspaceRole {
    if (!role || !ADMIN_ROLES.includes(role)) {
      const where = provider === 'calendly' ? 'Calendly organization' : 'Cal.com team';
      throw new ForbiddenException(
        `Connect an account that is an owner or admin of your ${where}, so every member's calendar can be read.`,
      );
    }
    return role;
  }

  private readState(sealed: string): CalendlyOAuthState {
    const state = this.unseal<CalendlyOAuthState>(sealed);
    if (!state?.orgId || !state.userId || typeof state.expiresAt !== 'number') {
      throw new BadRequestException('This Calendly sign-in link is not valid. Start again from Settings.');
    }
    if (state.expiresAt < Date.now()) {
      throw new BadRequestException('This Calendly sign-in link has expired. Start again from Settings.');
    }
    return state;
  }

  private async save(orgId: string, userId: string, connection: NewConnection): Promise<void> {
    const where = { orgId_provider: { orgId, provider: connection.provider } };
    const previous = await this.prisma.calendarConnection.findUnique({ where, select: USAGE_FIELDS });
    if (previous) await this.removeWebhook(previous);
    const user = await this.prisma.user.findFirst({ where: { id: userId, orgId }, select: { id: true } });
    const data = {
      ...connection,
      status: 'active' as const,
      isActive: true,
      credentials: this.secrets.seal(JSON.stringify(connection.credentials)),
      lastError: null,
      connectedById: user?.id ?? null,
      connectedAt: new Date(),
      syncedAt: null,
      syncError: null,
      webhookId: null,
      webhookSecret: null,
      webhookAttemptAt: null,
    };

    await this.prisma.$transaction(async (tx) => {
      await lockOrganization(tx, orgId);
      await tx.calendarConnection.updateMany({
        where: { orgId, isActive: true, provider: { not: connection.provider } },
        data: { isActive: false },
      });
      const saved = await tx.calendarConnection.upsert({ where, create: { orgId, ...data }, update: data, select: { id: true } });
      await tx.calendarMember.deleteMany({ where: { connectionId: saved.id } });
    });

    if (previous && connection.provider === 'calendly') {
      await this.revokeCalendly(this.unseal<CalendlyCredentials>(previous.credentials)?.refreshToken);
    }
  }

  async useActive<T>(orgId: string, run: (connection: UsableConnection, secret: string) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const connection = await this.prisma.calendarConnection.findFirst({
        where: { orgId, isActive: true },
        select: USAGE_FIELDS,
      });
      if (!connection) {
        throw new NotFoundException('No calendar is connected.');
      }
      if (connection.status === 'error') {
        throw new ConflictException(
          connection.lastError ?? `${PROVIDER_LABEL[connection.provider]} needs to be reconnected.`,
        );
      }

      try {
        return await this.withCredentials(orgId, connection, (secret) => run(connection, secret));
      } catch (error) {
        if (!(error instanceof CredentialsChanged)) throw error;
        if (attempt > 0) throw new ConflictException(error.message);
      }
    }
  }

  private async withCredentials<T>(
    orgId: string,
    connection: UsableConnection,
    run: (secret: string) => Promise<T>,
  ): Promise<T> {
    try {
      return await run(await this.secretFor(connection));
    } catch (error) {
      if (!(error instanceof ProviderHttpError)) throw error;
      if (!error.credentialRejected) throw new BadGatewayException(error.message);

      const label = PROVIDER_LABEL[connection.provider];
      const message = `${label} no longer accepts this connection. Reconnect ${label} to continue.`;
      const parked = await this.prisma.calendarConnection.updateMany({
        where: { id: connection.id, orgId, credentials: connection.credentials },
        data: { status: 'error', lastError: message },
      });
      if (parked.count === 0) throw new CredentialsChanged(message);
      throw new ConflictException(message);
    }
  }

  private async secretFor(connection: UsableConnection): Promise<string> {
    if (connection.provider === 'cal') {
      return this.requireCredentials<CalCredentials>(connection.credentials).apiKey;
    }

    const credentials = this.requireCredentials<CalendlyCredentials>(connection.credentials);
    const expiresAt = connection.tokenExpiresAt?.getTime() ?? 0;
    if (expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
      return credentials.accessToken;
    }

    let pending = this.refreshes.get(connection.id);
    if (!pending) {
      pending = this.refreshCalendly(connection, credentials.refreshToken).finally(() =>
        this.refreshes.delete(connection.id),
      );
      this.refreshes.set(connection.id, pending);
    }
    return pending;
  }

  private async refreshCalendly(connection: UsableConnection, refreshToken: string): Promise<string> {
    let grant: CalendlyGrant;
    try {
      grant = await this.calendly.refresh(refreshToken);
    } catch (error) {
      if (error instanceof ProviderHttpError && error.status === 400) {
        throw new ProviderHttpError(error.provider, 401, error.message);
      }
      throw error;
    }

    const credentials: CalendlyCredentials = { accessToken: grant.accessToken, refreshToken: grant.refreshToken };
    await this.prisma.calendarConnection.updateMany({
      where: { id: connection.id, credentials: connection.credentials },
      data: { credentials: this.secrets.seal(JSON.stringify(credentials)), tokenExpiresAt: grant.expiresAt },
    });
    return grant.accessToken;
  }

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

  private async removeWebhook(connection: UsableConnection): Promise<void> {
    if (!connection.webhookId || connection.status !== 'active') return;
    try {
      const secret = await this.secretFor(connection);
      if (connection.provider === 'calendly') await this.calendly.deleteWebhook(secret, connection.webhookId);
      else await this.cal.deleteWebhook(secret, connection.webhookId);
    } catch (error) {
      this.logger.warn(`${PROVIDER_LABEL[connection.provider]} webhook removal failed: ${(error as Error).message}`);
    }
  }

  private async revokeCalendly(token: string | undefined): Promise<void> {
    if (!token || !this.calendly.configured) return;
    try {
      await this.calendly.revoke(token);
    } catch (error) {
      this.logger.warn(`Calendly token revocation failed: ${(error as Error).message}`);
    }
  }

  private requireCredentials<T>(sealed: string): T {
    if (!this.secrets.enabled) {
      throw new ServiceUnavailableException(CALENDAR_UNAVAILABLE);
    }
    const credentials = this.unseal<T>(sealed);
    if (!credentials) {
      throw new ConflictException('The stored calendar credentials cannot be read. Reconnect the calendar.');
    }
    return credentials;
  }

  private unseal<T>(sealed: string): T | null {
    if (!this.secrets.enabled) return null;
    try {
      return JSON.parse(this.secrets.open(sealed)) as T;
    } catch {
      return null;
    }
  }
}

function splitName(name: string, email: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/).filter((part) => part && !part.includes('@'));
  if (parts.length === 0) {
    return { firstName: email.split('@')[0].slice(0, 100), lastName: '' };
  }
  return { firstName: parts[0].slice(0, 100), lastName: parts.slice(1).join(' ').slice(0, 100) };
}

function toView(connection: ConnectionSummary) {
  return {
    status: connection.status,
    accountEmail: connection.accountEmail,
    accountName: connection.accountName,
    workspaceType: connection.workspaceType,
    workspaceName: connection.workspaceName,
    workspaceRole: connection.workspaceRole,
    connectedAt: connection.connectedAt,
    lastError: connection.lastError,
  };
}

async function lockOrganization(tx: Prisma.TransactionClient, orgId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${orgId}::uuid FOR UPDATE`;
}
