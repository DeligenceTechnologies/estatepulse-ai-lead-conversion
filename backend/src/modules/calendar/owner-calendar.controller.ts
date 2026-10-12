import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/auth.decorators';
import { AppError } from '../../common/errors';
import { OwnerGuard } from '../../common/guards/owner.guard';
import { SessionGuard } from '../../common/guards/session.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { Inject } from '@nestjs/common';
import { TENANT_PRISMA, type GuardedPrisma } from '../../prisma/prisma.service';
import type { AuthContext } from '../../auth/types';
import { AppointmentsService } from './appointments.service';
import { AvailabilityService } from './availability.service';
import { CalendarConnectionsService } from './calendar-connections.service';
import { appointmentRangeSchema, type AppointmentRangeQuery } from './schemas';
import type { AppointmentDTO, AvailabilityDTO } from './types';

/** What the owner sees about one agent's calendar. */
interface AgentCalendarDTO {
  agentId: string;
  agentName: string;
  /**
   * The scheduling member this agent is, for whichever provider is connected,
   * or null when they are not on it.
   */
  schedulingUserId: string | null;
  /** Their public booking page, when they have one. */
  schedulingUrl: string | null;
  availability: AvailabilityDTO;
  upcoming: AppointmentDTO[];
}

/**
 * The owner's read-only view over the office's calendars, per agent.
 *
 * Read-only on purpose. The one thing an owner CAN act on — the office's
 * Calendly account itself — lives on OrganizationCalendarController; there is
 * nothing per-agent left to connect, because since the move to office-level
 * Calendly an agent has no connection of their own.
 *
 * OwnerGuard is declared after SessionGuard, which populates `req.auth` that
 * OwnerGuard then reads. The organization is always the session's — `agentId`
 * below is a filter within it, never a way to choose one.
 */
@Controller('api')
@UseGuards(SessionGuard, OwnerGuard)
export class OwnerCalendarController {
  constructor(
    private readonly appointments: AppointmentsService,
    private readonly availability: AvailabilityService,
    private readonly connections: CalendarConnectionsService,
    @Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma,
  ) {}

  /** Every appointment in the organization, filterable. */
  @Get('appointments')
  async list(
    @CurrentUser() auth: AuthContext,
    @Query(new ZodValidationPipe(appointmentRangeSchema, 'Invalid appointment filter'))
    query: AppointmentRangeQuery,
  ): Promise<AppointmentDTO[]> {
    return this.appointments.listInRange(auth.organizationId, query);
  }

  /**
   * One agent's working hours and upcoming appointments.
   *
   * Addressed by `users.id`, not `agent_profiles.id`, to match the existing
   * `PATCH /api/agents/:userId` — and because the roster DTO the UI already
   * holds carries the user id. The profile is resolved here instead.
   */
  @Get('agents/:userId/calendar')
  async agentCalendar(
    @CurrentUser() auth: AuthContext,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<AgentCalendarDTO> {
    // The office's calendar depends only on the organization, so it is read
    // alongside the profile rather than after everything else. It is awaited
    // where it always was — last — so a 404 or a failure of the reads below
    // answers exactly as before.
    const connection = this.connections.activeOrgRow(auth.organizationId);
    connection.catch(() => undefined);

    // Scoped by organization_id as well as user_id: a profile from another
    // office must be indistinguishable from one that does not exist, or the
    // 404-vs-200 difference leaks the roster.
    const profile = await this.prisma.agent_profiles.findFirst({
      where: { user_id: userId, organization_id: auth.organizationId },
      select: {
        id: true,
        display_name: true,
        calendly_user_uri: true,
        cal_user_id: true,
        calendly_url: true,
      },
    });
    // An owner has no agent_profiles row by design, so this is also the answer
    // for "show me the owner's calendar".
    if (!profile) throw new AppError('NOT_FOUND', 'This member has no agent profile');

    const agentId = profile.id;
    const [availability, upcoming] = await Promise.all([
      this.availability.get(auth.organizationId, agentId),
      this.appointments.upcomingForAgent(auth.organizationId, agentId),
    ]);

    // The scheduling IDENTITY, not a connection: since the office holds the one
    // account, what an owner needs to know per agent is whether that agent is
    // on it. Null is exactly "invited onto the office's team yet?", and it is
    // the difference between an agent whose bookings sync and one whose
    // bookings are skipped.
    //
    // Read for the CONNECTED provider only. An office that switched from
    // Calendly still has calendly_user_uri on every agent, and showing that as
    // linked would say the roster is fine when no booking can be attributed.
    const conn = await connection;
    const hostId = conn?.provider === 'cal' ? profile.cal_user_id : profile.calendly_user_uri;

    return {
      agentId: profile.id,
      agentName: profile.display_name,
      schedulingUserId: hostId == null ? null : String(hostId),
      schedulingUrl: profile.calendly_url,
      availability,
      upcoming,
    };
  }
}
