import { Injectable } from '@nestjs/common';
import { CalendarMeetingStatus, type Prisma } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';
import { fullName } from '@/lead/lead-scope';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PAST_DAYS = 30;
const DEFAULT_FUTURE_DAYS = 90;
const MAX_ROWS = 500;

export interface AppointmentRange {
  from?: Date;
  to?: Date;
  status?: CalendarMeetingStatus;
  agentId?: string;
  leadId?: string;
}

export interface AppointmentDTO {
  id: string;
  leadId: string;
  leadName: string;
  leadEmail: string | null;
  leadPhone: string | null;
  leadStatus: string;
  agentId: string | null;
  agentName: string;
  provider: string;
  externalEventId: string;
  startTime: string;
  endTime: string;
  status: string;
  appointmentType: string | null;
  meetingUrl: string | null;
  notes: string | null;
  cancelUrl: string | null;
  rescheduleUrl: string | null;
  canceledReason: string | null;
  createdAt: string;
}

const INCLUDE = {
  lead: { select: { firstName: true, lastName: true, email: true, phone: true, status: true } },
  hostUser: { select: { id: true, firstName: true, lastName: true } },
  connection: { select: { provider: true } },
} satisfies Prisma.CalendarMeetingInclude;

type Row = Prisma.CalendarMeetingGetPayload<{ include: typeof INCLUDE }>;

/** Calendar meetings booked by a lead, as appointments. */
@Injectable()
export class AppointmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async listInRange(orgId: string, q: AppointmentRange): Promise<AppointmentDTO[]> {
    const now = Date.now();
    const rows = await this.prisma.calendarMeeting.findMany({
      where: {
        orgId,
        leadId: q.leadId ?? { not: null },
        startsAt: {
          gte: q.from ?? new Date(now - DEFAULT_PAST_DAYS * DAY_MS),
          lte: q.to ?? new Date(now + DEFAULT_FUTURE_DAYS * DAY_MS),
        },
        status: q.status ?? { not: CalendarMeetingStatus.rescheduled },
        ...(q.agentId ? { hostUserId: q.agentId } : {}),
      },
      orderBy: { startsAt: 'asc' },
      take: MAX_ROWS,
      include: INCLUDE,
    });
    return rows.map(toDto);
  }

  async upcomingFor(orgId: string, userId: string): Promise<AppointmentDTO[]> {
    const rows = await this.prisma.calendarMeeting.findMany({
      where: { orgId, hostUserId: userId, leadId: { not: null }, startsAt: { gte: new Date() }, status: 'scheduled' },
      orderBy: { startsAt: 'asc' },
      take: 50,
      include: INCLUDE,
    });
    return rows.map(toDto);
  }

  async forLead(orgId: string, leadId: string): Promise<AppointmentDTO[]> {
    const rows = await this.prisma.calendarMeeting.findMany({
      where: { orgId, leadId, status: { not: CalendarMeetingStatus.rescheduled } },
      orderBy: { startsAt: 'desc' },
      take: 50,
      include: INCLUDE,
    });
    return rows.map(toDto);
  }
}

function toDto(row: Row): AppointmentDTO {
  const lead = row.lead;
  return {
    id: row.id,
    leadId: row.leadId!,
    leadName: fullName(lead?.firstName, lead?.lastName) || lead?.email || lead?.phone || 'Unnamed lead',
    leadEmail: lead?.email ?? null,
    leadPhone: lead?.phone ?? null,
    leadStatus: lead?.status ?? 'unknown',
    agentId: row.hostUserId,
    agentName: row.hostUser ? fullName(row.hostUser.firstName, row.hostUser.lastName) : 'Unassigned',
    provider: row.connection.provider,
    externalEventId: row.externalId,
    startTime: row.startsAt.toISOString(),
    endTime: row.endsAt.toISOString(),
    status: row.status === CalendarMeetingStatus.canceled ? 'cancelled' : row.status,
    appointmentType: row.title,
    meetingUrl: row.meetingUrl,
    notes: null,
    cancelUrl: row.cancelUrl,
    rescheduleUrl: row.rescheduleUrl,
    canceledReason: row.canceledReason,
    createdAt: row.createdAt.toISOString(),
  };
}
