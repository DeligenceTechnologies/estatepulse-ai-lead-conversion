import { Module } from '@nestjs/common';
import { CalendarAvailabilityService } from './availability/calendar-availability.service';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';
import { CalClient } from './providers/cal.client';
import { CalendlyClient } from './providers/calendly.client';
import { CalendarSyncService } from './sync/calendar-sync.service';
import { CalendarWebhookController } from './sync/calendar-webhook.controller';

@Module({
  controllers: [CalendarController, CalendarWebhookController],
  providers: [CalendarService, CalendarAvailabilityService, CalendarSyncService, CalendlyClient, CalClient],
})
export class CalendarModule {}
