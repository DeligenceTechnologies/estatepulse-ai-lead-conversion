import { Injectable } from '@nestjs/common';
import type { ConnectionRef } from '../calendly.client';
import { CalComClientService } from './calcom.client';
import type {
  CalComBooking,
  CalComConnectionMetadata,
  CalComTeamEventType,
  CalComTeamMembership,
} from './calcom.types';
import type {
  BookingPage,
  CalendarProvider,
  NormalizedAttendee,
  NormalizedBooking,
  NormalizedEventType,
  NormalizedMember,
} from './types';

/** Cal.com pages by offset; 100 a page, 5 pages of roster is 500 members. */
const PAGE_SIZE = 100;
const MAX_MEMBER_PAGES = 5;

/** Cal.com's camelCase scheduling types, in the vocabulary the UI already uses. */
const POOLING: Record<string, string> = {
  roundRobin: 'round_robin',
  collective: 'collective',
  managed: 'managed',
};

/**
 * Cal.com, adapted to the shared calendar contract.
 *
 * The office pastes an API key belonging to an owner or admin of a Cal.com
 * TEAM — not an Organization, which is a separate paid tier behind different
 * endpoints — and every member's bookings are read through it.
 *
 * Two things are genuinely easier here than on Calendly, and both show up as
 * code that is absent:
 *
 *  - Attendees arrive WITH the booking, so `fetchAttendee` never makes a
 *    request. On Calendly that is one extra call per changed event.
 *  - A reschedule is explicit (`rescheduledToUid`), where Calendly models it as
 *    a cancellation plus an unrelated-looking new event.
 */
@Injectable()
export class CalComProvider implements CalendarProvider {
  readonly id = 'cal' as const;
  readonly label = 'Cal.com';

  constructor(private readonly client: CalComClientService) {}

  async listBookings(
    conn: ConnectionRef,
    params: { minStart: Date; maxStart: Date; pageToken?: string | null },
  ): Promise<BookingPage> {
    // The page token IS the offset. Opaque to the caller by contract, which is
    // what lets Calendly hand back a cursor from the same method.
    const skip = Number(params.pageToken ?? 0) || 0;
    const page = await this.client.listTeamBookings(conn, {
      minStart: params.minStart,
      maxStart: params.maxStart,
      skip,
      take: PAGE_SIZE,
    });

    const bookings = (page.data ?? []).map((b) => this.toBooking(b));
    // Offset pagination has no end marker, so a short page is the end. Trusting
    // `pagination.hasNextPage` alone would loop forever if it were ever absent.
    const more = bookings.length === PAGE_SIZE && page.pagination?.hasNextPage !== false;

    return { bookings, nextPageToken: more ? String(skip + PAGE_SIZE) : null };
  }

  /** Never called: `toBooking` always populates `attendee` when there is one. */
  async fetchAttendee(): Promise<NormalizedAttendee | null> {
    return null;
  }

  async listMembers(conn: ConnectionRef): Promise<NormalizedMember[]> {
    const out: NormalizedMember[] = [];
    for (let page = 0; page < MAX_MEMBER_PAGES; page += 1) {
      const res = await this.client.listTeamMemberships(conn, {
        skip: page * PAGE_SIZE,
        take: PAGE_SIZE,
      });
      const rows = res.data ?? [];
      out.push(...rows.filter((m) => m.accepted).map((m) => this.toMember(m)));
      if (rows.length < PAGE_SIZE) break;
    }
    return out;
  }

  async listEventTypes(conn: ConnectionRef): Promise<NormalizedEventType[]> {
    const rows = await this.client.listTeamEventTypes(conn);
    // The team slug is what turns an event type into a link somebody can be
    // sent. It is stored at connect time because the event-type payload does
    // not repeat it, and a page with no URL is no use to whoever has to hand a
    // lead a booking link.
    const meta = (conn.metadata ?? {}) as CalComConnectionMetadata;
    return rows.map((et) => this.toEventType(et, meta.calTeamSlug ?? null));
  }

