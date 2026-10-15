import { Controller, Get, Param } from '@nestjs/common';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { LeadBookingService } from './lead-booking.service';

/** What each caller may see is decided by lead visibility: everyone with lead.read, others only their own leads. */
@Controller('leads')
export class LeadBookingController {
  constructor(private readonly booking: LeadBookingService) {}

  @Get(':leadId/booking-options')
  options(@CurrentAuth() auth: AuthContext, @Param('leadId') leadId: string) {
    return this.booking.options(auth, leadId);
  }

  @Get(':leadId/appointments')
  appointments(@CurrentAuth() auth: AuthContext, @Param('leadId') leadId: string) {
    return this.booking.appointmentsFor(auth, leadId);
  }
}
