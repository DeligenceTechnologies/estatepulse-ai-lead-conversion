import { Body, Controller, Get, Put, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/auth.decorators';
import { AppError } from '../../common/errors';
import { SessionGuard } from '../../common/guards/session.guard';
import { UpstreamErrorInterceptor } from '../../common/interceptors/upstream-error.interceptor';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AuthContext } from '../../auth/types';
import { AppointmentsService } from './appointments.service';
import { AvailabilityService } from './availability.service';
import { CalendarConnectionsService } from './calendar-connections.service';
import { appointmentRangeSchema, putAvailabilitySchema, type PutAvailabilityBody } from './schemas';
import type { AppointmentDTO, AvailabilityDTO, CalendarStatusDTO } from './types';

/**
 * An agent's own calendar: their working hours, their appointments, and a
 * read-only view of where they stand in the office's Calendly.
 *
 * There is no connect, sync or disconnect here any more. Calendly belongs to
 * the ORGANIZATION now — one account, authorized once by the owner, from which
 * every member's bookings are read — so an agent has no token of their own to
 * offer or revoke. See OrganizationCalendarController.
 *
 * Working hours stay. They are not a Calendly concept: they are what the
 * assignment engine evaluates in the agent's own timezone to decide who is on
 * shift, and they would matter even with no calendar connected at all.
 *
 * A separate controller from AgentMeController, which states in its docblock
 * that it is read-only and nothing on it writes. That is a deliberate
 * invariant — the routes below write — so they live here rather than quietly
 * falsifying it.
 *
 * The two security properties of that controller are copied verbatim, because
 * they are what make this surface safe:
 *
 *  - There is no `:agentId` anywhere. The agent is always `auth.agentProfileId`,
 *    which SessionGuard resolved from organization_members and agent_profiles on
 *    THIS request, so there is nothing a caller can send to reach another
 *    agent's calendar.
 *  - An owner has no agent_profiles row by design, so `agentProfileId()` is also
 *    what keeps owners out of the agent surface — a role-string comparison would
 *    need updating the day roles grow.
 */
@Controller('api/agents/me')
@UseGuards(SessionGuard)
@UseInterceptors(UpstreamErrorInterceptor)
export class AgentCalendarController {
  constructor(
    private readonly connections: CalendarConnectionsService,
    private readonly availability: AvailabilityService,
    private readonly appointments: AppointmentsService,
  ) {}

  private agentProfileId(auth: AuthContext): string {
    if (!auth.agentProfileId) {
      throw new AppError('FORBIDDEN', 'This account has no agent profile');
    }
    return auth.agentProfileId;
  }

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  /**
   * Whether the office has connected Calendly, and whether this agent is on it.
   *
   * Carries nothing about the office's credentials — not the account, not the
   * token state, not the error. An agent cannot act on any of it, and the two
   * facts below are the ones that explain why their bookings do or do not
   * appear.
   */
  @Get('calendar')
  async status(@CurrentUser() auth: AuthContext): Promise<CalendarStatusDTO> {
    return this.connections.agentStatus(auth.organizationId, this.agentProfileId(auth));
  }

  // -------------------------------------------------------------------------
  // Availability
  // -------------------------------------------------------------------------

  @Get('availability')
  async getAvailability(@CurrentUser() auth: AuthContext): Promise<AvailabilityDTO> {
    return this.availability.get(auth.organizationId, this.agentProfileId(auth));
  }

  @Put('availability')
  async putAvailability(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(putAvailabilitySchema, 'Invalid working hours'))
    body: PutAvailabilityBody,
  ): Promise<AvailabilityDTO> {
    return this.availability.replace(auth.organizationId, this.agentProfileId(auth), body);
  }

  // -------------------------------------------------------------------------
  // Appointments
  // -------------------------------------------------------------------------

  @Get('appointments')
  async list(
    @CurrentUser() auth: AuthContext,
    @Query(new ZodValidationPipe(appointmentRangeSchema, 'Invalid date range'))
    query: { from?: Date; to?: Date; status?: string },
  ): Promise<AppointmentDTO[]> {
    // agentId is forced to the caller's own profile, never taken from the
    // query, so the filter cannot be turned into a way to read a colleague's
    // calendar.
    return this.appointments.listInRange(auth.organizationId, {
      ...query,
      agentId: this.agentProfileId(auth),
    });
  }
}
