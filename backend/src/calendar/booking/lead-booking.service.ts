import { Injectable, NotFoundException } from '@nestjs/common';
import type { CalendarProvider } from '@prisma/client';
import type { AuthContext } from '@/auth/auth.types';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { fullName, visibleLeads } from '@/lead/lead-scope';
import { AppointmentsService, type AppointmentDTO } from '../appointments/appointments.service';
import { CalendarAccessService } from '../connection/calendar-access.service';
import { SchedulingProvider } from '../providers/scheduling-provider';
import { leadBookingUrl } from './lead-booking-link';

export type LeadBookingBlocker = 'no_agent' | 'no_calendar' | 'agent_not_linked' | 'no_event_types';

export interface LeadBookingOptionsDTO {
  agent: { id: string; name: string } | null;
  provider: CalendarProvider | null;
  eventTypes: { id: string; name: string; durationMinutes: number; bookingUrl: string }[];
  blocker: LeadBookingBlocker | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Booking a meeting for a lead: with its assigned agent, on one of that agent's
 * own one-on-one event types, through a link that carries the lead so the sync
 * matches the meeting back to it. Shared pages (round robin, collective) are
 * not offered, as they let the provider pick a host other than the assigned one.
 * A lead the caller cannot see is NOT_FOUND.
 */
@Injectable()
export class LeadBookingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CalendarAccessService,
    private readonly provider: SchedulingProvider,
    private readonly appointments: AppointmentsService,
  ) {}

  async options(auth: AuthContext, leadId: string): Promise<LeadBookingOptionsDTO> {
    const lead = await this.visibleLead(auth, leadId);
    const empty = (blocker: LeadBookingBlocker, extra: Partial<LeadBookingOptionsDTO> = {}): LeadBookingOptionsDTO => ({
      agent: null,
      provider: null,
      eventTypes: [],
      blocker,
      ...extra,
    });

    const host = lead.assignedTo;
    if (!host) return empty('no_agent');
    const agent = { id: host.id, name: fullName(host.firstName, host.lastName, host.email) };

    try {
      return await this.access.useActive(auth.organizationId, async (connection, secret) => {
        const member = await this.prisma.calendarMember.findFirst({
          where: { connectionId: connection.id, email: { equals: host.email, mode: 'insensitive' } },
          select: { externalId: true, username: true },
        });
        if (!member) return empty('agent_not_linked', { agent, provider: connection.provider });

        const name = fullName(lead.firstName, lead.lastName) || null;
        const eventTypes = (await this.provider.memberEventTypes(connection, secret, member))
          .filter((et) => !et.poolingType && et.bookingUrl)
          .map((et) => ({
            id: et.id,
            name: et.name,
            durationMinutes: et.durationMinutes,
            bookingUrl: leadBookingUrl(connection.provider, et.bookingUrl!, { id: lead.id, name, email: lead.email }),
          }))
          .filter((et): et is typeof et & { bookingUrl: string } => et.bookingUrl !== null)
          .sort((a, b) => a.durationMinutes - b.durationMinutes || a.name.localeCompare(b.name));

        return { agent, provider: connection.provider, eventTypes, blocker: eventTypes.length ? null : 'no_event_types' };
      });
    } catch (error) {
      if (error instanceof NotFoundException) return empty('no_calendar', { agent });
      throw error;
    }
  }

  async appointmentsFor(auth: AuthContext, leadId: string): Promise<AppointmentDTO[]> {
    await this.visibleLead(auth, leadId);
    return this.appointments.forLead(auth.organizationId, leadId);
  }

  private async visibleLead(auth: AuthContext, leadId: string) {
    const lead = UUID.test(leadId)
      ? await this.prisma.lead.findFirst({
          where: { id: leadId, ...visibleLeads(auth) },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            assignedTo: { select: { id: true, firstName: true, lastName: true, email: true } },
          },
        })
      : null;
    if (!lead) throw new AppError('NOT_FOUND', 'No such lead');
    return lead;
  }
}
