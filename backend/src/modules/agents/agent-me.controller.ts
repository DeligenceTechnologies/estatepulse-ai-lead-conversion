import { Controller, Get, Inject, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/auth.decorators';
import { AppError } from '../../common/errors';
import { SessionGuard } from '../../common/guards/session.guard';
import { TENANT_PRISMA, type GuardedPrisma, type Prisma } from '../../prisma/prisma.service';
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

  /*
   * The current-assignment rule every query below applies: a lead is the
   * agent's only while it has a CURRENT assignment to them. `is_current`
   * matters: a lead reassigned away from them must stop being theirs, and the
   * history row that says it once was theirs must not bring it back.
   */

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

    // One statement. As four Prisma counts they were four queries on a
    // three-connection pool, so the fourth always waited a round trip. The
    // lead counts share one pass over the leads currently assigned to this
    // agent (the current-assignment rule, with the assignment also scoped to the
    // organization); the appointments count rides along as a subquery.
    const [counts] = await this.prisma.$queryRaw<
      Array<{ total_assigned_leads: number; active_leads: number; new_leads: number; upcoming_appointments: number }>
    >`
      select count(*)::int as total_assigned_leads,
             -- "Active" is every lead still in play (INACTIVE_STATUSES, common/domain).
             (count(*) filter (where l.status <> all(${INACTIVE_STATUSES}::text[])))::int as active_leads,
             (count(*) filter (where l.status = 'new'))::int as new_leads,
             (select count(*)
                from appointments ap
               where ap.organization_id = ${auth.organizationId}::uuid
                 and ap.agent_id = ${agentId}::uuid
                 and ap.start_at >= ${new Date()}
                 -- Verbatim from appointments_status_check; cancelled, completed
                 -- and no_show are not upcoming.
                 and ap.status in ('scheduled', 'rescheduled')
             )::int as upcoming_appointments
        from leads l
       where l.organization_id = ${auth.organizationId}::uuid
         and exists (
           select 1
             from lead_assignments la
            where la.lead_id = l.id
              and la.organization_id = l.organization_id
              and la.agent_id = ${agentId}::uuid
              and la.is_current
         )
    `;

    return {
      activeLeads: counts!.active_leads,
      newLeads: counts!.new_leads,
      upcomingAppointments: counts!.upcoming_appointments,
      totalAssignedLeads: counts!.total_assigned_leads,
    };
  }

  /**
   * The agent's own leads, newest assignment first.
   *
   * One statement. Through Prisma the source and the assignment were each a
   * further sequential query — about 145 ms apiece from a distant region — and
   * the lead came back with every column. Same filter, order and limit; only
   * the columns the row shape reads.
   *
   * The lateral join is the current-assignment rule: a lead is listed only while it has a
   * CURRENT assignment to this agent, at most once (`limit 1`), and `assignedAt`
   * is that assignment's — when THEY got it, not when some earlier agent did.
   * Every join is scoped to the organization as well as its key.
   */
  @Get('leads')
  async leads(@CurrentUser() auth: AuthContext) {
    const agentId = this.agentProfileId(auth);

    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        first_name: string | null;
        last_name: string | null;
        email: string | null;
        phone: string | null;
        status: string;
        temperature: string | null;
        created_at: Date;
        source_name: string | null;
        source_provider: string | null;
        assigned_at: Date;
      }>
    >`
      select l.id, l.first_name, l.last_name, l.email, l.phone, l.status, l.temperature, l.created_at,
             s.name     as source_name,
             s.provider as source_provider,
             a.assigned_at
        from leads l
        join lateral (
          select la.assigned_at
            from lead_assignments la
           where la.lead_id = l.id
             and la.organization_id = l.organization_id
             and la.agent_id = ${agentId}::uuid
             and la.is_current
           limit 1
        ) a on true
        left join lead_sources s
          on s.id = l.lead_source_id and s.organization_id = l.organization_id
       where l.organization_id = ${auth.organizationId}::uuid
       order by l.created_at desc
       limit 200
    `;

    return rows.map((r) =>
      toAgentLead({
        ...r,
        // lead_sources.name is NOT NULL, so a null name is exactly "no source".
        lead_sources: r.source_name !== null ? { name: r.source_name, provider: r.source_provider! } : null,
        lead_assignments: [{ assigned_at: r.assigned_at }],
      }),
    );
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

    // One statement, the same shape as leads() above: the source and the
    // assignment were each a further sequential query through Prisma. The
    // lateral join is the current-assignment rule, so a lead that is missing, another
    // agent's, another organization's or reassigned away finds no row — and
    // all four get the same 404.
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        first_name: string | null;
        last_name: string | null;
        email: string | null;
        phone: string | null;
        status: string;
        temperature: string | null;
        created_at: Date;
        location: string | null;
        timeline: string | null;
        buying_intent: string | null;
        motivation: string | null;
        ai_summary: string | null;
        min_budget: Prisma.Decimal | null;
        max_budget: Prisma.Decimal | null;
        consent_status: string;
        dnc_status: boolean;
        source_name: string | null;
        source_provider: string | null;
        assigned_at: Date;
      }>
    >`
      select l.id, l.first_name, l.last_name, l.email, l.phone, l.status, l.temperature, l.created_at,
             l.location, l.timeline, l.buying_intent, l.motivation, l.ai_summary,
             l.min_budget, l.max_budget, l.consent_status, l.dnc_status,
             s.name     as source_name,
             s.provider as source_provider,
             a.assigned_at
        from leads l
        join lateral (
          select la.assigned_at
            from lead_assignments la
           where la.lead_id = l.id
             and la.organization_id = l.organization_id
             and la.agent_id = ${agentId}::uuid
             and la.is_current
           limit 1
        ) a on true
        left join lead_sources s
          on s.id = l.lead_source_id and s.organization_id = l.organization_id
       where l.id = ${leadId}::uuid
         and l.organization_id = ${auth.organizationId}::uuid
    `;
    const row = rows[0];

    if (!row) {
      throw new AppError('NOT_FOUND', 'No such lead assigned to you');
    }

    const lead = {
      ...row,
      // lead_sources.name is NOT NULL, so a null name is exactly "no source".
      lead_sources: row.source_name !== null ? { name: row.source_name, provider: row.source_provider! } : null,
      lead_assignments: [{ assigned_at: row.assigned_at }],
    };

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
  lead_sources: { name: string; provider: string } | null;
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
