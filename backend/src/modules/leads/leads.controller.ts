import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { TenantGuard, type TenantRequest } from '../../common/guards/tenant.guard';
import { TENANT_PRISMA, type GuardedPrisma } from '../../prisma/prisma.service';
import {
  normalizeFollowUpReason,
  normalizeLeadStatus,
  normalizeStatusCounts,
  statusFilterValues,
} from '../../common/domain';

type LeadSourceDTO = { id: string; name: string; type: string; provider: string; connectionMethod: string };
type AssignedAgentDTO = { id: string; name: string; assignmentType: string; assignedAt: Date };

/**
 * Read-only. There is deliberately no POST or PATCH here. (Manual assignment,
 * the one owner write on a lead, lives in LeadAssignmentController: it needs a
 * signed-in owner, and this controller also accepts API keys.)
 *
 * That is the structural answer to "who owns leads": the API creates leads ONLY
 * via ingestion, and the SPA has no way to write one. The demo store in
 * AppContext keeps exclusive ownership of its own localStorage leads. The two
 * cannot collide because neither can write to the other.
 */
@Controller('api/v1/leads')
@UseGuards(TenantGuard)
export class LeadsController {
  constructor(@Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma) {}

  @Get()
  async list(
    @Req() req: TenantRequest,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    // Which form produced the lead. The Lead Sources screen answers "what has
    // this form actually brought in" with it, which is the question a source is
    // worth having a page for.
    @Query('sourceId') sourceId?: string,
  ) {
    const take = Math.min(Number(limit ?? 100), 200);

    // Only the columns the response reads. No relations here: Prisma fetches
    // each one as its own sequential query, so they come from one statement in
    // enrich() instead. Filters, ordering and `take` stay in Prisma.
    const rows = await this.prisma.leads.findMany({
      where: {
        organization_id: req.tenant.organizationId,
        ...(status ? { status: { in: statusFilterValues(status) } } : {}),
        ...(sourceId ? { lead_source_id: sourceId } : {}),
      },
      orderBy: { created_at: 'desc' },
      take,
      select: {
        id: true,
        first_name: true,
        last_name: true,
        email: true,
        phone: true,
        phone_valid: true,
        email_valid: true,
        needs_review: true,
        review_reasons: true,
        status: true,
        follow_up_reason: true,
        dnc_status: true,
        ai_summary: true,
        temperature: true,
        score: true,
        location: true,
        timeline: true,
        buying_intent: true,
        financing_status: true,
        min_budget: true,
        max_budget: true,
        bedrooms: true,
        motivation: true,
        consent_status: true,
        custom_fields: true,
        submission_count: true,
        created_at: true,
        updated_at: true,
      },
    });

    const extras = await this.enrich(req.tenant.organizationId, rows.map((l) => l.id));

    return rows.map((l) => ({
      id: l.id,
      firstName: l.first_name,
      lastName: l.last_name,
      email: l.email,
      phone: l.phone,
      phoneValid: l.phone_valid,
      emailValid: l.email_valid,
      needsReview: l.needs_review,
      reviewReasons: l.review_reasons,
      status: normalizeLeadStatus(l.status),
      followUpReason: normalizeFollowUpReason(l.status, l.follow_up_reason),
      statusReason: l.ai_summary, // why it's in this status (e.g. "Call attempt failed: …") — shown on hover
      temperature: l.temperature,
      score: l.score ? Number(l.score) : 0,
      location: l.location,
      timeline: l.timeline,
      buyingIntent: l.buying_intent,
      financingStatus: l.financing_status,
      minBudget: l.min_budget ? Number(l.min_budget) : null,
      maxBudget: l.max_budget ? Number(l.max_budget) : null,
      bedrooms: l.bedrooms,
      motivation: l.motivation,
      consentStatus: l.consent_status,
      dncStatus: l.dnc_status,
      customFields: l.custom_fields,
      submissionCount: l.submission_count,
      // How many leads in this org share this one's contact details, itself
      // included. 1 is the normal case. Anything higher is the signal the old
      // merge used to consume by collapsing the rows: same person, or same
      // shared line, submitting more than once. Now it is shown rather than
      // acted on — see ProcessingWorker.createLead.
      contactLeadCount: extras.get(l.id)?.contactLeadCount ?? 1,
      // `name` is the customer's label for the form ('Buyer Inquiry'), shown on
      // hover; `type` is the transport, always 'webhook'. `provider` and
      // `connectionMethod` are what the badge actually reads — the client turns
      // them into 'tally' for an API-connected form and 'webhook' for a URL the
      // customer pasted themselves.
      source: extras.get(l.id)?.source ?? null,
      // Null is "unassigned" — the honest state for every lead nobody has
      // routed or handed to an agent yet.
      assignedAgent: extras.get(l.id)?.assignedAgent ?? null,
      createdAt: l.created_at,
      updatedAt: l.updated_at,
    }));
  }

