import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { OwnerGuard } from '../../common/guards/owner.guard';
import { SessionGuard, type SessionRequest } from '../../common/guards/session.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { CrmConnectionsService, type SessionIdentity } from './crm-connections.service';
import { CrmRegistry } from './crm-registry';
import { CrmSyncService } from './crm-sync.service';
import { completeOAuthSchema, runsQuerySchema, type CompleteOAuthBody, type RunsQuery } from './schemas';

/**
 * Connecting a CRM and watching it sync — `/api/integrations/crm/hubspot/...`.
 *
 * Owner-only, like Google Sheets and the office calendar. The organization,
 * user and session are NEVER parameters: they come from SessionGuard, which
 * resolved them from the presented token and organization_members on this
 * request — and that is also what an OAuth state is checked against on
 * completion. A run id from another organization is simply not found.
 *
 * The CRM is resolved AFTER the guards, so a caller who may not use this learns
 * nothing about which CRMs are switched on.
 *
 * There is deliberately no OAuth callback route: the CRM redirects to a static
 * page on the app's own origin, which passes the code to the tab that started
 * the flow, and that tab POSTs it to oauth/complete on its own session. A code
 * never appears in an API URL or access log, and only the session that began
 * an authorization can finish it.
 */
@Controller('api/integrations/crm/:provider')
@UseGuards(SessionGuard, OwnerGuard)
export class CrmController {
  constructor(
    private readonly registry: CrmRegistry,
    private readonly connections: CrmConnectionsService,
    private readonly sync: CrmSyncService,
  ) {}

  @Get('config')
  config(@Param('provider') provider: string) {
    const adapter = this.registry.get(provider);
    return { provider: adapter.provider, displayName: adapter.label.displayName, configured: adapter.isConfigured() };
  }

  @Get('status')
  status(@Req() req: SessionRequest, @Param('provider') provider: string) {
    return this.sync.status(this.registry.get(provider), req.auth.organizationId);
  }

  @Post('oauth/start')
  @HttpCode(200)
  start(@Req() req: SessionRequest, @Param('provider') provider: string) {
    return this.connections.start(this.registry.get(provider), identity(req));
  }

  @Post('oauth/complete')
  @HttpCode(200)
  async complete(
    @Req() req: SessionRequest,
    @Param('provider') provider: string,
    @Body(new ZodValidationPipe(completeOAuthSchema, 'Invalid authorization')) body: CompleteOAuthBody,
  ) {
    const adapter = this.registry.get(provider);
    await this.connections.complete(adapter, identity(req), body.code, body.state);
    // The answer first, then the import: the first page must not race the response.
    const status = await this.sync.status(adapter, req.auth.organizationId);
    this.sync.nudge();
    return status;
  }

  /** Start a complete re-read (or the first import). 202 with the new run; 200 with the one already in progress. */
  @Post('sync')
  async requestSync(@Req() req: SessionRequest, @Param('provider') provider: string, @Res({ passthrough: true }) res: Response) {
    const result = await this.sync.requestSync(this.registry.get(provider), identity(req));
    res.status(result.alreadyActive ? 200 : 202);
    return result;
  }

  @Get('runs')
  async runs(
    @Req() req: SessionRequest,
    @Param('provider') provider: string,
    @Query(new ZodValidationPipe(runsQuerySchema, 'Invalid query')) q: RunsQuery,
  ) {
    return { runs: await this.sync.runs(this.registry.get(provider), req.auth.organizationId, q.limit) };
  }

  @Get('runs/:runId')
  run(@Req() req: SessionRequest, @Param('provider') provider: string, @Param('runId', ParseUUIDPipe) runId: string) {
    return this.sync.run(this.registry.get(provider), req.auth.organizationId, runId);
  }

  /** Stop syncing and forget the grant. Imported leads are kept. */
  @Delete('connection')
  @HttpCode(204)
  async disconnect(@Req() req: SessionRequest, @Param('provider') provider: string): Promise<void> {
    await this.connections.disconnect(this.registry.get(provider), identity(req));
  }
}

function identity(req: SessionRequest): SessionIdentity {
  return { organizationId: req.auth.organizationId, userId: req.auth.userId, sessionId: req.sessionId };
}
