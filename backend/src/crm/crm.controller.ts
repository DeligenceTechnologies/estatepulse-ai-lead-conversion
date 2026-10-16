import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { CrmConnectionsService, type SessionIdentity } from './crm-connections.service';
import { CrmRegistry } from './crm-registry';
import { CrmSyncService } from './crm-sync.service';
import { CompleteCrmOAuthDto, CrmRunsQueryDto } from './dto/crm.dto';

const identity = (auth: AuthContext): SessionIdentity => ({
  organizationId: auth.organizationId,
  userId: auth.userId,
  sessionId: auth.sessionId,
});

/**
 * Connecting a CRM and watching it sync: `/integrations/crm/hubspot/...`.
 *
 * The organization, user and session are never parameters: they come from the
 * authenticated session, which is also what an OAuth state is checked against.
 * The CRM is resolved after the permission guard, so a caller who may not use
 * this learns nothing about which CRMs are switched on.
 *
 * There is no OAuth callback route: the CRM redirects to a static page on the
 * app's own origin, which passes the code to the tab that started the flow, and
 * that tab POSTs it to oauth/complete on its own session.
 */
@Controller('integrations/crm/:provider')
export class CrmController {
  constructor(
    private readonly registry: CrmRegistry,
    private readonly connections: CrmConnectionsService,
    private readonly sync: CrmSyncService,
  ) {}

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

  @Post('oauth/start')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  start(@CurrentAuth() auth: AuthContext, @Param('provider') provider: string) {
    return this.connections.start(this.registry.get(provider), identity(auth));
  }

  @Post('oauth/complete')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  async complete(@CurrentAuth() auth: AuthContext, @Param('provider') provider: string, @Body() body: CompleteCrmOAuthDto) {
    const adapter = this.registry.get(provider);
    await this.connections.complete(adapter, identity(auth), body.code, body.state);
    // The answer first, then the import: the first page must not race the response.
    const status = await this.sync.status(adapter, auth.organizationId);
    this.sync.nudge();
    return status;
  }

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

  /** Stop syncing and forget the grant. Imported leads are kept. */
  @Delete('connection')
  @HttpCode(204)
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  async disconnect(@CurrentAuth() auth: AuthContext, @Param('provider') provider: string): Promise<void> {
    await this.connections.disconnect(this.registry.get(provider), identity(auth));
  }
}
