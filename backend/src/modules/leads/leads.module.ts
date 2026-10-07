import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { OwnerGuard } from '../../common/guards/owner.guard';
import { PrismaModule } from '../../prisma/prisma.module';
import { LeadAssignmentController } from './lead-assignment.controller';
import { LeadAssignmentService } from './lead-assignment.service';
import { LeadsController } from './leads.controller';
import { OwnerDashboardController } from './owner-dashboard.controller';

/**
 * EventsBus needs no import: EventsModule is @Global. OwnerGuard has no
 * dependencies and is registered so the container can build it for @UseGuards.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [LeadsController, LeadAssignmentController, OwnerDashboardController],
  providers: [LeadAssignmentService, OwnerGuard],
})
export class LeadsModule {}
