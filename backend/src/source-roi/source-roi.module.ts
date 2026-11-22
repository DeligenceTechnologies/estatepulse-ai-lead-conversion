import { Module } from '@nestjs/common';
import { AppointmentSnapshotModule } from './appointment-snapshot.module';
import { CostLedgerService } from './cost-ledger.service';
import { LeadDealController } from './lead-deal.controller';
import { SourceRoiController } from './source-roi.controller';
import { SourceRoiService } from './source-roi.service';

/**
 * Source ROI: marketing spend per lead source, the estimated cost of the calls
 * and texts its leads took, and what that comes to per appointment and per
 * closing. Everything here is behind SOURCE_ROI_ENABLED.
 */
@Module({
  imports: [AppointmentSnapshotModule],
  controllers: [SourceRoiController, LeadDealController],
  providers: [CostLedgerService, SourceRoiService],
})
export class SourceRoiModule {}
