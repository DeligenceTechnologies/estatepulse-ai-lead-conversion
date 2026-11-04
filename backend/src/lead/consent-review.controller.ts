import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { ConsentReviewService } from './consent-review.service';
import { LeadIdsDto } from './dto/consent-review.dto';

/** Import Review's "Consent needed" tab: manual leads added without consent, held until the owner decides. */
@Controller('v1/leads/consent-review')
export class ConsentReviewController {
  constructor(private readonly review: ConsentReviewService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.LEAD_IMPORT)
  list(@CurrentAuth() auth: AuthContext) {
    return this.review.list(auth.organizationId);
  }

  @Post('approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.LEAD_IMPORT)
  approve(@CurrentAuth() auth: AuthContext, @Body() body: LeadIdsDto) {
    return this.review.approve(auth.organizationId, auth.userId, body.leadIds);
  }

  @Post('reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.LEAD_IMPORT)
  reject(@CurrentAuth() auth: AuthContext, @Body() body: LeadIdsDto) {
    return this.review.reject(auth.organizationId, auth.userId, body.leadIds);
  }
}
