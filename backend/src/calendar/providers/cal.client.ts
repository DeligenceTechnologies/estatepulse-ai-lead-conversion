import { Injectable, Logger } from '@nestjs/common';
import type {
  BookedMeeting,
  WeeklySchedule,
  PoolingType,
  ProviderAccount,
  SchedulingEventType,
  SchedulingMember,
  WorkspaceRole,
} from '../calendar.types';
import { hexColor, meetingPlace } from './meeting-location';
import { requestJson } from './provider-http';

const API_BASE = 'https://api.cal.com/v2';
const BOOKING_BASE = 'https://cal.com';
const PROVIDER = 'Cal.com';
const EVENT_TYPES_API_VERSION = '2024-06-14';
const SLOTS_API_VERSION = '2024-09-04';
const BOOKINGS_API_VERSION = '2024-08-13';
const SCHEDULES_API_VERSION = '2024-06-11';
const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};
const BOOKINGS_PAGE_SIZE = 100;
const WEBHOOK_TRIGGERS = ['BOOKING_CREATED', 'BOOKING_RESCHEDULED', 'BOOKING_CANCELLED', 'BOOKING_REQUESTED', 'BOOKING_REJECTED'];
const PAGE_SIZE = 250;
/** Up to 12,500 members and 5,000 bookings per read. Past that the rest is skipped (and logged), not failed. */
const MAX_PAGES = 50;

interface Envelope<T> {
  status: string;
  data: T;
}

interface CalMe {
  id: number;
  email: string;
  name: string | null;
  username: string | null;
  timeZone: string | null;
}

export interface CalAccount extends ProviderAccount {
  username: string | null;
  timezone: string | null;
}

export interface CalTeam {
  id: number;
  name: string;
  slug: string | null;
  isOrganization: boolean;
}

interface CalMembership {
  userId: number;
  accepted: boolean;
  role: string;
  user: { email: string; name: string | null; username: string | null };
}

interface CalEventType {
  id: number;
  slug: string;
  title: string;
  lengthInMinutes: number;
  hidden: boolean;
  schedulingType?: string | null;
  eventTypeColor?: { lightEventTypeColor?: string | null; darkEventTypeColor?: string | null } | null;
  hosts?: { name?: string | null }[];
}

interface CalSchedule {
  timeZone?: string | null;
  availability?: { days?: string[]; startTime?: string; endTime?: string }[];
}

interface CalBooking {
  id: number;
  uid: string;
  title: string;
  start: string;
  end: string;
  status: string;
  eventTypeId?: number | null;
  meetingUrl?: string | null;
  location?: string | null;
  cancellationReason?: string | null;
  hosts?: { id: number; name?: string | null; email?: string | null; timeZone?: string | null }[];
  attendees?: { name?: string | null; email?: string | null; timeZone?: string | null }[];
}

export interface CalBookingWindow {
  start: number;
  end: number;
  hostIds: string[];
}

export interface CalBookableEventType {
  id: number;
  lengthInMinutes: number;
}

@Injectable()
export class CalClient {
  private readonly logger = new Logger(CalClient.name);
  async me(apiKey: string): Promise<CalAccount> {
    const me = await this.get<CalMe>(apiKey, '/me');
    return {
      id: String(me.id),
      email: me.email,
      name: me.name ?? me.username,
      username: me.username,
      timezone: me.timeZone,
    };
  }

  async personalMember(apiKey: string): Promise<SchedulingMember> {
    const account = await this.me(apiKey);
    return {
      externalId: account.id,
      name: account.name ?? account.email ?? account.id,
      email: account.email ?? '',
      role: 'owner',
      schedulingUrl: account.username ? `${BOOKING_BASE}/${account.username}` : null,
      timezone: account.timezone,
      username: account.username,
    };
  }

  /**
   * The API key owner's default availability schedule. Cal.com only shows a
   * schedule to its owner, so this is the one member whose hours we can read.
   */
  async defaultSchedule(apiKey: string): Promise<WeeklySchedule | null> {
    const schedule = await this.get<CalSchedule | null>(apiKey, '/schedules/default', {
      'cal-api-version': SCHEDULES_API_VERSION,
    });
    if (!schedule) return null;
    const weekly: WeeklySchedule['weekly'] = {};
    for (const slot of schedule.availability ?? []) {
      if (!slot.startTime || !slot.endTime) continue;
      for (const day of slot.days ?? []) {
        const index = WEEKDAY_INDEX[day.toLowerCase()];
        if (index === undefined) continue;
        (weekly[String(index)] ??= []).push({ from: slot.startTime, to: slot.endTime });
      }
    }
    return { timezone: schedule.timeZone ?? null, weekly };
  }

