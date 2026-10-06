import { Inject, Injectable } from '@nestjs/common';
import type { AuthContext } from '../../auth/types';
import { AppError } from '../../common/errors';
import { TENANT_PRISMA, type GuardedPrisma } from '../../prisma/prisma.service';
import { AppointmentsService } from './appointments.service';
import { CalendarConnectionsService } from './calendar-connections.service';
import { leadBookingUrl } from './lead-booking-link';
import { CalendarProviderRegistry } from './providers/provider.registry';
import type { CalendarProviderId } from './providers/types';
import type { AppointmentDTO, LeadBookingOptionsDTO } from './types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Booking a meeting FOR a lead.
 *
 * The rule: a lead is booked with its assigned agent, on one of that agent's
 * own event types, through a link that carries the lead (lead-booking-link.ts).
 * The provider does the scheduling, invites and reminders; the regular sync
 * turns the booking into an appointment on this lead.
 *
 * Round-robin and other shared pages are deliberately NOT offered here: they
 * let the provider pick a different host than the agent the office assigned.
 *
 * Visibility is the same as everywhere else: an owner sees every lead in the
 * organization, an agent only the leads currently assigned to them. A lead the
 * caller cannot see is NOT_FOUND, never FORBIDDEN, so ids cannot be probed.
 */
@Injectable()
export class LeadBookingService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma,
    private readonly connections: CalendarConnectionsService,
    private readonly providers: CalendarProviderRegistry,
    private readonly appointments: AppointmentsService,
  ) {}

  async options(auth: AuthContext, leadId: string): Promise<LeadBookingOptionsDTO> {
    const lead = await this.visibleLead(auth, leadId);
    const empty = (blocker: LeadBookingOptionsDTO['blocker'], extra: Partial<LeadBookingOptionsDTO> = {}) => ({
      agent: null,
      provider: null,
      eventTypes: [],
      blocker,
      ...extra,
    });

    const assignment = await this.prisma.lead_assignments.findFirst({
      where: { organization_id: auth.organizationId, lead_id: lead.id, is_current: true },
      orderBy: { assigned_at: 'desc' },
      select: {
        agent_profiles: { select: { id: true, display_name: true, calendly_user_uri: true, cal_user_id: true } },
      },
    });
    const profile = assignment?.agent_profiles;
    if (!profile) return empty('no_agent');
    const agent = { id: profile.id, name: profile.display_name };

    const conn = await this.connections.syncableOrgRow(auth.organizationId);
    if (!conn) return empty('no_calendar', { agent });
    const provider = this.providers.get(conn.provider).id as CalendarProviderId;

    const hostId = provider === 'calendly' ? profile.calendly_user_uri : profile.cal_user_id?.toString();
    if (!hostId) return empty('agent_not_linked', { agent, provider });

    // memberHostIds makes Calendly also read this agent's own user scope,
    // which is where personal event types are guaranteed to be listed.
    const types = await this.providers.get(provider).listEventTypes(conn, { memberHostIds: [hostId] });
    const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ').trim() || null;

    const eventTypes = types
      .filter((et) => et.active && et.schedulingUrl && et.hostIds.length === 1 && et.hostIds[0] === hostId)
      .map((et) => ({
        id: et.id,
        name: et.name,
        durationMinutes: et.durationMinutes,
        bookingUrl: leadBookingUrl(provider, et.schedulingUrl as string, { id: lead.id, name, email: lead.email }),
      }))
      .filter((et): et is typeof et & { bookingUrl: string } => et.bookingUrl !== null)
      .sort((a, b) => a.durationMinutes - b.durationMinutes || a.name.localeCompare(b.name));

    return { agent, provider, eventTypes, blocker: eventTypes.length ? null : 'no_event_types' };
  }

  async appointmentsFor(auth: AuthContext, leadId: string): Promise<AppointmentDTO[]> {
    const lead = await this.visibleLead(auth, leadId);
    return this.appointments.forLead(auth.organizationId, lead.id);
  }

  private async visibleLead(auth: AuthContext, leadId: string) {
    const lead = UUID.test(leadId)
      ? await this.prisma.leads.findFirst({
          where: {
            id: leadId,
            organization_id: auth.organizationId,
            ...(auth.role === 'owner'
              ? {}
              : { lead_assignments: { some: { agent_id: auth.agentProfileId ?? '', is_current: true } } }),
          },
          select: { id: true, first_name: true, last_name: true, email: true },
        })
      : null;
    if (!lead) throw new AppError('NOT_FOUND', 'No such lead');
    return lead;
  }
}
