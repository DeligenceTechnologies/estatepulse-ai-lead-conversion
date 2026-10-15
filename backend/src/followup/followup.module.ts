import { Module, forwardRef } from '@nestjs/common';
import { TelnyxModule } from '@/telnyx/telnyx.module';
import { FollowupController } from './followup.controller';
import { FollowupRunner } from './followup.runner';
import { FollowupService } from './followup.service';

@Module({
  imports: [forwardRef(() => TelnyxModule)],
  controllers: [FollowupController],
  providers: [FollowupService, FollowupRunner],
  exports: [FollowupService],
})
export class FollowupModule {}
