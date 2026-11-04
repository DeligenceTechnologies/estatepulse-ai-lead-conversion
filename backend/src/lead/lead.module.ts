import { Module } from '@nestjs/common';
import { TelnyxModule } from '@/telnyx/telnyx.module';
import { DashboardController } from './dashboard.controller';
import { LeadAssignmentNotifier } from './lead-assignment-notifier.service';
import { LeadAssignmentService } from './lead-assignment.service';
import { LeadTimezoneService } from './lead-timezone.service';
import { LeadsController } from './leads.controller';
import { ManualLeadService } from './manual-lead.service';

@Module({
  imports: [TelnyxModule],
  controllers: [LeadsController, DashboardController],
  providers: [LeadAssignmentService, LeadAssignmentNotifier, ManualLeadService, LeadTimezoneService],
  exports: [LeadAssignmentService],
})
export class LeadModule {}
