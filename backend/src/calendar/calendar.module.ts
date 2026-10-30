import { Module } from '@nestjs/common';
import { LeadModule } from '@/lead/lead.module';
import { TelnyxModule } from '@/telnyx/telnyx.module';
import { AppointmentsController } from './appointments/appointments.controller';
import { AppointmentsService } from './appointments/appointments.service';
import { BookingToolController, InCallBookingSettingsController, InCallBookingToolController } from './booking/in-call-booking.controller';
import { InCallBookingSettingsService } from './booking/in-call-booking-settings.service';
import { InCallBookingService } from './booking/in-call-booking.service';
import { LeadBookingController } from './booking/lead-booking.controller';
import { LeadBookingService } from './booking/lead-booking.service';
import { ToolAuthService } from './booking/tool-auth.service';
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
  imports: [TelnyxModule, LeadModule],
  controllers: [
    CalendarConnectionController,
    CalendarMembersController,
    MeetingTypesController,
    CalendarAvailabilityController,
    CalendarWebhookController,
    AppointmentsController,
    LeadBookingController,
    InCallBookingSettingsController,
    InCallBookingToolController,
    BookingToolController,
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
    AppointmentsService,
    LeadBookingService,
    InCallBookingSettingsService,
    InCallBookingService,
    ToolAuthService,
  ],
  exports: [AppointmentsService, InCallBookingSettingsService],
})
export class CalendarModule {}
