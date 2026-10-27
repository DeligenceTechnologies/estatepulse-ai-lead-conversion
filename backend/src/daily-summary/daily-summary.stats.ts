import { CallStatus, LeadTemperature } from '@prisma/client';
import type { PrismaService } from '@/common/prisma/prisma.service';
import { INACTIVE_STATUSES } from '@/lead/lead-status';

export interface SummaryWindow {
  /** Local midnight that starts the day. */
  from: Date;
  /** The moment the summary is taken: now, or the next midnight for a day already over. */
  to: Date;
  /** The local day after, for "tomorrow's meetings". */
  tomorrowFrom: Date;
  tomorrowTo: Date;
}

export interface DailySummaryStats {
  leads: { total: number; hot: number; topSources: { name: string; count: number }[] };
  calls: { total: number; connected: number; noAnswer: number; failed: number; talkSeconds: number };
  texts: { sent: number; replies: number };
  meetings: { booked: number; canceled: number; tomorrow: number };
  attention: { needsReview: number; unassigned: number };
}

const TOP_SOURCES = 3;

/** Read in parallel; every query is scoped to the organization and bounded by the window. */
export async function collectDailySummary(prisma: PrismaService, orgId: string, w: SummaryWindow): Promise<DailySummaryStats> {
  const today = { gte: w.from, lt: w.to };
  const [
    leadsTotal,
    leadsHot,
    bySource,
    callsByStatus,
    talk,
    textsSent,
    replies,
    booked,
    canceled,
    tomorrow,
    needsReview,
    unassigned,
  ] = await Promise.all([
    prisma.lead.count({ where: { orgId, createdAt: today } }),
    prisma.lead.count({ where: { orgId, createdAt: today, temperature: LeadTemperature.hot } }),
    prisma.lead.groupBy({
      by: ['leadSourceId'],
      where: { orgId, createdAt: today },
      _count: { _all: true },
    }),
    prisma.call.groupBy({ by: ['status'], where: { orgId, createdAt: today }, _count: { _all: true } }),
    prisma.call.aggregate({ where: { orgId, createdAt: today, status: CallStatus.completed }, _sum: { durationSeconds: true } }),
    prisma.message.count({ where: { orgId, createdAt: today, direction: 'outbound' } }),
    prisma.message.count({ where: { orgId, createdAt: today, direction: 'inbound' } }),
    prisma.calendarMeeting.count({ where: { orgId, createdAt: today, status: { not: 'canceled' } } }),
    prisma.calendarMeeting.count({ where: { orgId, status: 'canceled', updatedAt: today } }),
    prisma.calendarMeeting.count({
      where: { orgId, startsAt: { gte: w.tomorrowFrom, lt: w.tomorrowTo }, status: { in: ['scheduled', 'pending'] } },
    }),
    prisma.lead.count({ where: { orgId, needsReview: true, status: { notIn: INACTIVE_STATUSES } } }),
    prisma.lead.count({ where: { orgId, assignedToId: null, status: { notIn: INACTIVE_STATUSES } } }),
  ]);

  const sourceIds = bySource.map((row) => row.leadSourceId).filter((id): id is string => id !== null);
  const names = sourceIds.length
    ? new Map(
        (await prisma.leadSource.findMany({ where: { orgId, id: { in: sourceIds } }, select: { id: true, name: true } })).map(
          (s) => [s.id, s.name] as const,
        ),
      )
    : new Map<string, string>();

  const callCount = (status: CallStatus) => callsByStatus.find((row) => row.status === status)?._count._all ?? 0;

  return {
    leads: {
      total: leadsTotal,
      hot: leadsHot,
      topSources: bySource
        .map((row) => ({ name: (row.leadSourceId && names.get(row.leadSourceId)) || 'Added manually', count: row._count._all }))
        .sort((a, b) => b.count - a.count)
        .slice(0, TOP_SOURCES),
    },
    calls: {
      total: callsByStatus.reduce((sum, row) => sum + row._count._all, 0),
      connected: callCount(CallStatus.completed),
      noAnswer: callCount(CallStatus.no_answer),
      failed: callCount(CallStatus.failed),
      talkSeconds: talk._sum.durationSeconds ?? 0,
    },
    texts: { sent: textsSent, replies },
    meetings: { booked, canceled, tomorrow },
    attention: { needsReview, unassigned },
  };
}

/** Nothing happened and nothing is coming: not worth an email. */
export function isQuietDay(stats: DailySummaryStats): boolean {
  return (
    stats.leads.total === 0 &&
    stats.calls.total === 0 &&
    stats.texts.sent === 0 &&
    stats.texts.replies === 0 &&
    stats.meetings.booked === 0 &&
    stats.meetings.canceled === 0 &&
    stats.meetings.tomorrow === 0
  );
}
