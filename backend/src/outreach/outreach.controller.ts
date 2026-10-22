import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import type { AuthContext } from '@/auth/auth.types';
import { OutreachSchedulingEnabledGuard } from '@/google-sheets/import-enabled.guard';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { RescheduleDto } from './outreach.dto';
import { OutreachService } from './outreach.service';

@Controller('outreach')
@UseGuards(OutreachSchedulingEnabledGuard)
export class OutreachController {
  constructor(private readonly outreach: OutreachService) {}

  @Get('config')
  @RequirePermissions(PERMISSIONS.LEAD_IMPORT)
  config(@CurrentAuth() auth: AuthContext) {
    return this.outreach.config(auth.organizationId);
  }

  @Get('batches')
  @RequirePermissions(PERMISSIONS.LEAD_IMPORT)
  list(@CurrentAuth() auth: AuthContext) {
    return this.outreach.list(auth.organizationId);
  }

  @Post('batches/:id/cancel')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.LEAD_IMPORT)
  cancel(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.outreach.cancel(auth, id);
  }

  @Post('batches/:id/reschedule')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.LEAD_IMPORT)
  reschedule(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: RescheduleDto) {
    return this.outreach.reschedule(auth, id, body);
  }
}