  async teams(apiKey: string): Promise<CalTeam[]> {
    const teams = await this.get<CalTeam[]>(apiKey, '/teams');
    return teams.map(({ id, name, slug, isOrganization }) => ({ id, name, slug, isOrganization: Boolean(isOrganization) }));
  }

  async members(apiKey: string, teamId: string): Promise<SchedulingMember[]> {
    const memberships: CalMembership[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({ take: String(PAGE_SIZE), skip: String(page * PAGE_SIZE) });
      const batch = (await this.get<CalMembership[] | null>(apiKey, `/teams/${teamId}/memberships?${query}`)) ?? [];
      memberships.push(...batch);
      if (batch.length < PAGE_SIZE) break;
      if (page === MAX_PAGES - 1) this.logger.warn(`Cal.com team ${teamId} has more than ${memberships.length} members; the rest were skipped.`);
    }
    return memberships
      .filter((membership) => membership.accepted)
      .map((membership) => ({
        externalId: String(membership.userId),
        name: membership.user.name ?? membership.user.username ?? membership.user.email,
        email: membership.user.email,
        role: toRole(membership.role),
        schedulingUrl: membership.user.username ? `${BOOKING_BASE}/${membership.user.username}` : null,
        timezone: null,
        username: membership.user.username,
      }));
  }

  async teamEventTypes(apiKey: string, teamId: string, teamSlug: string | null): Promise<SchedulingEventType[]> {
    const eventTypes = await this.get<CalEventType[]>(apiKey, `/teams/${teamId}/event-types`);
    return toEventTypes(eventTypes, teamSlug ? `${BOOKING_BASE}/team/${teamSlug}` : null);
  }

  async personalEventTypes(apiKey: string, username: string | null): Promise<SchedulingEventType[]> {
    return toEventTypes(await this.userEventTypes(apiKey, username), username ? `${BOOKING_BASE}/${username}` : null);
  }

  async shortestEventType(apiKey: string, username: string): Promise<CalBookableEventType | null> {
    const visible = (await this.userEventTypes(apiKey, username)).filter((eventType) => !eventType.hidden);
    if (!visible.length) return null;
    const { id, lengthInMinutes } = visible.reduce((a, b) => (b.lengthInMinutes < a.lengthInMinutes ? b : a));
    return { id, lengthInMinutes };
  }

  async slots(apiKey: string, eventTypeId: number, start: Date, end: Date): Promise<{ start: number; end: number }[]> {
    const query = new URLSearchParams({
      eventTypeId: String(eventTypeId),
      start: start.toISOString(),
      end: end.toISOString(),
      format: 'range',
    });
    const byDate = await this.get<Record<string, { start: string; end: string }[]>>(apiKey, `/slots?${query}`, {
      'cal-api-version': SLOTS_API_VERSION,
    });
    return Object.values(byDate ?? {})
      .flat()
      .map((slot) => ({ start: Date.parse(slot.start), end: Date.parse(slot.end) }));
  }

  async bookings(apiKey: string, start: Date, end: Date, teamId: string | null): Promise<CalBookingWindow[]> {
    const bookings = await this.listBookings(apiKey, start, end, teamId, 'upcoming,unconfirmed');
    return bookings
      .filter((booking) => booking.status === 'accepted' || booking.status === 'pending')
      .map((booking) => ({
        start: Date.parse(booking.start),
        end: Date.parse(booking.end),
        hostIds: (booking.hosts ?? []).map((host) => String(host.id)),
      }));
  }

  /** Every booking (past, upcoming, cancelled) starting between `start` and `end`, with who booked it. */
  async scheduledMeetings(apiKey: string, start: Date, end: Date, teamId: string | null): Promise<BookedMeeting[]> {
    const bookings = await this.listBookings(apiKey, start, end, teamId, null);
    return bookings.map(toMeeting).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  }

