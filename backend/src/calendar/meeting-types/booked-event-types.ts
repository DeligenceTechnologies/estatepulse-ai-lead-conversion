import type { PrismaService } from '@/common/prisma/prisma.service';

/**
 * The event types the connection's synced meetings were booked on. Passed to
 * the provider's event type reads: Calendly's list leaves some shared pages
 * out (a multi-pool event), and these are how they are found.
 */
export async function bookedEventTypeIds(prisma: PrismaService, connectionId: string): Promise<string[]> {
  const rows = await prisma.calendarMeeting.findMany({
    where: { connectionId, eventTypeId: { not: null } },
    distinct: ['eventTypeId'],
    select: { eventTypeId: true },
  });
  return rows.map((row) => row.eventTypeId!);
}
