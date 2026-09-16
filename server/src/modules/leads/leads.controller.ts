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
  ) {
    const take = Math.min(Number(limit ?? 100), 200);

    const rows = await this.prisma.leads.findMany({
      where: {
        organization_id: req.tenant.organizationId,
        ...(status ? { status } : {}),
      },
      orderBy: { created_at: 'desc' },
      take,
      include: {
        // The source name is what the UI shows in the "Source" column — the
        // whole point of connecting a form is knowing where a lead came from.
        lead_sources: { select: { id: true, name: true, source_type: true } },
        _count: { select: { leadSubmissions: true } },
      },
    });

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
      // `type` is what the pipeline table badges a row with ('webhook'); `name`
      // is the customer's label for the form ('Buyer Inquiry') and is shown on hover.
      source: l.lead_sources
        ? { id: l.lead_sources.id, name: l.lead_sources.name, type: l.lead_sources.source_type }
        : null,
      createdAt: l.created_at,
      updatedAt: l.updated_at,
    }));
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
