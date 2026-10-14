import { Controller, Get } from '@nestjs/common';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import type { AuthContext } from '@/auth/auth.types';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { CALENDAR_ROUTE } from '../calendar.types';
import { MeetingTypesService } from './meeting-types.service';

@Controller(CALENDAR_ROUTE)
export class MeetingTypesController {
  constructor(private readonly meetingTypes: MeetingTypesService) {}

  @Get('event-types')
  @RequirePermissions(PERMISSIONS.ORGANIZATION_READ)
  list(@CurrentAuth() auth: AuthContext) {
    return this.meetingTypes.list(auth.organizationId);
  }
}
