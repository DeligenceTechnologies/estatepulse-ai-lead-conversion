import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { OwnerGuard } from '../../common/guards/owner.guard';
import { PrismaModule } from '../../prisma/prisma.module';
import { LeadsController } from './leads.controller';
import { OwnerDashboardController } from './owner-dashboard.controller';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [LeadsController, OwnerDashboardController],
  providers: [OwnerGuard],
})
export class LeadsModule {}
