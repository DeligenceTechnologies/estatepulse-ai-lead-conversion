import { Body, Controller, Get, HttpCode, Post, Query, Req, UseGuards } from '@nestjs/common';
import { OwnerGuard } from '../../common/guards/owner.guard';
import { SessionGuard, type SessionRequest } from '../../common/guards/session.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import {
  changesQuerySchema,
  decideSchema,
  resolveSchema,
  reviewQuerySchema,
  type ChangesQuery,
  type DecideBody,
  type ResolveBody,
  type ReviewQuery,
} from './schemas';
import { SheetReviewService } from './sheet-review.service';
import { identity } from './sheet-sources.controller';
import { SheetSourcesService } from './sheet-sources.service';
import { ImportReviewEnabledGuard } from './sheets-enabled.guard';

/**
 * The import review queue: leads from Google Sheets AND uploaded files, waiting
 * for the owner. Open while either import is switched on. Owner-only; the
 * organization always comes from the session, never from the request — a row id
 * from another organization is simply not found, and is reported as skipped.
 *
 * The path keeps its original prefix (google-sheets) so nothing that calls it
 * had to move.
 */
@Controller('api/integrations/google-sheets/review')
@UseGuards(SessionGuard, OwnerGuard, ImportReviewEnabledGuard)
export class ImportReviewController {
  constructor(
    private readonly sources: SheetSourcesService,
    private readonly reviews: SheetReviewService,
  ) {}

  @Get()
  review(@Req() req: SessionRequest, @Query(new ZodValidationPipe(reviewQuerySchema, 'Invalid review query')) q: ReviewQuery) {
    return this.sources.review(req.auth.organizationId, q);
  }

  /** Approve up to 500 pending rows. Lifts the import pause only where nothing else holds the lead. */
  @Post('approve')
  @HttpCode(200)
  approve(@Req() req: SessionRequest, @Body(new ZodValidationPipe(decideSchema, 'Invalid approval')) body: DecideBody) {
    return this.reviews.approve(identity(req), body.rowIds);
  }

  /** Reject up to 500 pending rows: the leads close and stay paused. */
  @Post('reject')
  @HttpCode(200)
  reject(@Req() req: SessionRequest, @Body(new ZodValidationPipe(decideSchema, 'Invalid rejection')) body: DecideBody) {
    return this.reviews.reject(identity(req), body.rowIds);
  }

  /** Reviewed rows the sheet has changed since, with a field-by-field diff. */
  @Get('changes')
  changes(@Req() req: SessionRequest, @Query(new ZodValidationPipe(changesQuerySchema, 'Invalid changes query')) q: ChangesQuery) {
    return this.reviews.changes(req.auth.organizationId, q);
  }

  /** Apply the sheet's new values to the leads, or keep them as reviewed. */
  @Post('changes/resolve')
  @HttpCode(200)
  resolve(@Req() req: SessionRequest, @Body(new ZodValidationPipe(resolveSchema, 'Invalid resolution')) body: ResolveBody) {
    return this.reviews.resolve(identity(req), body.rowIds, body.action);
  }
}
