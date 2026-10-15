import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { LeadAssignmentService } from './lead-assignment.service';
import { LeadsController } from './leads.controller';

@Module({
  controllers: [LeadsController, DashboardController],
  providers: [LeadAssignmentService],
  exports: [LeadAssignmentService],
})
export class LeadModule {}
