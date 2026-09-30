import { Inject, Injectable } from '@nestjs/common';
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
   * Appointments for an organization, optionally narrowed to one agent.
   *
   * `agentId` is a FILTER, never an authorization decision — the caller's right
   * to see these rows is settled by the guard on the route, and the
   * organization comes from their session either way.
   */
  async list(organizationId: string, q: AppointmentRangeQuery): Promise<AppointmentDTO[]> {
    const day = 24 * 60 * 60 * 1000;
    const from = q.from ?? new Date(Date.now() - DEFAULT_PAST_DAYS * day);
    const to = q.to ?? new Date(Date.now() + DEFAULT_FUTURE_DAYS * day);

    const rows = await this.prisma.appointments.findMany({
      where: {
        organization_id: organizationId,
        start_at: { gte: from, lte: to },
        ...(q.status ? { status: q.status } : {}),
        ...(q.agentId ? { agent_id: q.agentId } : {}),
      },
      orderBy: { start_at: 'asc' },
      take: MAX_ROWS,
      include: {
        leads: { select: { first_name: true, last_name: true, email: true, phone: true, status: true } },
        agent_profiles: { select: { display_name: true } },
      },
    });

    return rows.map((r) => this.toDto(r as AppointmentRow));
  }

  /** Upcoming appointments for one agent — the owner's per-agent panel. */
  async upcomingForAgent(organizationId: string, agentId: string): Promise<AppointmentDTO[]> {
    const rows = await this.prisma.appointments.findMany({
      where: {
        organization_id: organizationId,
        agent_id: agentId,
        start_at: { gte: new Date() },
        // Verbatim from appointments_status_check, and the same pair
        // agent-me.controller.ts counts as "upcoming" — the two must agree or
        // the agent's badge and the owner's list disagree about the same day.
        status: { in: ['scheduled', 'rescheduled'] },
      },
      orderBy: { start_at: 'asc' },
      take: 50,
      include: {
        leads: { select: { first_name: true, last_name: true, email: true, phone: true, status: true } },
        agent_profiles: { select: { display_name: true } },
      },
    });

    return rows.map((r) => this.toDto(r as AppointmentRow));
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
