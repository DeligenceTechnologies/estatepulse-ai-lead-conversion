import { Module } from '@nestjs/common';
import { UserModule } from '@/user/user.module';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';
import { CalClient } from './providers/cal.client';
import { CalendlyClient } from './providers/calendly.client';

@Module({
  imports: [UserModule],
  controllers: [CalendarController],
  providers: [CalendarService, CalendlyClient, CalClient],
})
export class CalendarModule {}
