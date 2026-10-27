import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Query } from '@nestjs/common';
import { BaseStatus, CalendarMeetingStatus, LeadStatus, Prisma } from '@prisma/client';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { AppointmentsService } from '@/calendar/appointments/appointments.service';
import { AppointmentRangeQuery } from '@/calendar/appointments/dto/appointment-range.query';
import { inUse } from '@/calendar/connection/connection-state';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { DEFAULT_WORKING_HOURS, toWorkingHoursJson, type WorkingDay } from '@/common/utils/working-hours';
import { ConversationsQuery } from '@/history/dto/history.query';
import { HistoryService } from '@/history/history.service';
import { INACTIVE_STATUSES } from '@/lead/lead-status';
import { AGENT_ROLE_WHERE } from '@/lead/lead-scope';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { PutAvailabilityDto } from './dto/availability.dto';

const AGENT_LEAD_FIELDS = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  status: true,
  temperature: true,
  createdAt: true,
  assignedAt: true,
  leadSource: { select: { name: true, provider: true } },
} satisfies Prisma.LeadSelect;

type AgentLeadRow = Prisma.LeadGetPayload<{ select: typeof AGENT_LEAD_FIELDS }>;

const toAgentLead = (l: AgentLeadRow) => ({
  id: l.id,
  firstName: l.firstName,
  lastName: l.lastName,
  email: l.email,
  phone: l.phone,
  status: l.status,
  temperature: l.temperature,
  source: l.leadSource ? { name: l.leadSource.name, provider: l.leadSource.provider } : null,
  createdAt: l.createdAt,
  assignedAt: l.assignedAt,
});