  // ---------------------------------------------------------------------------

  private toBooking(b: CalComBooking): NormalizedBooking {
    const attendee = b.attendees?.[0] ?? null;

    return {
      externalId: b.uid,
      externalUpdatedAt: b.updatedAt,
      title: b.title ?? null,
      startsAt: b.start,
      endsAt: b.end,
      status: this.statusOf(b),
      // Already resolved by Cal.com: a round-robin booking names the single
      // host its rotation picked, and a collective one names them all.
      hostIds: (b.hosts ?? []).map((h) => String(h.id)),
      meetingUrl: b.meetingUrl ?? b.location ?? null,
      canceledReason: b.cancellationReason ?? null,
      attendee: attendee
        ? {
            email: attendee.email ?? null,
            name: attendee.name ?? null,
            phone: attendee.phoneNumber ?? null,
            // Cal.com issues no per-attendee cancel/reschedule links the way
            // Calendly does; the booking page serves both. Left null rather
            // than guessed — a wrong link here is one a lead would click.
            cancelUrl: null,
            rescheduleUrl: null,
            // Cal.com settles this on the booking itself (rescheduledToUid),
            // which `statusOf` has already read. Nothing is deferred to the
            // attendee the way it is on Calendly.
            rescheduled: false,
            externalId: b.uid,
          }
        : null,
    };
  }

  /**
   * Cal.com's status, in the vocabulary appointments_status_check permits.
   *
   * `rescheduledToUid` is the interesting one. A rescheduled booking is
   * reported as cancelled, and recording that as a lost booking would be wrong
   * on a screen where lost bookings matter — the meeting did not go away, it
   * moved, and the replacement arrives in the same sweep as an ordinary new
   * booking.
   *
   * 'pending' and 'accepted' both map to scheduled. A booking awaiting
   * confirmation is still a commitment in the diary, and the outbound cadence
   * should stop either way.
   */
  private statusOf(b: CalComBooking): NormalizedBooking['status'] {
    if (b.status === 'cancelled' || b.status === 'rejected') {
      return b.rescheduledToUid ? 'rescheduled' : 'cancelled';
    }
    return 'scheduled';
  }

  private toMember(m: CalComTeamMembership): NormalizedMember {
    const username = m.user?.username ?? null;
    return {
      hostId: String(m.userId),
      name: m.user?.name || m.user?.email || `User ${m.userId}`,
      email: m.user?.email ?? '',
      role: (m.role ?? 'member').toLowerCase(),
      schedulingUrl: username ? `${this.bookingBase}/${username}` : null,
      // Cal.com's membership payload carries no timezone; it is on the user's
      // own profile, which this key may not read for every member.
      timezone: null,
    };
  }

  private toEventType(et: CalComTeamEventType, teamSlug: string | null): NormalizedEventType {
    return {
      id: String(et.id),
      name: et.title || 'Untitled event type',
      // Cal.com says `hidden`, Calendly says `active`. Same fact, inverted.
      active: !et.hidden,
      durationMinutes: et.lengthInMinutes,
      // Composed, because Cal.com returns the slugs and not the link. Null
      // rather than a half-built URL when the slug is missing: a booking link
      // that 404s is worse than none, because it is one a lead would click.
      schedulingUrl:
        teamSlug && et.slug ? `${this.bookingBase}/team/${teamSlug}/${et.slug}` : null,
      poolingType: et.schedulingType ? (POOLING[et.schedulingType] ?? et.schedulingType) : null,
      ownerName: null,
      ownerType: 'Team',
    };
  }

  /**
   * Where Cal.com's booking pages live. Not the API host, and not derived from
   * it — a self-hosted Cal.com puts its API and its booking pages on different
   * names, and guessing one from the other would produce links that resolve to
   * nothing.
   */
  private get bookingBase(): string {
    return this.client.bookingBaseUrl;
  }
}
