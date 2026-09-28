import { Injectable, Logger } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import { CalendlyClientService, type ConnectionRef } from '../calendly.client';
import type {
  CalendarConnectionMetadata,
  CalendlyEventType,
  CalendlyInvitee,
  CalendlyScheduledEvent,
} from '../types';
import type {
  BookingPage,
  CalendarProvider,
  NormalizedAttendee,
  NormalizedBooking,
  NormalizedEventType,
  NormalizedMember,
} from './types';

/** Pages per scope. 5 is 500 members / 300 event types, past any real office. */
const MAX_MEMBER_PAGES = 5;
const MAX_EVENT_TYPE_PAGES = 3;

/**
 * How many members we will ask individually for their event types.
 *
 * Calendly's developer support states that the organization scope returns
 * individual event types only — "You will have to make the request per user to
 * pull all the round robin event types" — so the shared team pages an office
 * actually books through are only visible one member at a time. The cap keeps a
 * large organization from turning one screen into a hundred upstream calls.
 *
 * Cal.com needs none of this: its team endpoint returns round-robin pages
 * directly. This is a Calendly quirk and it is contained here, where it
 * belongs, rather than in the shared service.
 */
const MAX_MEMBER_FANOUT = 25;

/**
 * Calendly, adapted to the shared calendar contract.
 *
 * Wraps CalendlyClientService without changing it: the OAuth dance, the
 * refresh-token rotation and the one-in-flight-refresh guard all stay where
 * they are, and this file is only the translation between Calendly's wire
 * shapes and the normalized ones.
 */
@Injectable()
export class CalendlyProvider implements CalendarProvider {
  readonly id = 'calendly' as const;
  readonly label = 'Calendly';

  private readonly logger = new Logger(CalendlyProvider.name);

  constructor(private readonly client: CalendlyClientService) {}

  async listBookings(
    conn: ConnectionRef,
    params: { minStart: Date; maxStart: Date; pageToken?: string | null },
  ): Promise<BookingPage> {
    const page = await this.client.listScheduledEvents(conn, {
      organizationUri: this.organizationUri(conn),
      minStart: params.minStart,
      maxStart: params.maxStart,
      pageToken: params.pageToken,
    });

    return {
      bookings: page.collection.map((e) => this.toBooking(e)),
      nextPageToken: page.pagination?.next_page_token ?? null,
    };
  }

  /**
   * Calendly returns no invitee with the event, so this is a second request.
   *
   * It is the reason `attendee` is null on every booking above, and the reason
   * the reconciler defers this call until it has already decided the booking is
   * worth writing.
   */
  async fetchAttendee(
    conn: ConnectionRef,
    booking: NormalizedBooking,
  ): Promise<NormalizedAttendee | null> {
    const eventUri = this.eventUriOf(conn, booking.externalId);
    const page = await this.client.listInvitees(conn, eventUri);
    if (!page.collection.length) return null;

    // A group event type can have several. Phase 1 attributes the appointment
    // to the first active one, which is a real limitation and is stated in the
    // UI rather than hidden.
    const invitee = page.collection.find((i) => i.status === 'active') ?? page.collection[0];
    return this.toAttendee(invitee);
  }

  async listMembers(conn: ConnectionRef): Promise<NormalizedMember[]> {
    const organizationUri = this.organizationUri(conn);
    const out: NormalizedMember[] = [];
    let pageToken: string | null | undefined;
    let pages = 0;

    do {
      const page = await this.client.listOrganizationMemberships(conn, {
        organizationUri,
        pageToken,
      });
      for (const m of page.collection) {
        out.push({
          hostId: m.user.uri,
          name: m.user.name,
          email: m.user.email,
          role: (m.role ?? 'user').toLowerCase(),
          schedulingUrl: m.user.scheduling_url ?? null,
          timezone: m.user.timezone ?? null,
        });
      }
      pageToken = page.pagination?.next_page_token ?? null;
      pages += 1;
    } while (pageToken && pages < MAX_MEMBER_PAGES);

    return out;
  }

