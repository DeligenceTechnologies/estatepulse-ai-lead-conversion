/**
 * A `calendar_connections` row, as much of it as a provider needs.
 *
 * Lives here rather than beside one provider's client because both read it:
 * `credentials_secret_ref` is an opaque encrypted blob holding whatever that
 * provider's credential is — an OAuth token pair for Calendly, an API key for
 * Cal.com — and `metadata` likewise holds whichever provider-shaped facts that
 * adapter wrote. `provider` is what says how to read either.
 */
export interface ConnectionRef {
  id: string;
  organization_id: string;
  provider: string;
  credentials_secret_ref: string | null;
  metadata: unknown;
}

/**
 * The shapes the rest of the calendar module works in, and the contract every
 * scheduling provider is adapted to.
 *
 * There is exactly one reconciler, one host-matching rule and one roster
 * matcher. They know nothing about Calendly or Cal.com — only about the
 * normalized booking below — so a provider is added by writing an adapter, not
 * by copying the logic that decides whose appointment a booking becomes.
 *
 * The two providers really are different underneath, and the normalization is
 * where that is absorbed:
 *
 *  - AUTH. Calendly is OAuth with a rotating refresh token; Cal.com is a
 *    long-lived API key. Both end up as one encrypted blob in
 *    `calendar_connections.credentials_secret_ref`, and only the adapter knows
 *    which.
 *  - HOST IDENTITY. Calendly names a host by URI, Cal.com by integer. Both are
 *    normalized to a STRING here, and matched against whichever of
 *    `agent_profiles.calendly_user_uri` / `cal_user_id` belongs to the
 *    connected provider.
 *  - ATTENDEES. Cal.com returns them inline; Calendly needs a second request
 *    per event. See `fetchAttendee`.
 *  - STATUS. Calendly says active/canceled and models a reschedule as
 *    cancel-plus-new-event; Cal.com says accepted/pending/cancelled/rejected
 *    and links the pair explicitly. Both are mapped to the vocabulary
 *    appointments_status_check already permits.
 */

/** The providers `calendar_connections.provider` may hold for a calendar. */
export type CalendarProviderId = 'calendly' | 'cal';

/** Which agent_profiles column holds this provider's host identity. */
export const HOST_ID_COLUMN = {
  calendly: 'calendly_user_uri',
  cal: 'cal_user_id',
} as const satisfies Record<CalendarProviderId, string>;

/**
 * A booking, provider-neutral.
 *
 * `externalId` is what `appointments.external_event_id` stores, and it is
 * unique per (organization, provider) rather than globally — the same string
 * from two providers is two different meetings.
 */
export interface NormalizedBooking {
  externalId: string;
  /**
   * The provider's own updated-at. The reconciler compares it against the
   * stored copy and skips everything else when they match, which is what keeps
   * a steady-state sweep down to one request instead of one per booking.
   */
  externalUpdatedAt: string;
  title: string | null;
  startsAt: string;
  endsAt: string;
  /** Mapped to appointments_status_check: scheduled | rescheduled | cancelled. */
  status: 'scheduled' | 'rescheduled' | 'cancelled';
  /**
   * Every host, as strings, most-authoritative first.
   *
   * A list rather than one value because a collective event type genuinely has
   * several; a round-robin booking has exactly one, its rotation already
   * resolved by the time the booking exists.
   */
  hostIds: string[];
  meetingUrl: string | null;
  canceledReason: string | null;
  /**
   * The person who booked, when the provider returned it with the booking.
   * Null means the reconciler must ask for it — see `fetchAttendee`.
   */
  attendee: NormalizedAttendee | null;
}

/** The person a booking is with — the one matched to a lead. */
export interface NormalizedAttendee {
  email: string | null;
  name: string | null;
  /** Only ever used as a match key when already in E.164. */
  phone: string | null;
  cancelUrl: string | null;
  rescheduleUrl: string | null;
  /**
   * True when this booking was not lost but MOVED.
   *
   * It lives on the attendee rather than the booking because of Calendly:
   * there, a reschedule is a cancellation plus a brand-new event, and the only
   * thing distinguishing the two is a flag on the invitee — which arrives a
   * request later than the event does. Cal.com decides it on the booking itself
   * and simply reports false here.
   *
   * The reconciler applies one rule for both: a cancelled booking whose
   * attendee says rescheduled is recorded as 'rescheduled', never as a lost
   * booking.
   */
  rescheduled: boolean;
  /** Provider reference, kept in appointments.metadata for support questions. */
  externalId: string | null;
}

/** One member of the office's scheduling team. */
export interface NormalizedMember {
  /** The join key, as a string. Matched to HOST_ID_COLUMN for this provider. */
  hostId: string;
  name: string;
  email: string;
  /** owner | admin | member, lowercased from whatever the provider calls it. */
  role: string;
  /** Their public booking page, when the provider exposes one. */
  schedulingUrl: string | null;
  timezone: string | null;
}

/** A bookable page. */
export interface NormalizedEventType {
  /** Stable per provider; used only to de-duplicate merged lists. */
  id: string;
  name: string;
  active: boolean;
  durationMinutes: number;
  schedulingUrl: string | null;
  /** round_robin | collective | multi_pool | managed | null. */
  poolingType: string | null;
  ownerName: string | null;
  ownerType: string | null;
}

/** One page of bookings, plus wherever the next one starts. */
export interface BookingPage {
  bookings: NormalizedBooking[];
  /** Opaque to the caller. Null when there is no next page. */
  nextPageToken: string | null;
}

/**
 * What a scheduling provider must be able to do.
 *
 * Deliberately READ-ONLY. Nothing here creates a booking, an event type or a
 * team member: those belong to the customer's scheduling account, are edited
 * there, and a copy in our database would be a second source of truth that is
 * wrong more often than it is right.
 *
 * Connecting is NOT on this interface. Calendly needs a browser round trip
 * through a consent screen and Cal.com needs a pasted key, and there is no
 * honest shared signature for those two — they stay on the services that own
 * each flow.
 */
export interface CalendarProvider {
  readonly id: CalendarProviderId;

  /** Human-readable, for error messages the owner reads. */
  readonly label: string;

  /**
   * One page of bookings that start inside the window.
   *
   * `pageToken` is whatever this provider handed back last; Calendly issues a
   * cursor, Cal.com counts offsets, and neither leaks past this boundary.
   */
  listBookings(
    conn: ConnectionRef,
    params: { minStart: Date; maxStart: Date; pageToken?: string | null },
  ): Promise<BookingPage>;

  /**
   * The person a booking is with, for providers that do not return them
   * inline. Called only when `NormalizedBooking.attendee` is null AND the
   * reconciler has decided the booking is worth writing — so an unchanged
   * event, or one hosted by nobody we know, never costs this request.
   */
  fetchAttendee(conn: ConnectionRef, booking: NormalizedBooking): Promise<NormalizedAttendee | null>;

  /** Everyone on the office's scheduling team. */
  listMembers(conn: ConnectionRef): Promise<NormalizedMember[]>;

  /**
   * The bookable pages, round-robin ones included.
   *
   * `memberHostIds` is the roster this office has linked, and exists for
   * Calendly alone: its organization scope omits shared event types, so the
   * round-robin pages a team actually books through are only reachable one
   * member at a time. Cal.com returns them from the team endpoint and ignores
   * this argument.
   */
  listEventTypes(
    conn: ConnectionRef,
    opts?: { memberHostIds?: string[] },
  ): Promise<NormalizedEventType[]>;
}
