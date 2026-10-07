import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import type { AuthContext } from '../auth/types';
import { CurrentUser } from '../common/decorators/auth.decorators';
import { OwnerGuard } from '../common/guards/owner.guard';
import { SessionGuard } from '../common/guards/session.guard';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { thresholdsSchema, type ThresholdsInput } from './lead-scoring';
import { LeadScoringService, type Qualification } from './lead-scoring.service';

/**
 * Owner-only controls for lead temperature. Scoring itself is automatic (the
 * Telnyx Insight webhook); these are the office's thresholds and a way to
 * classify a call recorded before the Insight was in place.
 *
 * The organization always comes from the session — no route takes one.
 */
@Controller('api/lead-scoring')
@UseGuards(SessionGuard, OwnerGuard)
export class LeadScoringController {
  constructor(private readonly scoring: LeadScoringService) {}

  @Get('settings')
  async settings(@CurrentUser() auth: AuthContext) {
    const t = await this.scoring.getThresholds(auth.organizationId);
    return { hotThreshold: t.hot, warmThreshold: t.warm };
  }

  @Put('settings')
  async saveSettings(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(thresholdsSchema, 'Invalid thresholds')) body: ThresholdsInput,
  ) {
    const t = await this.scoring.setThresholds(auth.organizationId, body);
    return { hotThreshold: t.hot, warmThreshold: t.warm };
  }

  @Post('calls/:id/classify')
  @HttpCode(HttpStatus.OK)
  classify(
    @CurrentUser() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<Qualification> {
    return this.scoring.classifyCall(auth.organizationId, id);
  }
}
