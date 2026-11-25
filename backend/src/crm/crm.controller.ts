import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import type { SessionIdentity } from './crm-connections.service';
import { CrmRegistry } from './crm-registry';
import { CrmRowEditService } from './crm-row-edit.service';
import { CrmSyncService } from './crm-sync.service';
import { CrmRunsQueryDto, EditCrmContactDto } from './dto/crm.dto';

const identity = (auth: AuthContext): SessionIdentity => ({
  organizationId: auth.organizationId,
  userId: auth.userId,
  sessionId: auth.sessionId,
});

/**
 * Watching a connected CRM sync: `/integrations/crm/hubspot/...`.
 *
 * The organization, user and session are never parameters: they come from the
 * authenticated session. The CRM is resolved after the permission guard, so a
 * caller who may not use this learns nothing about which CRMs are switched on.
 */
@Controller('integrations/crm/:provider')
export class CrmController {
  constructor(
    private readonly registry: CrmRegistry,
    private readonly sync: CrmSyncService,
    private readonly edits: CrmRowEditService,
  ) {}

  /** Corrects a contact still waiting in Import Review: written to the CRM, then re-read so the lead follows. */
  @Patch('review/rows/:rowId')
  @RequirePermissions(PERMISSIONS.LEAD_IMPORT)
  editRow(
    @CurrentAuth() auth: AuthContext,
    @Param('provider') provider: string,
    @Param('rowId', ParseUUIDPipe) rowId: string,
    @Body() body: EditCrmContactDto,
  ) {
    return this.edits.edit(identity(auth), this.registry.get(provider), rowId, body);
  }

  @Get('config')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  config(@Param('provider') provider: string) {
    const adapter = this.registry.get(provider);
    return { provider: adapter.provider, displayName: adapter.label.displayName, configured: adapter.isConfigured() };
  }

  @Get('status')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  status(@CurrentAuth() auth: AuthContext, @Param('provider') provider: string) {
    return this.sync.status(this.registry.get(provider), auth.organizationId);
  }

  // Connecting and disconnecting: /connections/:provider/* (ConnectionsController).

  /** Start a complete re-read (or the first import). 202 with the new run; 200 with the one already in progress. */
  @Post('sync')
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  async requestSync(@CurrentAuth() auth: AuthContext, @Param('provider') provider: string, @Res({ passthrough: true }) res: Response) {
    const result = await this.sync.requestSync(this.registry.get(provider), identity(auth));
    res.status(result.alreadyActive ? 200 : 202);
    return result;
  }

  @Get('runs')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  async runs(@CurrentAuth() auth: AuthContext, @Param('provider') provider: string, @Query() q: CrmRunsQueryDto) {
    return { runs: await this.sync.runs(this.registry.get(provider), auth.organizationId, q.limit ?? 20) };
  }

  @Get('runs/:runId')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  run(@CurrentAuth() auth: AuthContext, @Param('provider') provider: string, @Param('runId', ParseUUIDPipe) runId: string) {
    return this.sync.run(this.registry.get(provider), auth.organizationId, runId);
  }
}
