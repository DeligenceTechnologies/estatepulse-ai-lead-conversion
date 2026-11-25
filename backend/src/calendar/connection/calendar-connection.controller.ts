import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put } from '@nestjs/common';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import type { AuthContext } from '@/auth/auth.types';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { RequireFeature } from '@/billing/entitlements/require-feature.decorator';
import { FEATURES } from '@/billing/billing-plans';
import { CALENDAR_ROUTE } from '../calendar.types';
import { CalendarConnectionService } from './calendar-connection.service';
import { ActivateCalendarDto } from './dto/activate-calendar.dto';
import { CalWorkspaceDto } from './dto/cal-connect.dto';

/**
 * Connecting the organization's calendar (Settings → Calendar). Changes need "Edit organization settings".
 *
 * Calendly's consent screen runs in Nango Connect: the browser asks for a
 * session, then reports the connection id Nango assigned, which the server
 * checks was created for this organization before using it.
 */
@Controller(CALENDAR_ROUTE)
export class CalendarConnectionController {
  constructor(private readonly connections: CalendarConnectionService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ORGANIZATION_READ)
  status(@CurrentAuth() auth: AuthContext) {
    return this.connections.status(auth.organizationId);
  }

  // Connecting Calendly or Cal.com, and disconnecting: /connections/:provider/* (ConnectionsController).

  @Get('cal/teams')
  @RequirePermissions(PERMISSIONS.ORGANIZATION_READ)
  @RequireFeature(FEATURES.CALENDAR_INTEGRATION)
  calTeams(@CurrentAuth() auth: AuthContext) {
    return this.connections.listCalTeams(auth.organizationId);
  }

  /** Personal account (teamId null) or one of the owner's Cal.com teams. */
  @Put('cal/workspace')
  @RequirePermissions(PERMISSIONS.ORGANIZATION_UPDATE)
  @RequireFeature(FEATURES.CALENDAR_INTEGRATION)
  setCalWorkspace(@CurrentAuth() auth: AuthContext, @Body() dto: CalWorkspaceDto) {
    return this.connections.setCalWorkspace(auth.organizationId, auth.userId, dto.teamId ?? null);
  }

  @Post('activate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.ORGANIZATION_UPDATE)
  @RequireFeature(FEATURES.CALENDAR_INTEGRATION)
  activate(@CurrentAuth() auth: AuthContext, @Body() dto: ActivateCalendarDto) {
    return this.connections.activate(auth.organizationId, dto.provider);
  }
}
