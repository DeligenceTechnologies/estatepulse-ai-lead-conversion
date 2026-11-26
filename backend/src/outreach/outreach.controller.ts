import { Body, CanActivate, Controller, Get, HttpCode, Injectable, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import type { AuthContext } from '@/auth/auth.types';
import { httpError } from '@/common/errors/app-error';
import type { IntegrationEnv } from '@/common/utils/interface';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { RescheduleDto } from './outreach.dto';
import { OutreachService } from './outreach.service';

/** Switched off, every /outreach route answers 404. */
@Injectable()
class OutreachSchedulingEnabledGuard implements CanActivate {
  constructor(private readonly config: ConfigService<IntegrationEnv, true>) {}

  canActivate(): boolean {
    if (!this.config.get('OUTREACH_SCHEDULING_ENABLED', { infer: true })) {
      throw httpError(404, 'OUTREACH_SCHEDULING_DISABLED', 'Outreach scheduling is not enabled on this server.');
    }
    return true;
  }
}

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
