import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { AssignmentType, LeadStatus, type OutreachBatchStatus, type OutreachItemState } from '@prisma/client';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { PrismaService } from '@/common/prisma/prisma.service';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { AssignLeadDto } from './dto/assign-lead.dto';
import { CreateLeadDto } from './dto/create-lead.dto';
import { ListLeadsQuery } from './dto/list-leads.query';
import { LeadAssignmentService } from './lead-assignment.service';
import { OUTSIDE_IMPORT_REVIEW, fullName } from './lead-scope';
import { IN_STRATEGY_STATUSES } from './lead-status';
import { ManualLeadService } from './manual-lead.service';

interface OutreachEntry {
  lead_id: string;
  state: OutreachItemState;
  skip_reason: string | null;
  batch_status: OutreachBatchStatus;
  start_at: Date;
  timezone: string;
}

/** Where a lead stands with outreach, for the line under its status; null when the status says it all. */
export type LeadOutreach =
  | { state: 'scheduled'; startAt: Date; timeZone: string }
  | { state: 'waiting' | 'released' | 'paused' }
  | { state: 'skipped'; reason: string | null };

function outreachOf(lead: { status: LeadStatus; automationPaused: boolean; dncStatus: boolean }, entry?: OutreachEntry): LeadOutreach | null {
  if (entry?.state === 'queued') {
    return entry.batch_status === 'pending' ? { state: 'scheduled', startAt: entry.start_at, timeZone: entry.timezone } : { state: 'waiting' };
  }
  if (entry?.state === 'skipped') return { state: 'skipped', reason: entry.skip_reason };
  if (entry?.state === 'released' && lead.status === LeadStatus.new && !lead.automationPaused) return { state: 'released' };
  if (lead.automationPaused && !lead.dncStatus && IN_STRATEGY_STATUSES.includes(lead.status)) return { state: 'paused' };
  return null;
}

const LEAD_FIELDS = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  phoneValid: true,
  emailValid: true,
  needsReview: true,
  reviewReasons: true,
  status: true,
  followUpReason: true,
  dncStatus: true,
  automationPaused: true,
  aiSummary: true,
  temperature: true,
  score: true,
  location: true,
  timeline: true,
  buyingIntent: true,
  financingStatus: true,
  minBudget: true,
  maxBudget: true,
  bedrooms: true,
  motivation: true,
  consentStatus: true,
  customFields: true,
  submissionCount: true,
  normalizedPhone: true,
  normalizedEmail: true,
  assignmentType: true,
  assignedAt: true,
  createdAt: true,
  updatedAt: true,
  leadSource: { select: { id: true, name: true, provider: true, connectionMethod: true } },
  assignedTo: { select: { id: true, firstName: true, lastName: true } },
} as const;

