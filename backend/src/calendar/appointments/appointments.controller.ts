import { Controller, Get, Query } from '@nestjs/common';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { AppointmentsService } from './appointments.service';
import { AppointmentRangeQuery } from './dto/appointment-range.query';

@Controller('appointments')
export class AppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.LEAD_READ)
  list(@CurrentAuth() auth: AuthContext, @Query() query: AppointmentRangeQuery) {
    return this.appointments.listInRange(auth.organizationId, query);
  }
}