  /**
   * leadId -> source, current agent and repeat-contact count, in ONE statement.
   *
   * As Prisma relations these were three sequential queries plus a fourth for
   * the counts — about 145 ms each from a distant region. Every join is scoped
   * to the caller's organization as well as the foreign key.
   *
   * Source: the name is what the UI shows in the "Source" column. `provider`
   * and `connection_method` come along because "where from" means the
   * integration the customer set up, not the transport: a form we connected
   * through Tally's API should read `tally`, and only a hand-pasted URL should
   * read `webhook`. `name` is the customer's label for the form ('Buyer
   * Inquiry'), shown on hover; `type` is the transport, always 'webhook'.
   *
   * Agent: the one current assignment, if any. Held to one by
   * LeadAssignmentService, which locks the lead while it writes; `limit 1` is
   * belt-and-braces so a stray second row can never duplicate a lead.
   *
   * Count: how many leads in the org share this one's contact identity, itself
   * included. The identity rule is the one ingestion used to merge on,
   * deliberately: phone if we have a usable one, email otherwise. Keeping it
   * identical means the rows that would have been silently merged before are
   * exactly the rows badged "repeat contact" now — the information is
   * preserved, the destructive half of the behaviour is not. Each count is an
   * index probe on idx_leads_phone / idx_leads_email, and a page is at most 200
   * leads.
   */
  private async enrich(
    organizationId: string,
    leadIds: string[],
  ): Promise<Map<string, { source: LeadSourceDTO | null; assignedAgent: AssignedAgentDTO | null; contactLeadCount: number }>> {
    if (leadIds.length === 0) return new Map();

    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        source_id: string | null;
        source_name: string | null;
        source_type: string | null;
        source_provider: string | null;
        source_connection_method: string | null;
        agent_id: string | null;
        agent_name: string | null;
        assignment_type: string | null;
        assigned_at: Date | null;
        contact_lead_count: number;
      }>
    >`
      select l.id,
             s.id                as source_id,
             s.name              as source_name,
             s.source_type,
             s.provider          as source_provider,
             s.connection_method as source_connection_method,
             a.agent_id,
             a.agent_name,
             a.assignment_type,
             a.assigned_at,
             (case
                when coalesce(l.normalized_phone, '') <> '' then
                  (select count(*) from leads p
                    where p.organization_id = l.organization_id and p.normalized_phone = l.normalized_phone)
                when coalesce(l.normalized_email, '') <> '' then
                  (select count(*) from leads e
                    where e.organization_id = l.organization_id and e.normalized_email = l.normalized_email)
                else 1
              end)::int          as contact_lead_count
        from leads l
        left join lead_sources s
          on s.id = l.lead_source_id and s.organization_id = l.organization_id
        left join lateral (
          select ap.id as agent_id, ap.display_name as agent_name, la.assignment_type, la.assigned_at
            from lead_assignments la
            join agent_profiles ap
              on ap.id = la.agent_id and ap.organization_id = la.organization_id
           where la.lead_id = l.id and la.organization_id = l.organization_id and la.is_current
           order by la.assigned_at desc
           limit 1
        ) a on true
       where l.organization_id = ${organizationId}::uuid
         and l.id = any(${leadIds}::uuid[])
    `;

    return new Map(
      rows.map((r) => [
        r.id,
        {
          source: r.source_id
            ? {
                id: r.source_id,
                name: r.source_name!,
                type: r.source_type!,
                provider: r.source_provider!,
                connectionMethod: r.source_connection_method!,
              }
            : null,
          assignedAgent: r.agent_id
            ? {
                id: r.agent_id,
                name: r.agent_name!,
                assignmentType: r.assignment_type!,
                assignedAt: r.assigned_at!,
              }
            : null,
          contactLeadCount: r.contact_lead_count,
        },
      ]),
    );
  }

  /** Stage counts for the pipeline header. */
  @Get('stats')
  async stats(@Req() req: TenantRequest) {
    const grouped = await this.prisma.leads.groupBy({
      by: ['status'],
      where: { organization_id: req.tenant.organizationId },
      _count: { _all: true },
    });
    const byStatus = normalizeStatusCounts(grouped);
    return { byStatus, total: Object.values(byStatus).reduce((a, b) => a + b, 0) };
  }
}
