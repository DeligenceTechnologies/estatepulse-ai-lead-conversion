import { CalendarMeetingStatus } from '@prisma/client';
import type { PrismaService } from '@/common/prisma/prisma.service';

/** Confirmed, or waiting on the host to confirm: either way the lead has made a booking. */
const BOOKED: CalendarMeetingStatus[] = [CalendarMeetingStatus.scheduled, CalendarMeetingStatus.pending];

/**
 * Whether the lead has a meeting on the calendar that has not ended yet.
 * Nothing automated reaches a lead with one, whatever their status says: an
 * agent may have moved the status by hand, or a booking may have been recorded
 * without the status following.
 */
export async function hasUpcomingMeeting(prisma: Pick<PrismaService, 'calendarMeeting'>, orgId: string, leadId: string, now = new Date()): Promise<boolean> {
  const meetings = await prisma.calendarMeeting.count({ where: { orgId, leadId, status: { in: BOOKED }, endsAt: { gt: now } } });
  return meetings > 0;
}

/** The lead's next meeting that has not ended yet, as hasUpcomingMeeting counts them; null when it has none. */
export async function nextMeeting(prisma: Pick<PrismaService, 'calendarMeeting'>, orgId: string, leadId: string, now = new Date()) {
  return prisma.calendarMeeting.findFirst({
    where: { orgId, leadId, status: { in: BOOKED }, endsAt: { gt: now } },
    orderBy: { startsAt: 'asc' },
    select: { startsAt: true, hosts: true, rescheduleUrl: true, cancelUrl: true, hostUser: { select: { firstName: true, lastName: true } } },
  });
}

export type UpcomingMeeting = NonNullable<Awaited<ReturnType<typeof nextMeeting>>>;
