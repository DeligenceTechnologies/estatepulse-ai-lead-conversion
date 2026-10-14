import { Module } from '@nestjs/common';
import { CalendarAvailabilityController } from './availability/calendar-availability.controller';
import { CalendarAvailabilityService } from './availability/calendar-availability.service';
import { CalendarAccessService } from './connection/calendar-access.service';
import { CalendarConnectionController } from './connection/calendar-connection.controller';
import { CalendarConnectionService } from './connection/calendar-connection.service';
import { MeetingTypesController } from './meeting-types/meeting-types.controller';
import { MeetingTypesService } from './meeting-types/meeting-types.service';
import { CalendarMembersController } from './members/calendar-members.controller';
import { CalendarMembersService } from './members/calendar-members.service';
import { CalClient } from './providers/cal.client';
import { CalendlyClient } from './providers/calendly.client';
import { SchedulingProvider } from './providers/scheduling-provider';
import { CalendarSyncService } from './sync/calendar-sync.service';
import { CalendarWebhookController } from './sync/calendar-webhook.controller';

@Module({
  controllers: [
    CalendarConnectionController,
    CalendarMembersController,
    MeetingTypesController,
    CalendarAvailabilityController,
    CalendarWebhookController,
  ],
  providers: [
    CalendlyClient,
    CalClient,
    SchedulingProvider,
    CalendarAccessService,
    CalendarConnectionService,
    CalendarSyncService,
    CalendarMembersService,
    MeetingTypesService,
    CalendarAvailabilityService,
  ],
})
export class CalendarModule {}
