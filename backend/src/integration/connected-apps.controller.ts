import { Controller, Get } from '@nestjs/common';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { ConnectedAppsService } from './connected-apps.service';

/**
 * The sidebar's Connected apps: open to every signed-in user, because a broken connection affects
 * everyone's work. Accounts show only with integration.read, and Reconnect only with integration.update.
 */
@Controller('v1/integrations')
export class ConnectedAppsController {
  constructor(private readonly apps: ConnectedAppsService) {}

  @Get('status')
  status(@CurrentAuth() auth: AuthContext) {
    return this.apps.list(auth);
  }
}
