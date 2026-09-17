import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, type AuthedRequest } from '../../common/api-key.guard';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Read-only. There is deliberately no POST or PATCH here.
 *
 * That is the structural answer to "who owns leads": the API creates leads ONLY
 * via ingestion, and the SPA has no way to write one. The demo store in
 * AppContext keeps exclusive ownership of its own localStorage leads. The two
 * cannot collide because neither can write to the other.
 */
@Controller('v1/leads')
@UseGuards(ApiKeyGuard)
export class LeadsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(
    @Req() req: AuthedRequest,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    // Which form produced the lead. The Lead Sources screen answers "what has
    // this form actually brought in" with it, which is the question a source is
    // worth having a page for.
    @Query('sourceId') sourceId?: string,
  ) {
    const take = Math.min(Number(limit ?? 100), 200);

    const rows = await this.prisma.leads.findMany({
      where: {
        organization_id: req.tenant.organizationId,
        ...(status ? { status } : {}),
        ...(sourceId ? { lead_source_id: sourceId } : {}),
      },
      orderBy: { created_at: 'desc' },
      take,
      include: {
        // The source name is what the UI shows in the "Source" column — the
        // whole point of connecting a form is knowing where a lead came from.
        // `provider` and `connection_method` come along because "where from"
        // means the integration the customer set up, not the transport: a form
        // we connected through Tally's API should read `tally`, and only a
        // hand-pasted URL should read `webhook`. See the badge rule below.
        lead_sources: {
          select: {
            id: true,
            name: true,
            source_type: true,
            provider: true,
            connection_method: true,
          },
        },
        _count: { select: { leadSubmissions: true } },
      },
    });

    const contactLeadCounts = await this.countLeadsPerContact(req.tenant.organizationId, rows);

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
      status: l.status,
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
      contactLeadCount: contactLeadCounts.get(l.id) ?? 1,
      // `name` is the customer's label for the form ('Buyer Inquiry'), shown on
      // hover; `type` is the transport, always 'webhook'. `provider` and
      // `connectionMethod` are what the badge actually reads — the client turns
      // them into 'tally' for an API-connected form and 'webhook' for a URL the
      // customer pasted themselves.
      source: l.lead_sources
        ? {
            id: l.lead_sources.id,
            name: l.lead_sources.name,
            type: l.lead_sources.source_type,
            provider: l.lead_sources.provider,
            connectionMethod: l.lead_sources.connection_method,
          }
        : null,
      createdAt: l.created_at,
      updatedAt: l.updated_at,
    }));
  }

  /**
   * leadId -> how many leads in the org share that lead's contact identity.
   *
   * The identity rule is the one ingestion used to merge on, deliberately:
   * phone if we have a usable one, email otherwise. Keeping it identical means
   * the rows that would have been silently merged before are exactly the rows
   * badged "repeat contact" now — the information is preserved, the destructive
   * half of the behaviour is not.
   *
   * Two grouped counts rather than a per-row subquery: both hit
   * idx_leads_phone / idx_leads_email, and the page is at most 200 leads.
   */
  private async countLeadsPerContact(
    organizationId: string,
    rows: { id: string; normalized_phone: string | null; normalized_email: string | null }[],
  ): Promise<Map<string, number>> {
    const phones = [...new Set(rows.map((r) => r.normalized_phone).filter((v): v is string => !!v))];
    const emails = [
      ...new Set(
        rows
          .filter((r) => !r.normalized_phone)
          .map((r) => r.normalized_email)
          .filter((v): v is string => !!v),
      ),
    ];

    const [byPhone, byEmail] = await Promise.all([
      phones.length
        ? this.prisma.leads.groupBy({
            by: ['normalized_phone'],
            where: { organization_id: organizationId, normalized_phone: { in: phones } },
            _count: { _all: true },
          })
        : Promise.resolve([]),
      emails.length
        ? this.prisma.leads.groupBy({
            by: ['normalized_email'],
            where: { organization_id: organizationId, normalized_email: { in: emails } },
            _count: { _all: true },
          })
        : Promise.resolve([]),
    ]);

    const phoneCounts = new Map(byPhone.map((g) => [g.normalized_phone!, g._count._all]));
    const emailCounts = new Map(byEmail.map((g) => [g.normalized_email!, g._count._all]));

    const out = new Map<string, number>();
    for (const r of rows) {
      const n = r.normalized_phone
        ? (phoneCounts.get(r.normalized_phone) ?? 1)
        : r.normalized_email
          ? (emailCounts.get(r.normalized_email) ?? 1)
          : 1;
      out.set(r.id, n);
    }
    return out;
  }

  /** Stage counts for the pipeline header. */
  @Get('stats')
  async stats(@Req() req: AuthedRequest) {
    const grouped = await this.prisma.leads.groupBy({
      by: ['status'],
      where: { organization_id: req.tenant.organizationId },
      _count: { _all: true },
    });
    const byStatus: Record<string, number> = {};
    for (const g of grouped) byStatus[g.status] = g._count._all;
    return { byStatus, total: Object.values(byStatus).reduce((a, b) => a + b, 0) };
  }
}
