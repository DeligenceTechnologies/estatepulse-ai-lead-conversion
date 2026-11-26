import { Controller, Delete, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import type { AuthContext } from '@/auth/auth.types';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { CALENDAR_ROUTE } from '../calendar.types';
import { CalendarConnectionService } from './calendar-connection.service';

/** The organization's calendar connection (Settings → Calendar). Changes need "Edit organization settings". */
@Controller(CALENDAR_ROUTE)
export class CalendarConnectionController {
  constructor(private readonly connections: CalendarConnectionService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ORGANIZATION_READ)
  status(@CurrentAuth() auth: AuthContext) {
    return this.connections.status(auth.organizationId);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSIONS.ORGANIZATION_UPDATE)
  disconnect(@CurrentAuth() auth: AuthContext) {
    return this.connections.disconnect(auth.organizationId);
  }
}
