import type { CalendarProvider } from '@prisma/client';

/** Base path of every organization calendar endpoint. */
export const CALENDAR_ROUTE = 'org-settings/calendar';

export const PROVIDER_LABEL: Record<CalendarProvider, string> = {
  calendly: 'Calendly',
  cal: 'Cal.com',
};

export type WorkspaceRole = 'owner' | 'admin' | 'member';

export type PoolingType = 'round_robin' | 'collective' | 'managed' | 'multi_pool';

export interface ProviderAccount {
  id: string;
  email: string | null;
  name: string | null;
}

export interface SchedulingMember {
  externalId: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  schedulingUrl: string | null;
  timezone: string | null;
  username: string | null;
}

export interface CalendarMemberView extends SchedulingMember {
  userId: string | null;
  userName: string | null;
  /** Their working hours in the calendar, as last synced; null when unknown. */
  schedule: WeeklySchedule | null;
}

export interface SchedulingEventType {
  id: string;
  name: string;
  durationMinutes: number;
  bookingUrl: string | null;
  poolingType: PoolingType | null;
  hostName: string | null;
  /** The colour the provider shows for it, as `#rrggbb`; null when it has none. */
  color: string | null;
}

export type MeetingStatus = 'scheduled' | 'pending' | 'canceled' | 'rescheduled';

export interface MeetingPerson {
  name: string;
  email: string | null;
  /** Their IANA timezone, when the provider gives one. */
  timezone: string | null;
}

/** A meeting someone booked on one of the workspace's event types. */
export interface BookedMeeting {
  id: string;
  /** Matches `SchedulingEventType.id`; null when the provider did not say. */
  eventTypeId: string | null;
  title: string;
  start: string;
  end: string;
  /** The host's timezone: the clock the meeting was set in. */
  timezone: string | null;
  status: MeetingStatus;
  /** Who booked (Calendly invitees, Cal.com attendees). */
  invitees: MeetingPerson[];
  hosts: MeetingPerson[];
  /** The video call link (Zoom, Google Meet, Teams, Cal Video…), when there is one. */
  meetingUrl: string | null;
  /** Where it happens when that is not a link: an address, a phone number, or a description. */
  location: string | null;
  rescheduleUrl: string | null;
  cancelUrl: string | null;
  canceledReason: string | null;
  /** The EstatePulse lead id the booking link carried, when it was booked from one. */
  leadRef?: string | null;
}

export interface ScheduleInterval {
  /** 'HH:MM', wall-clock in the schedule's timezone. */
  from: string;
  to: string;
}

/** Someone's recurring working hours as their calendar has them. */
export interface WeeklySchedule {
  timezone: string | null;
  /** Keyed by day of week, '0' = Sunday .. '6' = Saturday; a missing or empty day is off. */
  weekly: Record<string, ScheduleInterval[]>;
}

export interface CalendlyCredentials {
  accessToken: string;
  refreshToken: string;
}

export interface CalCredentials {
  apiKey: string;
}

export interface CalendlyOAuthState {
  orgId: string;
  userId: string;
  expiresAt: number;
  /** sha256 of the nonce kept in the starting browser's cookie, so only that browser can finish the sign-in. */
  nonceHash: string;
}

/** HttpOnly cookie that ties a Calendly sign-in to the browser that started it. */
export const CALENDLY_OAUTH_COOKIE = 'calendly_oauth';

export type BusySource = 'booking' | 'hold' | 'calendar';

export type AvailabilityStatus = 'ok' | 'limited' | 'unavailable';

export interface TimeRange {
  start: string;
  end: string;
}

export interface BusyRange extends TimeRange {
  source: BusySource;
}

export interface MemberAvailabilitySource {
  hours: TimeRange[] | null;
  free: TimeRange[];
  busy: BusyRange[];
  status: AvailabilityStatus;
  message: string | null;
}
