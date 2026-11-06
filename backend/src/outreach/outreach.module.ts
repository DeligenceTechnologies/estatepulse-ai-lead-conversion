import { Module } from '@nestjs/common';
import { TelnyxModule } from '@/telnyx/telnyx.module';
import { OutreachCapabilityController } from './outreach-capability.controller';
import { OutreachController } from './outreach.controller';
import { OutreachRunner } from './outreach.runner';
import { OutreachService } from './outreach.service';

@Module({
  imports: [TelnyxModule],
  controllers: [OutreachCapabilityController, OutreachController],
  providers: [OutreachService, OutreachRunner],
})
export class OutreachModule {}
