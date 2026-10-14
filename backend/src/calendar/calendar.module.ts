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

/**
 * The organization's one Calendly or Cal.com account. See README.md for what
 * each folder owns. Dependencies only point downwards:
 *
 *   members, meeting-types, availability  →  sync  →  connection/access  →  providers
 */
@Module({
  controllers: [
    CalendarConnectionController,
    CalendarMembersController,
    MeetingTypesController,
    CalendarAvailabilityController,
    CalendarWebhookController,
  ],
  providers: [
    // providers/ — HTTP to Calendly and Cal.com
    CalendlyClient,
    CalClient,
    SchedulingProvider,
    // connection/ — connect, disconnect and credential access
    CalendarAccessService,
    CalendarConnectionService,
    // sync/ — background sync and webhooks
    CalendarSyncService,
    // features that read the connected calendar
    CalendarMembersService,
    MeetingTypesService,
    CalendarAvailabilityService,
  ],
})
export class CalendarModule {}
