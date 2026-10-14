import { Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import type { AuthContext } from '@/auth/auth.types';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { CALENDAR_ROUTE } from '../calendar.types';
import { CalendarAvailabilityService } from './calendar-availability.service';
import { AvailabilityQueryDto } from './dto/availability-query.dto';

@Controller(CALENDAR_ROUTE)
export class CalendarAvailabilityController {
  constructor(private readonly availability: CalendarAvailabilityService) {}

  @Get('availability')
  @RequirePermissions(PERMISSIONS.ORGANIZATION_READ)
  report(@CurrentAuth() auth: AuthContext, @Query() query: AvailabilityQueryDto) {
    return this.availability.report(auth.organizationId, query);
  }

  @Post('availability/sync')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.ORGANIZATION_READ)
  syncNow(@CurrentAuth() auth: AuthContext) {
    return this.availability.syncNow(auth.organizationId);
  }
}
