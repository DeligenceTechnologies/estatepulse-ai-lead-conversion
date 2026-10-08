import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TENANT_PRISMA, type GuardedPrisma } from '../../prisma/prisma.service';
import type { AppointmentRangeQuery } from './schemas';
import type { AppointmentDTO } from './types';

/** Default look-back / look-ahead when the caller gives no range. */
const DEFAULT_PAST_DAYS = 30;
const DEFAULT_FUTURE_DAYS = 90;
const MAX_ROWS = 500;

type AppointmentRow = {
  id: string;
  lead_id: string;
  agent_id: string;
  provider: string;
  external_event_id: string | null;
  status: string;
  start_at: Date;
  end_at: Date;
  meeting_url: string | null;
  notes: string | null;
  metadata: unknown;
  created_at: Date;
  leads: {
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    phone: string | null;
    status: string;
  } | null;
  agent_profiles: { display_name: string } | null;
};

@Injectable()
export class AppointmentsService {
  constructor(@Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma) {}

  /**
   * Appointments for an organization, in ONE statement: starting between `from`
   * and `to` (by default 30 days back to 90 ahead), optionally one status,
   * agent or lead, by start time, at most MAX_ROWS — each with its lead and
   * agent. Serves the owner's list (GET /api/appointments) and an agent's own
   * (GET /api/agents/me/appointments, agentId forced to their profile).
   *
   * `agentId` and `leadId` are FILTERS, never authorization decisions — the
   * caller's right to see these rows is settled by the guard on the route, and
   * the organization comes from their session either way, so another office's
   * agent or lead id simply matches nothing.
   *
   * Rows sharing a start time have no defined order. The lead and agent are
   * joined within the organization too, which a valid row always matches.
   */
  async listInRange(organizationId: string, q: AppointmentRangeQuery): Promise<AppointmentDTO[]> {
    const day = 24 * 60 * 60 * 1000;
    const from = q.from ?? new Date(Date.now() - DEFAULT_PAST_DAYS * day);
    const to = q.to ?? new Date(Date.now() + DEFAULT_FUTURE_DAYS * day);

    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        lead_id: string;
        agent_id: string;
        provider: string;
        external_event_id: string | null;
        status: string;
        start_at: Date;
        end_at: Date;
        meeting_url: string | null;
        notes: string | null;
        metadata: unknown;
        created_at: Date;
        lead_found: string | null;
        first_name: string | null;
        last_name: string | null;
        email: string | null;
        phone: string | null;
        lead_status: string | null;
        agent_name: string | null;
      }>
    >`
      select a.id, a.lead_id, a.agent_id, a.provider, a.external_event_id, a.status, a.start_at, a.end_at,
             a.meeting_url, a.notes, a.metadata, a.created_at,
             l.id as lead_found, l.first_name, l.last_name, l.email, l.phone, l.status as lead_status,
             ap.display_name as agent_name
        from appointments a
        left join leads l on l.id = a.lead_id and l.organization_id = a.organization_id
        left join agent_profiles ap on ap.id = a.agent_id and ap.organization_id = a.organization_id
       where a.organization_id = ${organizationId}::uuid
         and a.start_at >= ${from}::timestamptz and a.start_at <= ${to}::timestamptz
         ${q.status ? Prisma.sql`and a.status = ${q.status}` : Prisma.empty}
         ${q.agentId ? Prisma.sql`and a.agent_id = ${q.agentId}::uuid` : Prisma.empty}
         ${q.leadId ? Prisma.sql`and a.lead_id = ${q.leadId}::uuid` : Prisma.empty}
       order by a.start_at asc
       limit ${MAX_ROWS}
    `;

