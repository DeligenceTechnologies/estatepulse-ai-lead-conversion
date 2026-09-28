import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { OwnerGuard } from '../../common/guards/owner.guard';
import { PrismaModule } from '../../prisma/prisma.module';
import { TelnyxModule } from '../../telnyx/telnyx.module';
import { FollowupAdminController, FollowupController } from './followup.controller';
import { FollowupRunner } from './followup.runner';
import { FollowupService } from './followup.service';

/**
 * Nurture: the two seeded sequences, enrolment, and the database-driven runner
 * that fires their steps.
 *
 * forwardRef to TelnyxModule because the dependency genuinely runs both ways:
 * the runner sends through that module's SMS/voice services, and the strategy
 * engine there enrols warm and cold leads here the moment a call returns a
 * temperature.
 */
@Module({
  imports: [PrismaModule, AuthModule, forwardRef(() => TelnyxModule)],
  controllers: [FollowupController, FollowupAdminController],
  providers: [FollowupService, FollowupRunner, OwnerGuard],
  exports: [FollowupService],
})
export class FollowupModule {}
