import { Injectable } from '@nestjs/common';
import type { CalendarMeeting } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';
import type { BookedMeeting, MeetingPerson, SchedulingEventType } from '../calendar.types';
import { CalendarAccessService } from '../connection/calendar-access.service';
import { SchedulingProvider } from '../providers/scheduling-provider';
import { CalendarSyncService, MEETINGS_AHEAD_DAYS, MEETINGS_PAST_DAYS } from '../sync/calendar-sync.service';

const DAY_MS = 24 * 60 * 60_000;

export interface MeetingTypesReport {
  eventTypes: SchedulingEventType[];
  /** Booked meetings in the window, oldest first. Match them to event types by `eventTypeId`. */
  meetings: BookedMeeting[];
  meetingsWindow: { from: string; to: string };
  /** When the meetings were last read from the provider; null before the first time. */
  meetingsSyncedAt: string | null;
  /** Set when the meetings could not be read from the provider and none are saved yet. */
  meetingsError: string | null;
}

/**
 * The meetings leads can book (Calendly / Cal.com event types, read live) and
 * who has booked them (synced into the database, see CalendarSyncService).
 */
@Injectable()
export class MeetingTypesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CalendarAccessService,
    private readonly provider: SchedulingProvider,
    private readonly sync: CalendarSyncService,
  ) {}

  async list(orgId: string): Promise<MeetingTypesReport> {
    // Waits for the first sync, and refreshes stale data in the background.
    let connection = await this.sync.freshConnection(orgId);
    if (!connection.meetingsSyncedAt && !connection.meetingsError) {
      // Synced before meetings were saved (or a sync is mid-way): read them once now.
      await this.sync.sync(connection.id, 'now').catch(() => undefined);
      connection = await this.sync.freshConnection(orgId);
    }
    const now = Date.now();
    const from = new Date(now - MEETINGS_PAST_DAYS * DAY_MS);
    const to = new Date(now + MEETINGS_AHEAD_DAYS * DAY_MS);

    const [eventTypes, rows] = await Promise.all([
      this.access.useActive(orgId, (active, secret) => this.provider.eventTypes(active, secret)),
      this.prisma.calendarMeeting.findMany({
        where: { connectionId: connection.id, startsAt: { gte: from, lte: to } },
        orderBy: [{ startsAt: 'asc' }, { externalId: 'asc' }],
      }),
    ]);

    return {
      eventTypes,
      meetings: rows.map((row) => toBookedMeeting(row, now)),
      meetingsWindow: { from: from.toISOString(), to: to.toISOString() },
      meetingsSyncedAt: connection.meetingsSyncedAt?.toISOString() ?? null,
      meetingsError:
        connection.meetingsError && !connection.meetingsSyncedAt ? 'Couldn’t load booked meetings. Try refreshing.' : null,
    };
  }
}

/** A saved meeting as the API shape. Reschedule and cancel links only while it can still be changed. */
export function toBookedMeeting(row: CalendarMeeting, now: number): BookedMeeting {
  const open = row.status !== 'canceled' && row.endsAt.getTime() > now;
  return {
    id: row.externalId,
    eventTypeId: row.eventTypeId,
    title: row.title,
    start: row.startsAt.toISOString(),
    end: row.endsAt.toISOString(),
    timezone: row.timezone,
    status: row.status,
    invitees: people(row.invitees),
    hosts: people(row.hosts),
    meetingUrl: row.meetingUrl,
    location: row.location,
    rescheduleUrl: open ? row.rescheduleUrl : null,
    cancelUrl: open ? row.cancelUrl : null,
    canceledReason: row.status === 'canceled' ? row.canceledReason : null,
  };
}

function people(value: unknown): MeetingPerson[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((person): person is Record<string, unknown> => Boolean(person) && typeof person === 'object')
    .map((person) => ({
      name: typeof person.name === 'string' ? person.name : '',
      email: typeof person.email === 'string' ? person.email : null,
      timezone: typeof person.timezone === 'string' ? person.timezone : null,
    }));
}