/** Who leads can go to, and an agent's own leads, conversations, hours, calendar and appointments. */
@Controller('agents')
export class AgentController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appointments: AppointmentsService,
    private readonly history: HistoryService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.LEAD_READ)
  async roster(@CurrentAuth() auth: AuthContext) {
    const orgId = auth.organizationId;
    const [users, active, linkedEmails] = await Promise.all([
      this.prisma.user.findMany({
        where: { orgId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          status: true,
          timezone: true,
          maxActiveLeads: true,
          createdAt: true,
          roles: { select: { role: { select: { isSystem: true, name: true } } } },
        },
      }),
      this.prisma.lead.groupBy({
        by: ['assignedToId'],
        where: { orgId, assignedToId: { not: null }, status: { notIn: INACTIVE_STATUSES } },
        _count: { _all: true },
      }),
      this.calendarEmails(orgId),
    ]);
    const counts = new Map(active.map((g) => [g.assignedToId, g._count._all]));
    const agentRole = AGENT_ROLE_WHERE.name.equals.toLowerCase();

    return users.map((u) => {
      const owner = u.roles.some(({ role }) => role.isSystem);
      const takesLeads = u.roles.some(({ role }) => !role.isSystem && role.name.toLowerCase() === agentRole);
      return {
        id: u.id,
        firstName: u.firstName,
        lastName: u.lastName,
        email: u.email,
        phone: u.phone,
        role: owner ? 'owner' : 'agent',
        status: u.status === BaseStatus.active ? 'active' : 'suspended',
        memberSince: u.createdAt,
        timezone: u.timezone,
        title: null,
        maxActiveLeads: u.maxActiveLeads,
        hasProfile: takesLeads,
        profileId: takesLeads ? u.id : null,
        takingLeads: takesLeads && u.status === BaseStatus.active,
        activeLeads: counts.get(u.id) ?? 0,
        calendarLinked: linkedEmails !== null && linkedEmails.has(u.email.toLowerCase()),
      };
    });
  }

  @Get('me/dashboard')
  async dashboard(@CurrentAuth() auth: AuthContext) {
    const mine = { orgId: auth.organizationId, assignedToId: auth.userId };
    const [total, active, fresh, upcoming] = await Promise.all([
      this.prisma.lead.count({ where: mine }),
      this.prisma.lead.count({ where: { ...mine, status: { notIn: INACTIVE_STATUSES } } }),
      this.prisma.lead.count({ where: { ...mine, status: LeadStatus.new } }),
      this.prisma.calendarMeeting.count({
        where: {
          orgId: auth.organizationId,
          hostUserId: auth.userId,
          leadId: { not: null },
          startsAt: { gte: new Date() },
          status: CalendarMeetingStatus.scheduled,
        },
      }),
    ]);
    return { activeLeads: active, newLeads: fresh, upcomingAppointments: upcoming, totalAssignedLeads: total };
  }

  @Get('me/leads')
  async leads(@CurrentAuth() auth: AuthContext) {
    const rows = await this.prisma.lead.findMany({
      where: { orgId: auth.organizationId, assignedToId: auth.userId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: AGENT_LEAD_FIELDS,
    });
    return rows.map(toAgentLead);
  }

  @Get('me/leads/:leadId')
  async lead(@CurrentAuth() auth: AuthContext, @Param('leadId', ParseUUIDPipe) leadId: string) {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, orgId: auth.organizationId, assignedToId: auth.userId },
      select: {
        ...AGENT_LEAD_FIELDS,
        location: true,
        timeline: true,
        buyingIntent: true,
        motivation: true,
        aiSummary: true,
        minBudget: true,
        maxBudget: true,
        consentStatus: true,
        dncStatus: true,
      },
    });
    if (!lead) throw new AppError('NOT_FOUND', 'No such lead assigned to you');
    return {
      ...toAgentLead(lead),
      location: lead.location,
      timeline: lead.timeline,
      buyingIntent: lead.buyingIntent,
      minBudget: lead.minBudget ? Number(lead.minBudget) : null,
      maxBudget: lead.maxBudget ? Number(lead.maxBudget) : null,
      motivation: lead.motivation,
      aiSummary: lead.aiSummary,
      consentStatus: lead.consentStatus,
      dncStatus: lead.dncStatus,
    };
  }

  /**
   * The SMS threads of the leads assigned to this agent right now, the AI's
   * chat included: a lead shows up once it is assigned to them and is gone the
   * moment it is reassigned. Scoped to the agent even for someone who may read
   * every lead; the office-wide list is /v1/conversations.
   */
  @Get('me/conversations')
  conversations(@CurrentAuth() auth: AuthContext, @Query() query: ConversationsQuery) {
    return this.history.listConversations(auth, query.limit, query.leadId, 'mine');
  }

  /** One thread, in full, of a lead assigned to this agent; any other lead is not found. */
  @Get('me/leads/:leadId/messages')
  messages(@CurrentAuth() auth: AuthContext, @Param('leadId', ParseUUIDPipe) leadId: string) {
    return this.history.listMessages(auth, leadId, 'mine');
  }

  @Get('me/availability')
  async availability(@CurrentAuth() auth: AuthContext) {
    const user = await this.prisma.user.findFirstOrThrow({
      where: { id: auth.userId, orgId: auth.organizationId },
      select: { timezone: true, workingHours: true },
    });
    return { timezone: user.timezone, days: readWeek(user.workingHours) };
  }

  @Put('me/availability')
  async saveAvailability(@CurrentAuth() auth: AuthContext, @Body() body: PutAvailabilityDto) {
    const user = await this.prisma.user.update({
      where: { id: auth.userId },
      data: { workingHours: toWorkingHoursJson(body.days) },
      select: { timezone: true, workingHours: true },
    });
    return { timezone: user.timezone, days: readWeek(user.workingHours) };
  }

  @Get('me/calendar')
  async calendar(@CurrentAuth() auth: AuthContext) {
    const [connection, user] = await Promise.all([
      this.prisma.calendarConnection.findFirst({
        where: inUse(auth.organizationId),
        select: { id: true, provider: true, status: true, syncedAt: true },
      }),
      this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId }, select: { email: true } }),
    ]);
    const member = connection
      ? await this.prisma.calendarMember.findFirst({
          where: { connectionId: connection.id, email: { equals: user.email, mode: 'insensitive' } },
          select: { externalId: true, schedulingUrl: true },
        })
      : null;
    return {
      organizationConnected: connection?.status === 'active',
      provider: connection?.provider ?? null,
      syncEnabled: connection?.status === 'active',
      schedulingUserId: member?.externalId ?? null,
      schedulingUrl: member?.schedulingUrl ?? null,
      lastSyncedAt: connection?.syncedAt?.toISOString() ?? null,
    };
  }

  @Get('me/appointments')
  appointmentsForMe(@CurrentAuth() auth: AuthContext, @Query() query: AppointmentRangeQuery) {
    return this.appointments.listInRange(auth.organizationId, { ...query, agentId: auth.userId, leadId: undefined });
  }

  /** Emails of the members of the calendar in use; null when none is connected. */
  private async calendarEmails(orgId: string): Promise<Set<string> | null> {
    const connection = await this.prisma.calendarConnection.findFirst({ where: inUse(orgId), select: { id: true } });
    if (!connection) return null;
    const members = await this.prisma.calendarMember.findMany({
      where: { connectionId: connection.id },
      select: { email: true },
    });
    return new Set(members.map((m) => m.email.toLowerCase()));
  }
}

function readWeek(value: Prisma.JsonValue): WorkingDay[] {
  const days = Array.isArray(value) ? (value as unknown as WorkingDay[]) : [];
  return days.length === 7 ? days : [...DEFAULT_WORKING_HOURS];
}
