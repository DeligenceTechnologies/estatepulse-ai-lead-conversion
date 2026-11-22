import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { DealDto } from './dto/source-roi.dto';
import { SourceRoiEnabledGuard } from './source-roi-enabled.guard';
import { SourceRoiService } from './source-roi.service';

/**
 * How a lead's deal ended: `/v1/leads/:leadId/deal`. Beside the lead routes in
 * the URL but owned by Source ROI, so it disappears with the flag. The same
 * permission as editing a lead.
 */
@Controller('v1/leads')
@UseGuards(SourceRoiEnabledGuard)
export class LeadDealController {
  constructor(private readonly roi: SourceRoiService) {}

  @Get(':leadId/deal')
  @RequirePermissions(PERMISSIONS.LEAD_UPDATE)
  get(@CurrentAuth() auth: AuthContext, @Param('leadId') leadId: string) {
    return this.roi.getDeal(auth, leadId);
  }

  @Put(':leadId/deal')
  @RequirePermissions(PERMISSIONS.LEAD_UPDATE)
  set(@CurrentAuth() auth: AuthContext, @Param('leadId') leadId: string, @Body() dto: DealDto) {
    return this.roi.setDeal(auth, leadId, dto);
  }
}
