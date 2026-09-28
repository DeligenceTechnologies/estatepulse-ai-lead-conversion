import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/auth.decorators';
import { AppError } from '../../common/errors';
import { OwnerGuard } from '../../common/guards/owner.guard';
import { SessionGuard } from '../../common/guards/session.guard';
import { UpstreamErrorInterceptor } from '../../common/interceptors/upstream-error.interceptor';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AuthContext } from '../../auth/types';
import { CalendarConnectionsService } from './calendar-connections.service';
import { CalendarSyncService } from './calendar-sync.service';
import { CalendarEventTypesService } from './calendar-event-types.service';
import { CalendarRosterService } from './calendar-roster.service';
import {
  calConnectSchema,
  calKeySchema,
  type CalConnectBody,
  type CalKeyBody,
} from './schemas';
import type {
  CalComTeamOptionDTO,
  CalendarEventTypeDTO,
  CalendarMemberDTO,
  MemberSyncResultDTO,
  OrganizationCalendarStatusDTO,
  SyncResultDTO,
} from './types';

/**
 * The office's one scheduling connection — Calendly or Cal.com.
 *
 * Owner-only, and there is no agent-facing equivalent: the point of moving
 * scheduling to the organization is that exactly one person authorizes exactly
 * one account, and everybody else is invited into it on the provider's side.
 *
 * The two connect flows do not share a route, because they do not share a
 * shape. Calendly hands back a URL for a consent screen and finishes later, on
 * a callback; Cal.com takes a pasted key and finishes immediately, after a
 * separate step that lists the teams that key can see. Everything AFTER
 * connecting — status, sync, roster, event types — is one route each,
 * dispatching on whichever provider is live.
 *
 * The organization is NEVER a parameter here. It is `auth.organizationId`,
 * which SessionGuard resolved from organization_members on this request, so
 * there is nothing a caller can send to reach another office's calendar.
 * OwnerGuard is declared after SessionGuard because it reads the role that
 * SessionGuard put on the request.
 */
@Controller('api/organization/calendar')
@UseGuards(SessionGuard, OwnerGuard)
@UseInterceptors(UpstreamErrorInterceptor)
export class OrganizationCalendarController {
  constructor(
    private readonly connections: CalendarConnectionsService,
    private readonly sync: CalendarSyncService,
    private readonly roster: CalendarRosterService,
    private readonly eventTypes: CalendarEventTypesService,
  ) {}

  @Get()
  async status(@CurrentUser() auth: AuthContext): Promise<OrganizationCalendarStatusDTO> {
    return this.connections.status(auth.organizationId);
  }

  /**
   * Begin Calendly's OAuth flow.
   *
   * Returns the URL rather than redirecting: the SPA opens it in a popup, and a
   * 302 from an XHR would be followed by fetch and land nowhere useful.
   */
  @Post('connect')
  async connect(@CurrentUser() auth: AuthContext): Promise<{ authorizeUrl: string }> {
    return this.connections.startOAuth(auth.organizationId);
  }

  /**
   * Check a Cal.com API key and list the teams it can see.
   *
   * Writes nothing. It exists because one Cal.com user may belong to several
   * teams and only the office can say which one it books through — so the key
   * is checked first, the choice offered, and the connection created after.
   */
  @Post('cal/teams')
  @HttpCode(200)
  async calTeams(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(calKeySchema, 'Invalid Cal.com API key')) body: CalKeyBody,
  ): Promise<{ email: string; teams: CalComTeamOptionDTO[] }> {
    // auth is not passed down: this call touches Cal.com only and creates no
    // row, so there is no tenant state for it to reach. The guard above is what
    // makes it owner-only.
    void auth;
    return this.connections.verifyCalKey(body.apiKey);
  }

  /**
   * Connect Cal.com.
   *
   * Retires an active Calendly connection as a side effect — one office, one
   * live calendar. The appointments already synced from the old provider are
   * kept, because they happened.
   */
  @Post('cal/connect')
  async calConnect(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(calConnectSchema, 'Invalid Cal.com connection details'))
    body: CalConnectBody,
  ): Promise<OrganizationCalendarStatusDTO> {
    await this.connections.connectCalCom(auth.organizationId, body);
    return this.connections.status(auth.organizationId);
  }

  @Post('sync')
  async syncNow(@CurrentUser() auth: AuthContext): Promise<SyncResultDTO> {
    const conn = await this.connections.syncableOrgRow(auth.organizationId);
    if (!conn) throw new AppError('VALIDATION_ERROR', 'No connected calendar to sync');
    return this.sync.syncConnection(conn);
  }

  @Delete()
  @HttpCode(204)
  async disconnect(@CurrentUser() auth: AuthContext): Promise<void> {
    await this.connections.disconnect(auth.organizationId);
  }

  // -------------------------------------------------------------------------
  // The Calendly roster
  // -------------------------------------------------------------------------

  /** Who is on the office's scheduling team, and which agent each one is here. */
  @Get('members')
  async members(@CurrentUser() auth: AuthContext): Promise<CalendarMemberDTO[]> {
    return this.roster.listMembers(auth.organizationId);
  }

  /**
   * Match the Calendly roster to the agent roster.
   *
   * A POST because it writes the agent's host link, which decides whose
   * appointment a booking becomes. Deliberately not folded into GET members:
   * opening a settings screen must not be able to change that.
   */
  @Post('members/sync')
  async syncMembers(@CurrentUser() auth: AuthContext): Promise<MemberSyncResultDTO> {
    return this.roster.syncMembers(auth.organizationId);
  }

  /** The office's bookable pages, round-robin ones first. */
  @Get('event-types')
  async listEventTypes(@CurrentUser() auth: AuthContext): Promise<CalendarEventTypeDTO[]> {
    return this.eventTypes.list(auth.organizationId);
  }
}
