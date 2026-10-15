import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { AppError } from '@/common/errors/app-error';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import {
  ChangesQueryDto,
  CompleteOAuthDto,
  CreateSheetSourceDto,
  EnableSheetDto,
  ResolveChangesDto,
  ReviewQueryDto,
  RowIdsDto,
  SPREADSHEET_ID,
  SaveMappingDto,
} from './dto/sheets.dto';
import { GoogleConnectionsService, type SessionIdentity } from './google-connections.service';
import { ImportReviewEnabledGuard, SheetsEnabledGuard } from './import-enabled.guard';
import { SheetReviewService } from './sheet-review.service';
import { SheetSourcesService } from './sheet-sources.service';

const identity = (auth: AuthContext): SessionIdentity => ({
  organizationId: auth.organizationId,
  userId: auth.userId,
  sessionId: auth.sessionId,
});

@Controller('integrations/google-sheets')
@UseGuards(SheetsEnabledGuard)
export class GoogleSheetsController {
  constructor(
    private readonly connections: GoogleConnectionsService,
    private readonly sources: SheetSourcesService,
  ) {}

  @Get('config')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  config() {
    return this.connections.publicConfig();
  }

  @Post('oauth/start')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  start(@CurrentAuth() auth: AuthContext) {
    return this.connections.start(identity(auth));
  }

  @Post('oauth/complete')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  complete(@CurrentAuth() auth: AuthContext, @Body() body: CompleteOAuthDto) {
    return this.connections.complete(identity(auth), body.code, body.state);
  }

  @Get('connections')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  async list(@CurrentAuth() auth: AuthContext) {
    return { connections: await this.connections.list(auth.organizationId) };
  }

  @Delete('connections/:id')
  @HttpCode(204)
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  async disconnect(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.connections.disconnect(identity(auth), id);
  }

  @Get('connections/:id/spreadsheets/:spreadsheetId')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  inspect(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('spreadsheetId') spreadsheetId: string) {
    if (!SPREADSHEET_ID.test(spreadsheetId)) throw new AppError('VALIDATION_ERROR', 'Not a Google spreadsheet id');
    return this.connections.inspectSpreadsheet(auth.organizationId, id, spreadsheetId);
  }

  @Get('sources')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  async sourcesList(@CurrentAuth() auth: AuthContext) {
    return { sources: await this.sources.list(auth.organizationId) };
  }

  @Post('sources')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  create(@CurrentAuth() auth: AuthContext, @Body() body: CreateSheetSourceDto) {
    return this.sources.create(identity(auth), body);
  }

  @Get('sources/:id/preview')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  preview(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.sources.preview(auth.organizationId, id);
  }

  @Put('sources/:id/mapping')
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  saveMapping(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: SaveMappingDto) {
    return this.sources.saveMapping(identity(auth), id, body);
  }

  @Post('sources/:id/enable')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  enable(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: EnableSheetDto) {
    return this.sources.enable(identity(auth), id, body);
  }

  @Post('sources/:id/pause')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  pause(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.sources.pause(identity(auth), id);
  }

  @Delete('sources/:id')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  remove(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.sources.remove(identity(auth), id);
  }

  @Post('sources/:id/sync')
  @HttpCode(202)
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  sync(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.sources.syncNow(identity(auth), id);
  }

  @Get('sources/:id/runs')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  async runs(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return { runs: await this.sources.runs(auth.organizationId, id) };
  }
}

/** Imported leads waiting for the owner, from Google Sheets and from file uploads. */
@Controller('integrations/google-sheets/review')
@UseGuards(ImportReviewEnabledGuard)
export class ImportReviewController {
  constructor(
    private readonly sources: SheetSourcesService,
    private readonly reviews: SheetReviewService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.LEAD_IMPORT)
  review(@CurrentAuth() auth: AuthContext, @Query() q: ReviewQueryDto) {
    return this.sources.review(auth.organizationId, q);
  }

  @Post('approve')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.LEAD_IMPORT)
  approve(@CurrentAuth() auth: AuthContext, @Body() body: RowIdsDto) {
    return this.reviews.approve(identity(auth), body.rowIds);
  }

  @Post('reject')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.LEAD_IMPORT)
  reject(@CurrentAuth() auth: AuthContext, @Body() body: RowIdsDto) {
    return this.reviews.reject(identity(auth), body.rowIds);
  }

  @Get('changes')
  @RequirePermissions(PERMISSIONS.LEAD_IMPORT)
  changes(@CurrentAuth() auth: AuthContext, @Query() q: ChangesQueryDto) {
    return this.reviews.changes(auth.organizationId, q);
  }

  @Post('changes/resolve')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.LEAD_IMPORT)
  resolve(@CurrentAuth() auth: AuthContext, @Body() body: ResolveChangesDto) {
    return this.reviews.resolve(identity(auth), body.rowIds, body.action);
  }
}
