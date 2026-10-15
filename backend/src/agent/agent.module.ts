import { Module } from '@nestjs/common';
import { CalendarModule } from '@/calendar/calendar.module';
import { AgentController } from './agent.controller';

@Module({
  imports: [CalendarModule],
  controllers: [AgentController],
})
export class AgentModule {}
