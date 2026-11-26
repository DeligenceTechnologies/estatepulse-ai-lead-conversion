import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { ListRunsQueryDto } from '../dto/integrations.dto';
import { INTEGRATIONS_ROUTE } from '../integrations.constants';
import type { SyncRunView } from '../integrations.types';
import { SyncService } from './sync.service';

@Controller(`${INTEGRATIONS_ROUTE}/connections/:id`)
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  /**
   * Queues a sync and answers at once (202). When one is already queued or
   * running, that run is returned instead of starting a second.
   */
  @Post('sync')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  async trigger(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<{ run: SyncRunView; created: boolean }> {
    return this.sync.enqueue(auth.organizationId, id, 'manual', auth.userId);
  }

  @Get('sync-runs')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  runs(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() query: ListRunsQueryDto): Promise<SyncRunView[]> {
    return this.sync.runs(auth.organizationId, id, query.limit);
  }
}
