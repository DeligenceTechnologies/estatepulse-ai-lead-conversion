import { Controller, Get, Inject, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/auth.decorators';
import { AppError } from '../../common/errors';
import { SessionGuard } from '../../common/guards/session.guard';
import { TENANT_PRISMA, type GuardedPrisma } from '../../prisma/prisma.service';
import type { AuthContext } from '../../auth/types';
import { INACTIVE_STATUSES, normalizeLeadStatus } from '../../common/domain';

/**
 * What an agent can see of their own work: their assigned leads, and the counts
 * on their dashboard.
 *
 * A separate controller from AgentsController on purpose. That one is the
 * OWNER's roster management and carries `@UseGuards(SessionGuard, OwnerGuard)`
 * on the class, so an agent is answered 403 by every route on it. These routes
 * need the opposite audience, and putting them there would have meant moving
 * guards to the method level and making the owner-only default opt-in — the
 * kind of change that silently exposes the next route somebody adds.
 *
 * There is deliberately no `:agentId` anywhere below. The agent is always
 * `auth.agentProfileId`, which SessionGuard resolved from organization_members
 * and agent_profiles on this request, so there is nothing a caller can send to
 * read another agent's leads. The organization is likewise the session's.
 *
 * Read-only. Nothing here writes.
 */
@Controller('api/agents/me')
@UseGuards(SessionGuard)
export class AgentMeController {
  constructor(@Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma) {}

  /**
   * The caller's own agent profile id, or a 403.
   *
   * Derived, never accepted. An owner has no agent_profiles row by design, so
   * this is also what keeps the owner out of the agent's surface rather than a
   * role string comparison that would need updating if roles ever grow.
   */
  private agentProfileId(auth: AuthContext): string {
    if (!auth.agentProfileId) {
      throw new AppError('FORBIDDEN', 'This account has no agent profile');
    }
    return auth.agentProfileId;
  }

  /**
   * Only leads with a CURRENT assignment to this agent. `is_current` matters:
   * a lead reassigned away from them must stop being theirs, and the history
   * row that says it once was theirs must not bring it back.
   */
  private assignedToMe(organizationId: string, agentId: string) {
    return {
      organization_id: organizationId,
      lead_assignments: { some: { agent_id: agentId, is_current: true } },
    };
  }

  /**
   * The four numbers on the dashboard. Every one is a real count over the same
   * assignment filter the list below uses, so the cards and the table can never
   * disagree.
   *
   * They are all zero today, and that is correct rather than broken: nothing
   * writes lead_assignments yet — routing is a later phase — so no lead is
   * assigned to anybody. The screen says so instead of showing a number it
   * cannot back.
   */
  @Get('dashboard')
  async dashboard(@CurrentUser() auth: AuthContext) {
    const agentId = this.agentProfileId(auth);
    const mine = this.assignedToMe(auth.organizationId, agentId);

    const [totalAssignedLeads, activeLeads, newLeads, upcomingAppointments] = await Promise.all([
      this.prisma.leads.count({ where: mine }),
      // "Active" is every lead still in play (INACTIVE_STATUSES, common/domain).
      this.prisma.leads.count({ where: { ...mine, status: { notIn: INACTIVE_STATUSES } } }),
      this.prisma.leads.count({ where: { ...mine, status: 'new' } }),
      this.prisma.appointments.count({
        where: {
          organization_id: auth.organizationId,
          agent_id: agentId,
          start_at: { gte: new Date() },
          // Verbatim from appointments_status_check; cancelled, completed and
          // no_show are not upcoming.
          status: { in: ['scheduled', 'rescheduled'] },
        },
      }),
    ]);

    return { activeLeads, newLeads, upcomingAppointments, totalAssignedLeads };
  }

  /** The agent's own leads, newest assignment first. */
  @Get('leads')
  async leads(@CurrentUser() auth: AuthContext) {
    const agentId = this.agentProfileId(auth);

    const rows = await this.prisma.leads.findMany({
      where: this.assignedToMe(auth.organizationId, agentId),
      orderBy: { created_at: 'desc' },
      take: 200,
      include: {
        lead_sources: { select: { name: true, source_type: true, provider: true } },
        // Scoped to this agent's current row so `assignedAt` is when THEY got
        // it, not when some earlier agent did.
        lead_assignments: {
          where: { agent_id: agentId, is_current: true },
          select: { assigned_at: true },
          take: 1,
        },
      },
    });

    return rows.map((l) => toAgentLead(l));
  }

  /**
   * One lead, and only if it is currently assigned to the caller.
   *
   * findFirst with the assignment predicate rather than findUnique by id: a
   * lead the agent does not hold must be indistinguishable from one that does
   * not exist, or the 404/403 difference itself leaks the organization's
   * pipeline.
   */
  @Get('leads/:leadId')
  async lead(@CurrentUser() auth: AuthContext, @Param('leadId', ParseUUIDPipe) leadId: string) {
    const agentId = this.agentProfileId(auth);

    const lead = await this.prisma.leads.findFirst({
      where: { id: leadId, ...this.assignedToMe(auth.organizationId, agentId) },
      include: {
        lead_sources: { select: { name: true, source_type: true, provider: true } },
        lead_assignments: {
          where: { agent_id: agentId, is_current: true },
          select: { assigned_at: true },
          take: 1,
        },
      },
    });

    if (!lead) {
      throw new AppError('NOT_FOUND', 'No such lead assigned to you');
    }

    return {
      ...toAgentLead(lead),
      // Everything below already exists on the row; none of it is computed or
      // invented here.
      location: lead.location,
      timeline: lead.timeline,
      buyingIntent: lead.buying_intent,
      minBudget: lead.min_budget ? Number(lead.min_budget) : null,
      maxBudget: lead.max_budget ? Number(lead.max_budget) : null,
      motivation: lead.motivation,
      aiSummary: lead.ai_summary,
      consentStatus: lead.consent_status,
      dncStatus: lead.dnc_status,
    };
  }
}

/** The one row shape the list and the detail view share. */
function toAgentLead(l: {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  temperature: string | null;
  created_at: Date;
  lead_sources: { name: string; source_type: string; provider: string } | null;
  lead_assignments: Array<{ assigned_at: Date }>;
}) {
  return {
    id: l.id,
    firstName: l.first_name,
    lastName: l.last_name,
    email: l.email,
    phone: l.phone,
    status: normalizeLeadStatus(l.status),
    temperature: l.temperature,
    source: l.lead_sources ? { name: l.lead_sources.name, provider: l.lead_sources.provider } : null,
    createdAt: l.created_at,
    // At most one, because the where clause above asks for this agent's current
    // assignment only.
    assignedAt: l.lead_assignments[0]?.assigned_at ?? null,
  };
}
