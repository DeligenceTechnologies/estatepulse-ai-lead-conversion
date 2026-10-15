import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Query } from '@nestjs/common';
import { AssignmentType, LeadStatus } from '@prisma/client';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { PrismaService } from '@/common/prisma/prisma.service';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { AssignLeadDto } from './dto/assign-lead.dto';
import { ListLeadsQuery } from './dto/list-leads.query';
import { LeadAssignmentService } from './lead-assignment.service';
import { OUTSIDE_IMPORT_REVIEW, fullName } from './lead-scope';

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
  ) {}

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
    const contactCounts = await this.contactLeadCounts(orgId, rows);

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
