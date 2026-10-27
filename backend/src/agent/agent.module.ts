import { Module } from '@nestjs/common';
import { CalendarModule } from '@/calendar/calendar.module';
import { HistoryModule } from '@/history/history.module';
import { AgentController } from './agent.controller';

@Module({
  imports: [CalendarModule, HistoryModule],
  controllers: [AgentController],
})
export class AgentModule {}
