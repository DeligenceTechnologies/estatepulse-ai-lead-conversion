import { Module } from '@nestjs/common';
import { CalendarModule } from '@/calendar/calendar.module';
import { HistoryModule } from '@/history/history.module';
import { TelnyxModule } from '@/telnyx/telnyx.module';
import { AgentController } from './agent.controller';

@Module({
  imports: [CalendarModule, HistoryModule, TelnyxModule],
  controllers: [AgentController],
})
export class AgentModule {}
