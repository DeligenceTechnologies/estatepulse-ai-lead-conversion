import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { OwnerGuard } from '../../common/guards/owner.guard';
import { SessionGuard, type SessionRequest } from '../../common/guards/session.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import {
  GoogleConnectionsService,
  type GoogleConnectionDTO,
  type SessionIdentity,
  type SpreadsheetInspectionDTO,
} from './google-connections.service';
import { completeOAuthSchema, spreadsheetIdSchema, type CompleteOAuthBody } from './schemas';
import { SheetsEnabledGuard } from './sheets-enabled.guard';

/**
 * Connecting a Google account for spreadsheet import.
 *
 * Owner-only, like the office calendar. The organization, user and session are
 * NEVER parameters: they come from SessionGuard, which resolved them from the
 * presented token and organization_members on this request. That is also what
 * the OAuth state is checked against on completion.
 *
 * There is deliberately no callback route here. Google redirects to a static
 * page on the app's own origin, which passes the code to the tab that started
 * the flow; that tab POSTs it to /oauth/complete on its own session. So a code
 * never appears in an API URL or access log, and only the session that began
 * an authorization can finish it.
 */
@Controller('api/integrations/google-sheets')
@UseGuards(SessionGuard, OwnerGuard, SheetsEnabledGuard)
export class GoogleSheetsController {
  constructor(private readonly connections: GoogleConnectionsService) {}

  @Get('config')
  config() {
    return this.connections.publicConfig();
  }

  @Post('oauth/start')
  @HttpCode(200)
  start(@Req() req: SessionRequest): { authorizeUrl: string; state: string } {
    return this.connections.start(identity(req));
  }

  @Post('oauth/complete')
  @HttpCode(200)
  complete(
    @Req() req: SessionRequest,
    @Body(new ZodValidationPipe(completeOAuthSchema, 'Invalid Google authorization')) body: CompleteOAuthBody,
  ): Promise<GoogleConnectionDTO> {
    return this.connections.complete(identity(req), body.code, body.state);
  }

  @Get('connections')
  async list(@Req() req: SessionRequest): Promise<{ connections: GoogleConnectionDTO[] }> {
    return { connections: await this.connections.list(req.auth.organizationId) };
  }

  @Delete('connections/:id')
  @HttpCode(204)
  async disconnect(@Req() req: SessionRequest, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.connections.disconnect(identity(req), id);
  }

  @Get('connections/:id/spreadsheets/:spreadsheetId')
  inspect(
    @Req() req: SessionRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('spreadsheetId', new ZodValidationPipe(spreadsheetIdSchema, 'Invalid spreadsheet id')) spreadsheetId: string,
  ): Promise<SpreadsheetInspectionDTO> {
    return this.connections.inspectSpreadsheet(req.auth.organizationId, id, spreadsheetId);
  }
}

function identity(req: SessionRequest): SessionIdentity {
  return { organizationId: req.auth.organizationId, userId: req.auth.userId, sessionId: req.sessionId };
}
