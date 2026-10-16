import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { OwnerGuard } from '../../common/guards/owner.guard';
import { PrismaModule } from '../../prisma/prisma.module';
import { LeadAssignmentController } from './lead-assignment.controller';
import { LeadAssignmentService } from './lead-assignment.service';
import { LeadsController } from './leads.controller';
import { ManualLeadController } from './manual-lead.controller';
import { ManualLeadService } from './manual-lead.service';
import { OwnerDashboardController } from './owner-dashboard.controller';

/**
 * EventsBus needs no import: EventsModule is @Global. OwnerGuard has no
 * dependencies and is registered so the container can build it for @UseGuards.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [LeadsController, LeadAssignmentController, ManualLeadController, OwnerDashboardController],
  providers: [LeadAssignmentService, ManualLeadService, OwnerGuard],
  // In-call booking (CalendarModule) assigns the lead to the agent Calendly picked.
  exports: [LeadAssignmentService],
})
export class LeadsModule {}
