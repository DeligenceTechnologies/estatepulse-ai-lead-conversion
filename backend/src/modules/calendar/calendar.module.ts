import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { OwnerGuard } from '../../common/guards/owner.guard';
import { TelnyxModule } from '../../telnyx/telnyx.module';
import { LeadsModule } from '../leads/leads.module';
import { AgentCalendarController } from './agent-calendar.controller';
import { AppointmentsService } from './appointments.service';
import { AvailabilityService } from './availability.service';
import { CalendarConnectionsService } from './calendar-connections.service';
import { CalendarPollerService } from './calendar-poller.service';
import { CalendarSyncService } from './calendar-sync.service';
import { CalendlyClientService } from './calendly.client';
import {
  InCallBookingSettingsController,
  InCallBookingToolController,
} from './in-call-booking/in-call-booking.controller';
import { InCallBookingSettingsService } from './in-call-booking/in-call-booking-settings.service';
import { InCallBookingService } from './in-call-booking/in-call-booking.service';
import { ToolAuthService } from './in-call-booking/tool-auth.service';
import { LeadBookingController } from './lead-booking.controller';
import { LeadBookingService } from './lead-booking.service';
import { CalComClientService } from './providers/calcom.client';
import { CalComProvider } from './providers/calcom.provider';
import { CalendlyProvider } from './providers/calendly.provider';
import { CalendarProviderRegistry } from './providers/provider.registry';
import { CalendarEventTypesService } from './calendar-event-types.service';
import { CalendlyOAuthController } from './calendly-oauth.controller';
import { CalendarRosterService } from './calendar-roster.service';
import { OrganizationCalendarController } from './organization-calendar.controller';
import { OwnerCalendarController } from './owner-calendar.controller';

/**
 * Calendar sync: the OFFICE connects ONE scheduling account — Calendly or
 * Cal.com, never both — its agents are invited onto that organization or team
 * and keep their availability there, and the bookings across the whole team
 * which belong to one of our leads become `appointments` rows.
 *
 * Agents still set working hours here — those drive routing, not Calendly —
 * but they no longer connect anything of their own.
 *
 * AuthModule for the guards. TelnyxModule for EngineService, which it exports —
 * a booking has to stop the outbound cadence, or the AI keeps chasing someone
 * who has already put a meeting in the diary. PrismaModule and EventsModule are
 * @Global() and need no import.
 */
@Module({
  // LeadsModule for LeadAssignmentService: in-call booking assigns the lead to
  // the agent Calendly picked.
  imports: [AuthModule, TelnyxModule, LeadsModule],
  // ORDER IS LOAD-BEARING. AgentCalendarController serves
  // `GET /api/agents/me/calendar`; OwnerCalendarController serves
  // `GET /api/agents/:userId/calendar`. Both patterns match the literal URL
  // `/api/agents/me/calendar`, and Express answers with whichever was
  // registered first. AgentCalendarController must therefore stay first, or an
  // agent's own calendar request would fall through to the owner route, be
  // rejected by ParseUUIDPipe as a malformed id, and 400 — with nothing in the
  // logs to suggest why. The e2e check for this is that an agent can GET
  // /api/agents/me/calendar and receive their connection, not a 400.
  controllers: [
    AgentCalendarController,
    OwnerCalendarController,
    OrganizationCalendarController,
    CalendlyOAuthController,
    LeadBookingController,
    InCallBookingToolController,
    InCallBookingSettingsController,
  ],
  providers: [
    // The provider layer. CalendarProviderRegistry is what every neutral
    // service resolves through, so a third scheduling tool is added by
    // registering an adapter here and nowhere else.
    CalendlyClientService,
    CalComClientService,
    CalendlyProvider,
    CalComProvider,
    CalendarProviderRegistry,

    CalendarConnectionsService,
    CalendarSyncService,
    CalendarPollerService,
    CalendarRosterService,
    CalendarEventTypesService,
    AvailabilityService,
    AppointmentsService,
    LeadBookingService,
    InCallBookingSettingsService,
    InCallBookingService,
    ToolAuthService,
    OwnerGuard,
  ],
  exports: [CalendarSyncService, CalendarConnectionsService],
})
export class CalendarModule {}
