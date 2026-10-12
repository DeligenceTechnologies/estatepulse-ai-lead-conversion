import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { OwnerGuard } from '../../common/guards/owner.guard';
import { SessionGuard, type SessionRequest } from '../../common/guards/session.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { SessionIdentity } from './google-connections.service';
import {
  changesQuerySchema,
  createSourceSchema,
  decideSchema,
  resolveSchema,
  reviewQuerySchema,
  saveMappingSchema,
  type ChangesQuery,
  type CreateSourceBody,
  type DecideBody,
  type ResolveBody,
  type ReviewQuery,
  type SaveMappingBody,
} from './schemas';
import { SheetReviewService } from './sheet-review.service';
import { SheetSourcesService } from './sheet-sources.service';
import { SheetsEnabledGuard } from './sheets-enabled.guard';

/**
 * Spreadsheet sources and the import review queue. Owner-only; the organization
 * always comes from the session, never from the request — a row id from another
 * organization is simply not found, and is reported as skipped.
 */
@Controller('api/integrations/google-sheets')
@UseGuards(SessionGuard, OwnerGuard, SheetsEnabledGuard)
export class SheetSourcesController {
  constructor(
    private readonly sources: SheetSourcesService,
    private readonly reviews: SheetReviewService,
  ) {}

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

  @Post('sources/:id/enable')
  @HttpCode(200)
  enable(@Req() req: SessionRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.sources.enable(identity(req), id);
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

  @Get('review')
  review(
    @Req() req: SessionRequest,
    @Query(new ZodValidationPipe(reviewQuerySchema, 'Invalid review query')) q: ReviewQuery,
  ) {
    return this.sources.review(req.auth.organizationId, q);
  }

  /** Approve up to 500 pending rows. Lifts the import pause only where nothing else holds the lead. */
  @Post('review/approve')
  @HttpCode(200)
  approve(@Req() req: SessionRequest, @Body(new ZodValidationPipe(decideSchema, 'Invalid approval')) body: DecideBody) {
    return this.reviews.approve(identity(req), body.rowIds);
  }

  /** Reject up to 500 pending rows: the leads close and stay paused. */
  @Post('review/reject')
  @HttpCode(200)
  reject(@Req() req: SessionRequest, @Body(new ZodValidationPipe(decideSchema, 'Invalid rejection')) body: DecideBody) {
    return this.reviews.reject(identity(req), body.rowIds);
  }

  /** Reviewed rows the sheet has changed since, with a field-by-field diff. */
  @Get('review/changes')
  changes(@Req() req: SessionRequest, @Query(new ZodValidationPipe(changesQuerySchema, 'Invalid changes query')) q: ChangesQuery) {
    return this.reviews.changes(req.auth.organizationId, q);
  }

  /** Apply the sheet's new values to the leads, or keep them as reviewed. */
  @Post('review/changes/resolve')
  @HttpCode(200)
  resolve(@Req() req: SessionRequest, @Body(new ZodValidationPipe(resolveSchema, 'Invalid resolution')) body: ResolveBody) {
    return this.reviews.resolve(identity(req), body.rowIds, body.action);
  }
}

function identity(req: SessionRequest): SessionIdentity {
  return { organizationId: req.auth.organizationId, userId: req.auth.userId, sessionId: req.sessionId };
}
