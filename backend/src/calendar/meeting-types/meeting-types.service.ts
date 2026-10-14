import { Injectable, Logger } from '@nestjs/common';
import type { BookedMeeting, SchedulingEventType } from '../calendar.types';
import { CalendarAccessService } from '../connection/calendar-access.service';
import { ProviderHttpError } from '../providers/provider-http';
import { SchedulingProvider } from '../providers/scheduling-provider';

const DAY_MS = 24 * 60 * 60_000;
/** Two weeks back covers "Last week" whatever today is; a month ahead covers upcoming. */
const PAST_DAYS = 14;
const UPCOMING_DAYS = 30;

export interface MeetingTypesReport {
  eventTypes: SchedulingEventType[];
  /** Booked meetings in the window, oldest first. Match them to event types by `eventTypeId`. */
  meetings: BookedMeeting[];
  meetingsWindow: { from: string; to: string };
  /** Set when the meeting types loaded but the booked meetings could not. */
  meetingsError: string | null;
}

/**
 * The meetings leads can book (Calendly / Cal.com event types) and who has
 * booked them, read live from the provider.
 */
@Injectable()
export class MeetingTypesService {
  private readonly logger = new Logger(MeetingTypesService.name);

  constructor(
    private readonly access: CalendarAccessService,
    private readonly provider: SchedulingProvider,
  ) {}

  list(orgId: string): Promise<MeetingTypesReport> {
    const now = Date.now();
    const from = new Date(now - PAST_DAYS * DAY_MS);
    const to = new Date(now + UPCOMING_DAYS * DAY_MS);

    return this.access.useActive(orgId, async (connection, secret) => {
      const [eventTypes, meetings] = await Promise.all([
        this.provider.eventTypes(connection, secret),
        this.provider.meetings(connection, secret, from, to).then(
          (list) => ({ list, error: null }),
          (error: unknown) => {
            // A rejected credential must still reach the access service, which parks the connection.
            if (error instanceof ProviderHttpError && error.credentialRejected) throw error;
            this.logger.warn(`Booked meetings unavailable for org ${orgId}: ${(error as Error).message}`);
            return { list: [], error: 'Couldn’t load booked meetings. Try refreshing.' };
          },
        ),
      ]);
      return {
        eventTypes,
        meetings: meetings.list,
        meetingsWindow: { from: from.toISOString(), to: to.toISOString() },
        meetingsError: meetings.error,
      };
    });
  }
}