@Controller('v1/leads')
export class LeadsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly assignments: LeadAssignmentService,
    private readonly manualLeads: ManualLeadService,
  ) {}

  /** One lead added by hand. Same pipeline as a form submission, without a lead source. */
  @Post()
  @RequirePermissions(PERMISSIONS.LEAD_IMPORT)
  create(@CurrentAuth() auth: AuthContext, @Body() body: CreateLeadDto) {
    return this.manualLeads.create(auth.organizationId, auth.userId, body);
  }

  @Get()
  @RequirePermissions(PERMISSIONS.LEAD_READ)
  async list(@CurrentAuth() auth: AuthContext, @Query() query: ListLeadsQuery) {
    const orgId = auth.organizationId;
    const rows = await this.prisma.lead.findMany({
      where: {
        orgId,
        ...OUTSIDE_IMPORT_REVIEW,
        ...(query.status ? { status: query.status } : {}),
        ...(query.sourceId ? { leadSourceId: query.sourceId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit ?? 100,
      select: LEAD_FIELDS,
    });
    const [contactCounts, outreach] = await Promise.all([this.contactLeadCounts(orgId, rows), this.outreachEntries(orgId, rows.map((r) => r.id))]);

    return rows.map((l) => ({
      id: l.id,
      firstName: l.firstName,
      lastName: l.lastName,
      email: l.email,
      phone: l.phone,
      phoneValid: l.phoneValid,
      emailValid: l.emailValid,
      needsReview: l.needsReview,
      reviewReasons: l.reviewReasons,
      status: l.status,
      followUpReason: l.status === LeadStatus.follow_up ? (l.followUpReason ?? 'other') : null,
      statusReason: l.aiSummary,
      temperature: l.temperature,
      score: l.score ? Number(l.score) : 0,
      location: l.location,
      timeline: l.timeline,
      buyingIntent: l.buyingIntent,
      financingStatus: l.financingStatus,
      minBudget: l.minBudget ? Number(l.minBudget) : null,
      maxBudget: l.maxBudget ? Number(l.maxBudget) : null,
      bedrooms: l.bedrooms,
      motivation: l.motivation,
      consentStatus: l.consentStatus,
      dncStatus: l.dncStatus,
      automationPaused: l.automationPaused,
      outreach: outreachOf(l, outreach.get(l.id)),
      customFields: l.customFields,
      submissionCount: l.submissionCount,
      contactLeadCount: contactCounts.get(l.id) ?? 1,
      source: l.leadSource
        ? {
            id: l.leadSource.id,
            name: l.leadSource.name,
            type: l.leadSource.provider.toLowerCase(),
            provider: l.leadSource.provider,
            connectionMethod: l.leadSource.connectionMethod,
          }
        : null,
      assignedAgent: l.assignedTo
        ? {
            id: l.assignedTo.id,
            name: fullName(l.assignedTo.firstName, l.assignedTo.lastName),
            assignmentType: l.assignmentType ?? AssignmentType.manual,
            assignedAt: l.assignedAt,
          }
        : null,
      createdAt: l.createdAt,
      updatedAt: l.updatedAt,
    }));
  }

  /** Each listed lead's latest outreach batch entry, if it was ever launched in one. */
  private async outreachEntries(orgId: string, leadIds: string[]): Promise<Map<string, OutreachEntry>> {
    if (leadIds.length === 0) return new Map();
    const entries = await this.prisma.$queryRaw<OutreachEntry[]>`
      SELECT DISTINCT ON (i.lead_id) i.lead_id, i.state, i.skip_reason, b.status AS batch_status, b.start_at, b.timezone
        FROM outreach_batch_leads AS i
        JOIN outreach_batches AS b ON b.id = i.batch_id
       WHERE i.organization_id = ${orgId}::uuid AND i.lead_id = ANY(${leadIds}::uuid[])
       ORDER BY i.lead_id, i.created_at DESC`;
    return new Map(entries.map((e) => [e.lead_id, e]));
  }

  @Get('stats')
  @RequirePermissions(PERMISSIONS.LEAD_READ)
  async stats(@CurrentAuth() auth: AuthContext) {
    const grouped = await this.prisma.lead.groupBy({
      by: ['status'],
      where: { orgId: auth.organizationId, ...OUTSIDE_IMPORT_REVIEW },
      _count: { _all: true },
    });
    const byStatus = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
    return { byStatus, total: grouped.reduce((sum, g) => sum + g._count._all, 0) };
  }

  /** PUT: the body is the whole desired state, so repeating it changes nothing. */
  @Put(':leadId/assignment')
  @RequirePermissions(PERMISSIONS.LEAD_ASSIGN)
  assign(
    @CurrentAuth() auth: AuthContext,
    @Param('leadId', ParseUUIDPipe) leadId: string,
    @Body() body: AssignLeadDto,
  ) {
    return this.assignments.assign(auth.organizationId, leadId, body.agentId, {
      actorType: 'user',
      actorId: auth.userId,
      assignmentType: AssignmentType.manual,
      reason: 'Assigned manually',
    });
  }

  /** How many leads in the organization share each lead's phone (or email, when it has no phone). */
  private async contactLeadCounts(
    orgId: string,
    rows: { id: string; normalizedPhone: string | null; normalizedEmail: string | null }[],
  ): Promise<Map<string, number>> {
    const phones = [...new Set(rows.map((r) => r.normalizedPhone).filter((p): p is string => !!p))];
    const emails = [...new Set(rows.filter((r) => !r.normalizedPhone).map((r) => r.normalizedEmail).filter((e): e is string => !!e))];
    const [byPhone, byEmail] = await Promise.all([
      phones.length
        ? this.prisma.lead.groupBy({ by: ['normalizedPhone'], where: { orgId, normalizedPhone: { in: phones } }, _count: { _all: true } })
        : [],
      emails.length
        ? this.prisma.lead.groupBy({ by: ['normalizedEmail'], where: { orgId, normalizedEmail: { in: emails } }, _count: { _all: true } })
        : [],
    ]);
    const phoneCount = new Map(byPhone.map((g) => [g.normalizedPhone, g._count._all]));
    const emailCount = new Map(byEmail.map((g) => [g.normalizedEmail, g._count._all]));
    return new Map(
      rows.map((r) => [
        r.id,
        (r.normalizedPhone ? phoneCount.get(r.normalizedPhone) : r.normalizedEmail ? emailCount.get(r.normalizedEmail) : 1) ?? 1,
      ]),
    );
  }
}
