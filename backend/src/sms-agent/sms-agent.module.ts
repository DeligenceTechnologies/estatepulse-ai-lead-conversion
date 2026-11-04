import { Module } from '@nestjs/common';
import { CalendarModule } from '@/calendar/calendar.module';
import { TelnyxModule } from '@/telnyx/telnyx.module';
import { SmsAgentService } from './sms-agent.service';
import { SmsReplyWorker } from './sms-reply.worker';

/**
 * The AI's text replies written by this server. Kept out of TelnyxModule:
 * replies run the booking tools (CalendarModule), which itself needs
 * TelnyxModule. Inbound texts reach it through the sms-reply queue.
 */
@Module({
  imports: [TelnyxModule, CalendarModule],
  providers: [SmsAgentService, SmsReplyWorker],
})
export class SmsAgentModule {}