  /**
   * The organization's event types, plus each linked member's, merged by URI.
   *
   * Both scopes are needed — see MAX_MEMBER_FANOUT. The member calls are
   * tolerant: one of them failing must not blank a list the organization scope
   * has already answered correctly.
   */
  async listEventTypes(
    conn: ConnectionRef,
    opts?: { memberHostIds?: string[] },
  ): Promise<NormalizedEventType[]> {
    const organizationUri = this.organizationUri(conn);
    const byUri = new Map<string, CalendlyEventType>();

    for (const et of await this.eventTypePages(conn, { organizationUri })) {
      byUri.set(et.uri, et);
    }

    for (const userUri of (opts?.memberHostIds ?? []).slice(0, MAX_MEMBER_FANOUT)) {
      try {
        for (const et of await this.eventTypePages(conn, { userUri })) byUri.set(et.uri, et);
      } catch (err) {
        this.logger.warn(`event types for ${userUri} failed (skipped): ${String(err)}`);
      }
    }

    return [...byUri.values()].map((et) => this.toEventType(et));
  }

  private async eventTypePages(
    conn: ConnectionRef,
    scope: { organizationUri?: string; userUri?: string },
  ): Promise<CalendlyEventType[]> {
    const out: CalendlyEventType[] = [];
    let pageToken: string | null | undefined;
    let pages = 0;

    do {
      const res = await this.client.listEventTypes(conn, { ...scope, pageToken });
      out.push(...res.collection);
      pageToken = res.pagination?.next_page_token ?? null;
      pages += 1;
    } while (pageToken && pages < MAX_EVENT_TYPE_PAGES);

    return out;
  }

  // ---------------------------------------------------------------------------

  private toBooking(e: CalendlyScheduledEvent): NormalizedBooking {
    return {
      externalId: this.uuidOf(e.uri),
      externalUpdatedAt: e.updated_at,
      title: e.name ?? null,
      startsAt: e.start_time,
      endsAt: e.end_time,
      // A cancelled event may turn out to be a RESCHEDULED one, which Calendly
      // records only on the invitee — a request away. The reconciler applies
      // that correction once it has the attendee; see NormalizedAttendee.rescheduled.
      status: e.status === 'canceled' ? 'cancelled' : 'scheduled',
      hostIds: (e.event_memberships ?? []).map((m) => m.user).filter(Boolean),
      meetingUrl: e.location?.join_url ?? e.location?.location ?? null,
      canceledReason: e.cancellation?.reason ?? null,
      // Always null: Calendly needs the second request.
      attendee: null,
    };
  }

  private toAttendee(i: CalendlyInvitee): NormalizedAttendee {
    return {
      email: i.email,
      name: i.name,
      phone: i.text_reminder_number,
      cancelUrl: i.cancel_url,
      rescheduleUrl: i.reschedule_url,
      rescheduled: i.rescheduled,
      externalId: i.uri,
    };
  }

  private toEventType(et: CalendlyEventType): NormalizedEventType {
    return {
      id: et.uri,
      name: et.name ?? 'Untitled event type',
      active: et.active,
      durationMinutes: et.duration,
      schedulingUrl: et.scheduling_url,
      poolingType: et.pooling_type ?? null,
      ownerName: et.profile?.name ?? null,
      ownerType: et.profile?.type ?? null,
    };
  }

  private organizationUri(conn: ConnectionRef): string {
    const meta = (conn.metadata ?? {}) as CalendarConnectionMetadata;
    if (!meta.calendlyOrgUri) {
      throw new AppError(
        'VALIDATION_ERROR',
        'This Calendly connection is missing its organization URI. Reconnect it.',
      );
    }
    return meta.calendlyOrgUri;
  }

  /** `evt-1` -> `https://api.calendly.com/scheduled_events/evt-1`. */
  private eventUriOf(conn: ConnectionRef, externalId: string): string {
    const meta = (conn.metadata ?? {}) as CalendarConnectionMetadata;
    const base = meta.calendlyOrgUri?.split('/organizations/')[0] ?? 'https://api.calendly.com';
    return `${base}/scheduled_events/${externalId}`;
  }

  /** `https://api.calendly.com/scheduled_events/{uuid}` -> `{uuid}`. */
  private uuidOf(uri: string): string {
    return uri.split('/').filter(Boolean).pop() ?? uri;
  }
}
