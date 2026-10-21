import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { AssignmentType, LeadStatus, LeadTemperature, Prisma } from '@prisma/client';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { paginate } from '@/common/pagination/paginate';
import type { ListQuery } from '@/common/pagination/pagination.types';
import { PrismaService } from '@/common/prisma/prisma.service';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { AssignLeadDto } from './dto/assign-lead.dto';
import { CreateLeadDto } from './dto/create-lead.dto';
import { LeadAssignmentService } from './lead-assignment.service';
import { OUTSIDE_IMPORT_REVIEW, fullName } from './lead-scope';
import { ManualLeadService } from './manual-lead.service';

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

type LeadListRow = Prisma.LeadGetPayload<{ select: typeof LEAD_FIELDS }>;

/** One row of the lead list, as the Leads screen reads it. */
const toLeadRow = (l: LeadListRow, contactLeadCount: number) => ({
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
  contactLeadCount,
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
});

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
  async list(@CurrentAuth() auth: AuthContext, @Query() query: ListQuery) {
    const orgId = auth.organizationId;
    // "Unassigned" is an absence, which the shared filters cannot express: it is read here and folded into the base where.
    const { unassigned, ...rest } = query;
    if (unassigned !== undefined && unassigned !== 'true' && unassigned !== 'false') {
      throw new BadRequestException(['unassigned must be true or false']);
    }
    const page = await paginate(rest, {
      where: {
        orgId,
        ...OUTSIDE_IMPORT_REVIEW,
        ...(unassigned === 'true' ? { assignedToId: null } : {}),
      } as Prisma.LeadWhereInput,
      searchFields: ['firstName', 'lastName', 'phone', 'email', 'location'],
      filters: {
        status: { type: 'enum', values: Object.values(LeadStatus) },
        temperature: { type: 'enum', values: Object.values(LeadTemperature) },
        sourceId: { type: 'uuid', field: 'leadSourceId' },
        agentId: { type: 'uuid', field: 'assignedToId' },
      },
      sortableFields: ['createdAt'] as const,
      defaultSort: [{ createdAt: 'desc' }],
      findMany: (args) => this.prisma.lead.findMany({ ...args, select: LEAD_FIELDS }),
      count: (args) => this.prisma.lead.count(args),
    });
    const contactCounts = await this.contactLeadCounts(orgId, page.data);

    return { data: page.data.map((l) => toLeadRow(l, contactCounts.get(l.id) ?? 1)), meta: page.meta };
  }

  /** Tab counts and the filter options, over every lead in the list, not just the page on screen. */
  @Get('stats')
  @RequirePermissions(PERMISSIONS.LEAD_READ)
  async stats(@CurrentAuth() auth: AuthContext) {
    const orgId = auth.organizationId;
    const where = { orgId, ...OUTSIDE_IMPORT_REVIEW } satisfies Prisma.LeadWhereInput;
    const [byStatusRows, byTemperatureRows, sources, agents] = await Promise.all([
      this.prisma.lead.groupBy({ by: ['status'], where, _count: { _all: true } }),
      this.prisma.lead.groupBy({ by: ['temperature'], where, _count: { _all: true } }),
      // A source or an agent is an option once it holds a lead, as before pagination.
      this.prisma.leadSource.findMany({ where: { orgId, leads: { some: where } }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      this.prisma.user.findMany({
        where: { orgId, assignedLeads: { some: where } },
        select: { id: true, firstName: true, lastName: true },
        orderBy: { firstName: 'asc' },
      }),
    ]);
    const byStatus = Object.fromEntries(byStatusRows.map((g) => [g.status, g._count._all]));
    const byTemperature = Object.fromEntries(
      byTemperatureRows.filter((g) => g.temperature !== null).map((g) => [g.temperature, g._count._all]),
    );
    return {
      byStatus,
      byTemperature,
      total: byStatusRows.reduce((sum, g) => sum + g._count._all, 0),
      sources,
      agents: agents.map((a) => ({ id: a.id, name: fullName(a.firstName, a.lastName, 'Unnamed agent') })),
    };
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
