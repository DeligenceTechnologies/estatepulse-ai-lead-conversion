import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import { OwnerGuard } from '../../common/guards/owner.guard';
import { SessionGuard, type SessionRequest } from '../../common/guards/session.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { SessionIdentity } from './google-connections.service';
import { createSourceSchema, enableSchema, saveMappingSchema, type CreateSourceBody, type EnableBody, type SaveMappingBody } from './schemas';
import { SheetSourcesService } from './sheet-sources.service';
import { SheetsEnabledGuard } from './sheets-enabled.guard';

/**
 * Spreadsheet sources. Owner-only; the organization always comes from the
 * session, never from the request — a source id from another organization is
 * simply not found. The review queue the sources feed is ImportReviewController,
 * which uploaded files feed too.
 */
@Controller('api/integrations/google-sheets')
@UseGuards(SessionGuard, OwnerGuard, SheetsEnabledGuard)
export class SheetSourcesController {
  constructor(private readonly sources: SheetSourcesService) {}

  @Get('sources')
  async list(@Req() req: SessionRequest) {
    return { sources: await this.sources.list(req.auth.organizationId) };
  }

  @Post('sources')
  @HttpCode(200)
  create(
    @Req() req: SessionRequest,
    @Body(new ZodValidationPipe(createSourceSchema, 'Invalid spreadsheet source')) body: CreateSourceBody,
  ) {
    return this.sources.create(identity(req), body);
  }

  @Get('sources/:id/preview')
  preview(@Req() req: SessionRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.sources.preview(req.auth.organizationId, id);
  }

  @Put('sources/:id/mapping')
  saveMapping(
    @Req() req: SessionRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(saveMappingSchema, 'Invalid mapping')) body: SaveMappingBody,
  ) {
    return this.sources.saveMapping(identity(req), id, body);
  }

  /** Switches the sheet on and runs its first import in this request; `approveRows` are approved as they land. */
  @Post('sources/:id/enable')
  @HttpCode(200)
  enable(
    @Req() req: SessionRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(enableSchema, 'Invalid approval')) body: EnableBody,
  ) {
    return this.sources.enable(identity(req), id, body);
  }

  @Post('sources/:id/pause')
  @HttpCode(200)
  pause(@Req() req: SessionRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.sources.pause(identity(req), id);
  }

  /** Archives the sheet; its leads stay (pending ones in Import Review). */
  @Delete('sources/:id')
  @HttpCode(200)
  remove(@Req() req: SessionRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.sources.remove(identity(req), id);
  }

  /** Queues a sync; 202 because the import runs in the background. */
  @Post('sources/:id/sync')
  @HttpCode(202)
  sync(@Req() req: SessionRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.sources.syncNow(identity(req), id);
  }

  @Get('sources/:id/runs')
  async runs(@Req() req: SessionRequest, @Param('id', ParseUUIDPipe) id: string) {
    return { runs: await this.sources.runs(req.auth.organizationId, id) };
  }
}

export function identity(req: SessionRequest): SessionIdentity {
  return { organizationId: req.auth.organizationId, userId: req.auth.userId, sessionId: req.sessionId };
}
