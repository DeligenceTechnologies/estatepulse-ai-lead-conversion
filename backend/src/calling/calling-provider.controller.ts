import { Body, Controller, Get, Put, Query, UseGuards } from '@nestjs/common';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { SwitchCallingProviderDto } from '@/retell/dto/retell.dto';
import { RetellEnabledGuard } from '@/retell/retell-enabled.guard';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { CallingSwitchService } from './calling-switch.service';

/** Which provider the organization calls through, and the switch between Telnyx and Retell. */
@UseGuards(RetellEnabledGuard)
@Controller('calling-provider')
export class CallingProviderController {
  constructor(private readonly switcher: CallingSwitchService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  current(@CurrentAuth() auth: AuthContext) {
    return this.switcher.current(auth.organizationId);
  }

  @Get('switch-preview')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  preview(@CurrentAuth() auth: AuthContext, @Query() query: SwitchCallingProviderDto) {
    return this.switcher.preview(auth.organizationId, query.provider);
  }

  @Put()
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  switch(@CurrentAuth() auth: AuthContext, @Body() body: SwitchCallingProviderDto) {
    return this.switcher.switch(auth.organizationId, body.provider, auth.userId);
  }
}