    return rows.map((r) =>
      this.toDto({
        id: r.id,
        lead_id: r.lead_id,
        agent_id: r.agent_id,
        provider: r.provider,
        external_event_id: r.external_event_id,
        status: r.status,
        start_at: r.start_at,
        end_at: r.end_at,
        meeting_url: r.meeting_url,
        notes: r.notes,
        metadata: r.metadata,
        created_at: r.created_at,
        leads: r.lead_found
          ? { first_name: r.first_name, last_name: r.last_name, email: r.email, phone: r.phone, status: r.lead_status! }
          : null,
        agent_profiles: r.agent_name === null ? null : { display_name: r.agent_name },
      }),
    );
  }

  /**
   * Upcoming appointments for one agent — the owner's per-agent panel.
   *
   * ONE statement, each appointment with its lead and agent, where Prisma took
   * three sequential round trips (the appointments, then each relation). Rows
   * sharing a start time have no defined order, as before. The lead and agent
   * are joined within the organization too, which a valid row always matches.
   */
  async upcomingForAgent(organizationId: string, agentId: string): Promise<AppointmentDTO[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        lead_id: string;
        agent_id: string;
        provider: string;
        external_event_id: string | null;
        status: string;
        start_at: Date;
        end_at: Date;
        meeting_url: string | null;
        notes: string | null;
        metadata: unknown;
        created_at: Date;
        lead_found: string | null;
        first_name: string | null;
        last_name: string | null;
        email: string | null;
        phone: string | null;
        lead_status: string | null;
        agent_name: string | null;
      }>
    >`
      select a.id, a.lead_id, a.agent_id, a.provider, a.external_event_id, a.status, a.start_at, a.end_at,
             a.meeting_url, a.notes, a.metadata, a.created_at,
             l.id as lead_found, l.first_name, l.last_name, l.email, l.phone, l.status as lead_status,
             ap.display_name as agent_name
        from appointments a
        left join leads l on l.id = a.lead_id and l.organization_id = a.organization_id
        left join agent_profiles ap on ap.id = a.agent_id and ap.organization_id = a.organization_id
       where a.organization_id = ${organizationId}::uuid
         and a.agent_id = ${agentId}::uuid
         and a.start_at >= ${new Date()}::timestamptz
         -- Verbatim from appointments_status_check, and the same pair
         -- agent-me.controller.ts counts as "upcoming": the two must agree or
         -- the agent's badge and the owner's list disagree about the same day.
         and a.status in ('scheduled', 'rescheduled')
       order by a.start_at asc
       limit 50
    `;

    return rows.map((r) =>
      this.toDto({
        id: r.id,
        lead_id: r.lead_id,
        agent_id: r.agent_id,
        provider: r.provider,
        external_event_id: r.external_event_id,
        status: r.status,
        start_at: r.start_at,
        end_at: r.end_at,
        meeting_url: r.meeting_url,
        notes: r.notes,
        metadata: r.metadata,
        created_at: r.created_at,
        leads: r.lead_found
          ? { first_name: r.first_name, last_name: r.last_name, email: r.email, phone: r.phone, status: r.lead_status! }
          : null,
        agent_profiles: r.agent_name === null ? null : { display_name: r.agent_name },
      }),
    );
  }

  /**
   * Every appointment for one lead, newest first — the lead dossier's tab — or
   * null when the caller may not see the lead.
   *
   * `assignedAgentId` null is an owner, who sees every lead in the
   * organization; otherwise only a lead currently assigned to that agent
   * profile is visible. The same rule as LeadBookingService.visibleLeadWithAgent
   * — keep the two in step.
   *
   * ONE statement: the visibility check, the appointments and their lead and
   * agent, where Prisma takes four sequential round trips (the lead, the
   * appointments, then each relation). The lead row is the anchor, so a lead
   * the caller cannot see is no row at all, and a visible lead with no
   * appointments is one row with no appointment in it. The rows are rebuilt
   * in AppointmentRow's shape so toDto renders them exactly as the other reads.
   */
  async forLead(organizationId: string, leadId: string, assignedAgentId: string | null): Promise<AppointmentDTO[] | null> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        lead_first_name: string | null;
        lead_last_name: string | null;
        lead_email: string | null;
        lead_phone: string | null;
        lead_status: string;
        id: string | null;
        lead_id: string;
        agent_id: string;
        provider: string;
        external_event_id: string | null;
        status: string;
        start_at: Date;
        end_at: Date;
        meeting_url: string | null;
        notes: string | null;
        metadata: unknown;
        created_at: Date;
        agent_name: string | null;
      }>
    >`
      select l.first_name as lead_first_name, l.last_name as lead_last_name, l.email as lead_email,
             l.phone as lead_phone, l.status as lead_status,
             a.id, a.lead_id, a.agent_id, a.provider, a.external_event_id, a.status, a.start_at, a.end_at,
             a.meeting_url, a.notes, a.metadata, a.created_at, a.agent_name
        from leads l
        left join lateral (
          select a.id, a.lead_id, a.agent_id, a.provider, a.external_event_id, a.status, a.start_at, a.end_at,
                 a.meeting_url, a.notes, a.metadata, a.created_at, ap.display_name as agent_name
            from appointments a
            left join agent_profiles ap on ap.id = a.agent_id and ap.organization_id = a.organization_id
           where a.organization_id = l.organization_id and a.lead_id = l.id
           order by a.start_at desc
           limit 50
        ) a on true
       where l.id = ${leadId}::uuid and l.organization_id = ${organizationId}::uuid
             ${
               assignedAgentId === null
                 ? Prisma.empty
                 : Prisma.sql`and exists (
                     select 1 from lead_assignments la
                      where la.organization_id = l.organization_id and la.lead_id = l.id
                        and la.agent_id = ${assignedAgentId}::uuid and la.is_current
                   )`
             }
       order by a.start_at desc
    `;
    if (rows.length === 0) return null;

    return rows
      .filter((r) => r.id !== null)
      .map((r) =>
        this.toDto({
          id: r.id!,
          lead_id: r.lead_id,
          agent_id: r.agent_id,
          provider: r.provider,
          external_event_id: r.external_event_id,
          status: r.status,
          start_at: r.start_at,
          end_at: r.end_at,
          meeting_url: r.meeting_url,
          notes: r.notes,
          metadata: r.metadata,
          created_at: r.created_at,
          leads: {
            first_name: r.lead_first_name,
            last_name: r.lead_last_name,
            email: r.lead_email,
            phone: r.lead_phone,
            status: r.lead_status,
          },
          agent_profiles: r.agent_name === null ? null : { display_name: r.agent_name },
        }),
      );
  }

  private toDto(r: AppointmentRow): AppointmentDTO {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const name = [r.leads?.first_name, r.leads?.last_name].filter(Boolean).join(' ').trim();

    return {
      id: r.id,
      leadId: r.lead_id,
      // Fall back to the contact details rather than inventing a placeholder
      // name: a lead with neither is rare but real, and "Unnamed lead" at least
      // does not claim to be somebody.
      leadName: name || r.leads?.email || r.leads?.phone || 'Unnamed lead',
      leadEmail: r.leads?.email ?? null,
      leadPhone: r.leads?.phone ?? null,
      leadStatus: r.leads?.status ?? 'unknown',
      agentId: r.agent_id,
      agentName: r.agent_profiles?.display_name ?? 'Unassigned',
      provider: r.provider,
      externalEventId: r.external_event_id,
      startTime: r.start_at.toISOString(),
      endTime: r.end_at.toISOString(),
      status: r.status,
      appointmentType: (meta.eventTypeName as string | null) ?? null,
      meetingUrl: r.meeting_url,
      notes: r.notes,
      cancelUrl: (meta.cancelUrl as string | null) ?? null,
      rescheduleUrl: (meta.rescheduleUrl as string | null) ?? null,
      canceledReason: (meta.canceledReason as string | null) ?? null,
      createdAt: r.created_at.toISOString(),
    };
  }
}
