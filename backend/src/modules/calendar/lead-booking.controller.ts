import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import type { AuthContext } from '../../auth/types';
import { CurrentUser } from '../../common/decorators/auth.decorators';
import { SessionGuard } from '../../common/guards/session.guard';
import { LeadBookingService } from './lead-booking.service';
import type { AppointmentDTO, LeadBookingOptionsDTO } from './types';

/**
 * Booking from a lead: the assigned agent's event types as links pre-filled
 * for this lead, and the lead's real appointments.
 *
 * SessionGuard only — owners and agents both book. What each may see is
 * decided in LeadBookingService (an agent: only their currently assigned
 * leads). The organization is always the session's.
 */
@Controller('api/leads')
@UseGuards(SessionGuard)
export class LeadBookingController {
  constructor(private readonly booking: LeadBookingService) {}

  @Get(':leadId/booking-options')
  options(@CurrentUser() auth: AuthContext, @Param('leadId') leadId: string): Promise<LeadBookingOptionsDTO> {
    return this.booking.options(auth, leadId);
  }

  @Get(':leadId/appointments')
  appointments(@CurrentUser() auth: AuthContext, @Param('leadId') leadId: string): Promise<AppointmentDTO[]> {
    return this.booking.appointmentsFor(auth, leadId);
  }
}
