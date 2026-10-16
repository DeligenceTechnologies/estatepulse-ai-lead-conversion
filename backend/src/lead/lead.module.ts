import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { LeadAssignmentService } from './lead-assignment.service';
import { LeadsController } from './leads.controller';
import { ManualLeadService } from './manual-lead.service';

@Module({
  controllers: [LeadsController, DashboardController],
  providers: [LeadAssignmentService, ManualLeadService],
  exports: [LeadAssignmentService],
})
export class LeadModule {}
