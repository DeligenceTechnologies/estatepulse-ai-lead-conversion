import type { CalendarConnectionMetadata } from '../types';

/**
 * Cal.com's wire shapes, and only the fields we actually read.
 *
 * Taken from their published OpenAPI document rather than from prose, so the
 * optionality below is Cal.com's own: anything marked required there is
 * non-optional here, and the rest is not.
 */

/** Cal.com wraps every response in `{ status, data }`. */
export interface CalComList<T> {
  status: string;
  data: T[];
  pagination?: {
    totalItems?: number;
    remainingItems?: number;
    returnedItems?: number;
    itemsPerPage?: number;
    currentPage?: number;
    totalPages?: number;
    hasNextPage?: boolean;
    hasPreviousPage?: boolean;
  };
}

/** `GET /me` */
export interface CalComUser {
  id: number;
  username: string;
  email: string;
  name: string;
  timeZone: string;
  organizationId?: number | null;
}

/** `GET /teams` */
export interface CalComTeam {
  id: number;
  name: string;
  slug?: string | null;
  logoUrl?: string | null;
  /**
   * True for a Cal.com ORGANIZATION rather than a plain team. Organizations are
   * a separate paid tier and their bookings live behind
   * /organizations/{orgId}/..., so one cannot be used here.
   */
  isOrganization?: boolean;
  parentId?: number | null;
}

/** `GET /teams/{teamId}/memberships` */
export interface CalComTeamMembership {
  id: number;
  /** The join key — the same number a booking reports as `hosts[].id`. */
  userId: number;
  teamId: number;
  /** False while an invitation is outstanding. */
  accepted: boolean;
  /** 'OWNER' | 'ADMIN' | 'MEMBER'. */
  role: string;
  user: {
    email: string;
    username?: string | null;
    name?: string | null;
    avatarUrl?: string | null;
  };
}

/** A booking's host. `id` is the Cal.com user id. */
export interface CalComBookingHost {
  id: number;
  name: string;
  email: string;
  username: string;
  timeZone: string;
}

export interface CalComBookingAttendee {
  name: string;
  email: string;
  timeZone: string;
  absent?: boolean;
  phoneNumber?: string | null;
}

/** `GET /teams/{teamId}/bookings` */
export interface CalComBooking {
  id: number;
  /** The stable public identifier; what we store as external_event_id. */
  uid: string;
  title: string | null;
  /** 'cancelled' | 'accepted' | 'rejected' | 'pending'. */
  status: string;
  start: string;
  end: string;
  duration: number;
  eventTypeId?: number;
  eventType?: { id: number; slug: string } | null;
  meetingUrl?: string | null;
  location?: string | null;
  createdAt: string;
  updatedAt: string;
  cancellationReason?: string | null;
  cancelledByEmail?: string | null;
  reschedulingReason?: string | null;
  /**
   * Set on the OLD booking of a reschedule pair. Cal.com links the two
   * explicitly, where Calendly leaves it to be inferred from a flag on the
   * invitee — so a reschedule is unambiguous here.
   */
  rescheduledToUid?: string | null;
  rescheduledFromUid?: string | null;
  hosts: CalComBookingHost[];
  attendees: CalComBookingAttendee[];
  /** Booking metadata, including what a booking link passed as `metadata[key]=`. */
  metadata?: Record<string, unknown> | null;
}

/** `GET /teams/{teamId}/event-types` */
export interface CalComTeamEventType {
  id: number;
  title: string;
  slug: string;
  lengthInMinutes: number;
  hidden?: boolean;
  teamId?: number;
  /**
   * 'roundRobin' | 'collective' | 'managed'. Cal.com's equivalent of Calendly's
   * `pooling_type`, spelled in camelCase.
   */
  schedulingType?: string | null;
  assignAllTeamMembers?: boolean;
  hosts?: Array<{ userId: number }> | null;
}

/**
 * `calendar_connections.metadata` for a Cal.com connection.
 *
 * Extends the shared shape so one DTO mapper serves both providers; the fields
 * below are the ones only Cal.com has.
 */
export interface CalComConnectionMetadata extends CalendarConnectionMetadata {
  /** The Cal.com user whose API key this is. */
  calUserId?: number;
  /** The team whose bookings this connection reads. */
  calTeamId?: number;
  calTeamName?: string;
  calTeamSlug?: string;
  /** owner | admin | member — the key holder's role on that team. */
  calTeamRole?: string;
}
