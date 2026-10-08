import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
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
    if (!UUID.test(leadId)) throw new AppError('NOT_FOUND', 'No such lead');

    // The office calendar depends only on the organization, so it is read
    // alongside the lead instead of after it. It is awaited only where it was
    // always read — once the lead is visible and assigned — so NOT_FOUND and
    // no_agent answer exactly as before, and a failure of this read still
    // surfaces only on the path that uses it.
    const connection = this.connections.syncableOrgRow(auth.organizationId);
    connection.catch(() => undefined);

    const found = await this.visibleLeadWithAgent(auth, leadId);
    if (!found) throw new AppError('NOT_FOUND', 'No such lead');
    const { lead, profile } = found;
    const empty = (blocker: LeadBookingOptionsDTO['blocker'], extra: Partial<LeadBookingOptionsDTO> = {}) => ({
      agent: null,
      provider: null,
      eventTypes: [],
      blocker,
      ...extra,
    });

    if (!profile) return empty('no_agent');
    const agent = { id: profile.id, name: profile.display_name };

    const conn = await connection;
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
    // The visibility check and the read in one statement — see forLead.
    const appointments = UUID.test(leadId)
      ? await this.appointments.forLead(
          auth.organizationId,
          leadId,
          auth.role === 'owner' ? null : (auth.agentProfileId ?? ''),
        )
      : null;
    if (!appointments) throw new AppError('NOT_FOUND', 'No such lead');
    return appointments;
  }

  /**
   * The lead, if the caller may see it, and the agent profile its current
   * assignment points at — ONE statement where Prisma took three sequential
   * round trips (the lead, the assignment, then its profile). No row means the
   * caller cannot see the lead; a lead with no current assignment comes back
   * with no profile.
   *
   * Visibility: an owner sees every lead in the organization, anyone else only
   * a lead currently assigned to their own profile — the same rule as
   * AppointmentsService.forLead; keep the two in step. The current assignment
   * is the newest is_current row, as it always was. Both joins also carry the
   * organization, which a valid row always matches.
   */
  private async visibleLeadWithAgent(auth: AuthContext, leadId: string) {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        first_name: string | null;
        last_name: string | null;
        email: string | null;
        agent_id: string | null;
        display_name: string | null;
        calendly_user_uri: string | null;
        cal_user_id: number | null;
      }>
    >`
      select l.id, l.first_name, l.last_name, l.email,
             ap.id as agent_id, ap.display_name, ap.calendly_user_uri, ap.cal_user_id
        from leads l
        left join lateral (
          select la.agent_id
            from lead_assignments la
           where la.organization_id = l.organization_id and la.lead_id = l.id and la.is_current
           order by la.assigned_at desc
           limit 1
        ) cur on true
        left join agent_profiles ap on ap.id = cur.agent_id and ap.organization_id = l.organization_id
       where l.id = ${leadId}::uuid and l.organization_id = ${auth.organizationId}::uuid
             ${
               auth.role === 'owner'
                 ? Prisma.empty
                 : Prisma.sql`and exists (
                     select 1 from lead_assignments mine
                      where mine.organization_id = l.organization_id and mine.lead_id = l.id
                        and mine.agent_id = ${auth.agentProfileId ?? ''}::uuid and mine.is_current
                   )`
             }
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      lead: { id: row.id, first_name: row.first_name, last_name: row.last_name, email: row.email },
      profile: row.agent_id
        ? {
            id: row.agent_id,
            display_name: row.display_name!,
            calendly_user_uri: row.calendly_user_uri,
            cal_user_id: row.cal_user_id,
          }
        : null,
    };
  }
}
