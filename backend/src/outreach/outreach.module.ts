import { Module } from '@nestjs/common';
import { TelnyxModule } from '@/telnyx/telnyx.module';
import { OutreachController } from './outreach.controller';
import { OutreachRunner } from './outreach.runner';
import { OutreachService } from './outreach.service';

@Module({
  imports: [TelnyxModule],
  controllers: [OutreachController],
  providers: [OutreachService, OutreachRunner],
})
export class OutreachModule {}
