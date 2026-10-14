import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import { DEFAULT_WORKING_HOURS, type WorkingDay, type WorkingDayDto } from '@/common/utils/working-hours';
import { isTimeZone } from '@/common/utils/zoned-time';
import { DEFAULT_ROLES } from '@/role/permissions';
import { UserService } from '@/user/user.service';
import { PROVIDER_LABEL, type CalendarMemberView, type WeeklySchedule, type WorkspaceRole } from '../calendar.types';
import { CalendarAccessService } from '../connection/calendar-access.service';
import { ProviderHttpError } from '../providers/provider-http';
import { SchedulingProvider } from '../providers/scheduling-provider';
import { CalendarSyncService } from '../sync/calendar-sync.service';
import { findLinkedUsers } from './linked-users';
import { readWeeklySchedule, scheduleToWorkingHours } from './schedule-to-working-hours';

const MEMBER_FIELDS = {
  externalId: true,
  name: true,
  email: true,
  role: true,
  timezone: true,
  username: true,
  schedulingUrl: true,
  schedule: true,
} as const;

/**
 * The people in the connected calendar workspace, and turning one of them into
 * an EstatePulse agent.
 */
@Injectable()
export class CalendarMembersService {
  private readonly logger = new Logger(CalendarMembersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: CalendarSyncService,
    private readonly access: CalendarAccessService,
    private readonly provider: SchedulingProvider,
    private readonly users: UserService,
  ) {}

  /** Members as last synced, each with the EstatePulse user they match by email. */
  async list(orgId: string): Promise<CalendarMemberView[]> {
    const connection = await this.sync.freshConnection(orgId);
    const members = await this.prisma.calendarMember.findMany({
      where: { connectionId: connection.id },
      select: MEMBER_FIELDS,
      orderBy: { name: 'asc' },
    });
    const users = await findLinkedUsers(this.prisma, orgId, members);
    return members.map((member) => {
      const user = users.get(member.email.toLowerCase());
      return {
        ...member,
        role: member.role as WorkspaceRole,
        schedule: readWeeklySchedule(member.schedule),
        userId: user?.id ?? null,
        userName: user?.name ?? null,
      };
    });
  }

  /**
   * Creates an agent from a calendar member. Reads the member live from the
   * provider, so someone removed from the calendar since the last sync cannot
   * be added. Their working hours and timezone come from their calendar when
   * it has them, else from the organization's defaults.
   */
  async addAsAgent(orgId: string, externalId: string) {
    const { provider, member, schedule } = await this.access.useActive(orgId, async (connection, secret) => {
      const members = await this.provider.members(connection, secret);
      const found = members.find((candidate) => candidate.externalId === externalId) ?? null;
      return {
        provider: connection.provider,
        member: found,
        schedule: found ? await this.readSchedule(connection, secret, found.externalId) : null,
      };
    });
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

    const orgHours = (settings?.workingHours as unknown as WorkingDay[] | null | undefined) ?? null;
    const calendarHours = schedule ? scheduleToWorkingHours(schedule, orgHours ?? DEFAULT_WORKING_HOURS) : null;
    // The hours are wall-clock in the schedule's own timezone, so that zone wins when the hours are theirs.
    const timezone = [calendarHours ? schedule?.timezone : null, member.timezone, settings?.timezone].find(isTimeZone);

    const { firstName, lastName } = splitName(member.name, email);
    const created = await this.users.create(
      {
        orgId,
        firstName,
        lastName,
        email,
        timezone,
        workingHours: ((calendarHours ?? orgHours) as WorkingDayDto[] | null) ?? undefined,
        roleIds: [agentRole.id],
      },
      provider,
    );

    return {
      user: { id: created.id, name: `${created.firstName} ${created.lastName}`.trim(), email: created.email },
      /** Where their working hours came from, so the UI can say so. */
      workingHoursFrom: calendarHours ? provider : 'organization',
      // TODO => production me uncomment
      // credentialsEmail: created.credentialsEmail,
    };
  }

  /**
   * Best effort: a schedule we cannot read only means the organization's hours
   * are used. A rejected credential still fails, so the connection is parked.
   */
  private async readSchedule(
    connection: Parameters<SchedulingProvider['memberSchedule']>[0],
    secret: string,
    memberId: string,
  ): Promise<WeeklySchedule | null> {
    try {
      return await this.provider.memberSchedule(connection, secret, memberId);
    } catch (error) {
      if (error instanceof ProviderHttpError && error.credentialRejected) throw error;
      this.logger.warn(
        `${PROVIDER_LABEL[connection.provider]} schedule unavailable for ${memberId}; using organization hours: ${(error as Error).message}`,
      );
      return null;
    }
  }
}

/** "Ada Lovelace" → Ada / Lovelace. Falls back to the email's local part when the calendar has no usable name. */
export function splitName(name: string, email: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/).filter((part) => part && !part.includes('@'));
  if (parts.length === 0) {
    return { firstName: email.split('@')[0].slice(0, 100), lastName: '' };
  }
  return { firstName: parts[0].slice(0, 100), lastName: parts.slice(1).join(' ').slice(0, 100) };
}
