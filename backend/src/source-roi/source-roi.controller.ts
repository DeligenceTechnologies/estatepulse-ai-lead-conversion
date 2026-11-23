import { Body, Controller, Get, Param, Put, Query, UseGuards } from '@nestjs/common';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { AppointmentSnapshotService } from './appointment-snapshot.service';
import { CostLedgerService } from './cost-ledger.service';
import { NoShowDto, RatesDto, RoiRangeQuery, SpendDto } from './dto/source-roi.dto';
import { SourceRoiEnabledGuard } from './source-roi-enabled.guard';
import { SourceRoiService } from './source-roi.service';

/**
 * Source ROI: `/v1/source-roi/...`. The organization always comes from the
 * session. Reading the report needs report.read, entering spend and rates
 * needs report.update; marking a no-show needs neither, only that the caller
 * can see the lead, so an agent can do it for their own appointments.
 */
@Controller('v1/source-roi')
@UseGuards(SourceRoiEnabledGuard)
export class SourceRoiController {
  constructor(
    private readonly roi: SourceRoiService,
    private readonly ledger: CostLedgerService,
    private readonly appointments: AppointmentSnapshotService,
  ) {}

  /**
   * Exists only while the flag is on: every screen probes it to show or hide
   * what belongs to Source ROI. No permission, since agents' screens ask too
   * (the no-show control); it says nothing but "on".
   */
  @Get('config')
  config() {
    return { enabled: true };
  }

  @Get()
  @RequirePermissions(PERMISSIONS.REPORT_READ)
  report(@CurrentAuth() auth: AuthContext, @Query() query: RoiRangeQuery) {
    return this.roi.report(auth.organizationId, query.from, query.to);
  }

  @Put('spend')
  @RequirePermissions(PERMISSIONS.REPORT_UPDATE)
  setSpend(@CurrentAuth() auth: AuthContext, @Body() dto: SpendDto) {
    return this.roi.setSpend(auth, dto);
  }

  @Get('rates')
  @RequirePermissions(PERMISSIONS.REPORT_READ)
  rates(@CurrentAuth() auth: AuthContext) {
    return this.ledger.getRates(auth.organizationId);
  }

  @Put('rates')
  @RequirePermissions(PERMISSIONS.REPORT_UPDATE)
  setRates(@CurrentAuth() auth: AuthContext, @Body() dto: RatesDto) {
    return this.ledger.setRates(auth.organizationId, dto);
  }

  @Put('appointments/:meetingId/no-show')
  setNoShow(@CurrentAuth() auth: AuthContext, @Param('meetingId') meetingId: string, @Body() dto: NoShowDto) {
    return this.appointments.setNoShow(auth, meetingId, dto.noShow);
  }
}