  private async listBookings(
    apiKey: string,
    start: Date,
    end: Date,
    teamId: string | null,
    status: string | null,
  ): Promise<CalBooking[]> {
    const bookings: CalBooking[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({
        afterStart: start.toISOString(),
        beforeEnd: end.toISOString(),
        take: String(BOOKINGS_PAGE_SIZE),
        skip: String(page * BOOKINGS_PAGE_SIZE),
      });
      if (status) query.set('status', status);
      if (teamId) query.set('teamId', teamId);
      const batch =
        (await this.get<CalBooking[] | null>(apiKey, `/bookings?${query}`, {
          'cal-api-version': BOOKINGS_API_VERSION,
        })) ?? [];
      bookings.push(...batch);
      if (batch.length < BOOKINGS_PAGE_SIZE) break;
      if (page === MAX_PAGES - 1) this.logger.warn(`Cal.com returned more than ${bookings.length} bookings; the rest were skipped.`);
    }
    return bookings;
  }

  async createWebhook(apiKey: string, url: string, secret: string): Promise<string> {
    const body = await requestJson<Envelope<{ id: string | number }>>(PROVIDER, `${API_BASE}/webhooks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: true, subscriberUrl: url, triggers: WEBHOOK_TRIGGERS, secret }),
    });
    return String(body.data.id);
  }

  async deleteWebhook(apiKey: string, webhookId: string): Promise<void> {
    await requestJson(PROVIDER, `${API_BASE}/webhooks/${encodeURIComponent(webhookId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  }

  private userEventTypes(apiKey: string, username: string | null): Promise<CalEventType[]> {
    const query = username ? `?${new URLSearchParams({ username })}` : '';
    return this.get<CalEventType[]>(apiKey, `/event-types${query}`, { 'cal-api-version': EVENT_TYPES_API_VERSION });
  }

  private async get<T>(apiKey: string, path: string, headers: Record<string, string> = {}): Promise<T> {
    const body = await requestJson<Envelope<T>>(PROVIDER, `${API_BASE}${path}`, {
      headers: { ...headers, Authorization: `Bearer ${apiKey}` },
    });
    return body.data;
  }
}

function toMeeting(booking: CalBooking): BookedMeeting {
  const place = meetingPlace([booking.meetingUrl], [booking.location]);
  const canceled = booking.status === 'cancelled' || booking.status === 'rejected';
  const open = !canceled && Date.parse(booking.end) > Date.now();
  return {
    id: String(booking.id),
    eventTypeId: booking.eventTypeId == null ? null : String(booking.eventTypeId),
    title: booking.title,
    start: booking.start,
    end: booking.end,
    timezone: booking.hosts?.[0]?.timeZone ?? null,
    status: canceled ? 'canceled' : booking.status === 'pending' ? 'pending' : 'scheduled',
    invitees: (booking.attendees ?? []).map((attendee) => ({
      name: attendee.name ?? attendee.email ?? 'Guest',
      email: attendee.email ?? null,
      timezone: attendee.timeZone ?? null,
    })),
    hosts: (booking.hosts ?? []).map((host) => ({
      name: host.name ?? host.email ?? 'Host',
      email: host.email ?? null,
      timezone: host.timeZone ?? null,
    })),
    meetingUrl: place.meetingUrl,
    location: place.location,
    rescheduleUrl: open ? `${BOOKING_BASE}/reschedule/${booking.uid}` : null,
    cancelUrl: open ? `${BOOKING_BASE}/booking/${booking.uid}?cancel=true` : null,
    canceledReason: canceled ? (booking.cancellationReason ?? null) : null,
  };
}

function toEventTypes(eventTypes: CalEventType[], bookingBase: string | null): SchedulingEventType[] {
  return eventTypes
    .filter((eventType) => !eventType.hidden)
    .map((eventType) => ({
      id: String(eventType.id),
      name: eventType.title,
      durationMinutes: eventType.lengthInMinutes,
      bookingUrl: bookingBase ? `${bookingBase}/${eventType.slug}` : null,
      poolingType: toPooling(eventType.schedulingType ?? null),
      hostName: eventType.hosts?.length === 1 ? (eventType.hosts[0].name ?? null) : null,
      color: hexColor(eventType.eventTypeColor?.darkEventTypeColor ?? eventType.eventTypeColor?.lightEventTypeColor),
    }));
}

function toRole(role: string): WorkspaceRole {
  const normalized = role.toLowerCase();
  return normalized === 'owner' || normalized === 'admin' ? normalized : 'member';
}

function toPooling(type: string | null): PoolingType | null {
  switch (type?.toUpperCase()) {
    case 'ROUND_ROBIN':
      return 'round_robin';
    case 'COLLECTIVE':
      return 'collective';
    case 'MANAGED':
      return 'managed';
    default:
      return null;
  }
}
