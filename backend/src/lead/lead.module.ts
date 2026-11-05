import { Module } from '@nestjs/common';
import { TelnyxModule } from '@/telnyx/telnyx.module';
import { ConsentReviewController } from './consent-review.controller';
import { ConsentReviewService } from './consent-review.service';
import { DashboardController } from './dashboard.controller';
import { LeadAssignmentNotifier } from './lead-assignment-notifier.service';
import { LeadAssignmentService } from './lead-assignment.service';
import { LeadReviewService } from './lead-review.service';
import { LeadTimezoneService } from './lead-timezone.service';
import { LeadsController } from './leads.controller';
import { ManualLeadService } from './manual-lead.service';

@Module({
  imports: [TelnyxModule],
  controllers: [ConsentReviewController, LeadsController, DashboardController],
  providers: [ConsentReviewService, LeadAssignmentService, LeadAssignmentNotifier, ManualLeadService, LeadTimezoneService, LeadReviewService],
  exports: [LeadAssignmentService],
})
export class LeadModule {}
