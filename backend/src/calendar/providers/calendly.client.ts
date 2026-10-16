import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IntegrationEnv } from '@/common/utils/interface';
import type { BusySource } from '../calendar.types';
import type {
  BookedMeeting,
  PoolingType,
  ProviderAccount,
  SchedulingEventType,
  SchedulingMember,
  WorkspaceRole,
} from '../calendar.types';
import { LEAD_BOOKING_UTM_SOURCE } from '../booking/lead-booking-link';
import { hexColor, mapLimit, meetingPlace } from './meeting-location';
import { ProviderHttpError, requestJson } from './provider-http';

const AUTH_BASE = 'https://auth.calendly.com';
const API_BASE = 'https://api.calendly.com';
const PROVIDER = 'Calendly';
const PAGE_SIZE = 100;
/** Members and event types: up to 5,000 each. Past that the rest is skipped (and logged), not failed. */
const MAX_PAGES = 50;
/** Booked meetings need one invitee call each, so cap how many a single read fetches (1,000). */
const MAX_MEETING_PAGES = 10;
const INVITEE_CONCURRENCY = 4;

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  owner: string;
  organization: string;
  scope?: string;
}

interface CalendlyUser {
  uri: string;
  name: string;
  email: string;
  scheduling_url: string | null;
  timezone: string | null;
  slug: string | null;
}

interface CalendlyMembership {
  role: string;
  user: CalendlyUser;
}

interface CalendlyEventType {
  uri: string;
  name: string;
  duration: number;
  scheduling_url: string | null;
  pooling_type: string | null;
  color?: string | null;
  profile: { name: string | null } | null;
}

interface CalendlyScheduledEvent {
  uri: string;
  name: string;
  status: 'active' | 'canceled';
  start_time: string;
  end_time: string;
  event_type: string | null;
  location: { type: string; location?: string | null; join_url?: string | null } | null;
  event_memberships: { user_name?: string | null; user_email?: string | null }[];
  cancellation?: { reason?: string | null } | null;
}

interface CalendlyInvitee {
  name: string;
  email: string;
  timezone?: string | null;
  status: 'active' | 'canceled';
  cancel_url: string | null;
  reschedule_url: string | null;
  rescheduled?: boolean;
  tracking?: { utm_source?: string | null; utm_content?: string | null } | null;
}

export interface CalendlyEventTypeDetail {
  uri: string;
  name: string;
  duration: number;
  locations: { kind: string; location?: string | null }[] | null;
}

export interface CalendlyBookedInvitee {
  uri: string;
  event: string;
  cancel_url: string | null;
  reschedule_url: string | null;
}

export interface CalendlyBookedEvent {
  uri: string;
  name: string;
  start_time: string;
  end_time: string;
  location: { join_url?: string | null; location?: string | null } | null;
  event_memberships: { user: string; user_name?: string | null; user_email?: string | null }[];
}

interface CalendlyAvailabilitySchedule {
  default: boolean;
  timezone: string;
  rules: {
    type: 'wday' | 'date';
    wday?: string;
    date?: string;
    intervals: { from: string; to: string }[];
  }[];
}

interface CalendlyBusyTime {
  type: string;
  start_time: string;
  end_time: string;
  buffered_start_time?: string | null;
  buffered_end_time?: string | null;
}

export interface ScheduleInterval {
  from: string;
  to: string;
}

export interface CalendlySchedule {
  timezone: string;
  weekly: Record<string, ScheduleInterval[]>;
  dates: Record<string, ScheduleInterval[]>;
}

const WEBHOOK_EVENTS = ['invitee.created', 'invitee.canceled'];

export interface CalendlyBusy {
  start: number;
  end: number;
  blockedStart: number;
  blockedEnd: number;
  source: BusySource;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

interface Page<T> {
  collection: T[];
  pagination: { next_page: string | null };
}

export interface CalendlyGrant {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  userUri: string;
  organizationUri: string;
  /** Scopes the token holds; null when Calendly did not say (an app with full access). */
  scope: string | null;
}

@Injectable()
export class CalendlyClient {
  private readonly logger = new Logger(CalendlyClient.name);
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly redirectUri?: string;
  private readonly scopes: string | null;
  readonly appUrl?: string;

  constructor(config: ConfigService<IntegrationEnv, true>) {
    this.clientId = config.get('CALENDLY_CLIENT_ID', { infer: true });
    this.clientSecret = config.get('CALENDLY_CLIENT_SECRET', { infer: true });
    this.redirectUri = config.get('CALENDLY_REDIRECT_URI', { infer: true });
    this.appUrl = config.get('APP_URL', { infer: true });
    this.scopes = config.get('CALENDLY_SCOPES', { infer: true })?.trim().split(/\s+/).join(' ') || null;
  }

  get missingConfig(): string[] {
    const required = {
      CALENDLY_CLIENT_ID: this.clientId,
      CALENDLY_CLIENT_SECRET: this.clientSecret,
      CALENDLY_REDIRECT_URI: this.redirectUri,
      APP_URL: this.appUrl,
    };
    return Object.entries(required)
      .filter(([, value]) => !value)
      .map(([name]) => name);
  }

  get configured(): boolean {
    return this.missingConfig.length === 0;
  }

  authorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId ?? '',
      response_type: 'code',
      redirect_uri: this.redirectUri ?? '',
      state,
      ...(this.scopes ? { scope: this.scopes } : {}),
    });
    return `${AUTH_BASE}/oauth/authorize?${params}`;
  }

  exchangeCode(code: string): Promise<CalendlyGrant> {
    return this.token({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri ?? '' });
  }

  refresh(refreshToken: string): Promise<CalendlyGrant> {
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  async revoke(token: string): Promise<void> {
    await requestJson(PROVIDER, `${AUTH_BASE}/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, client_id: this.clientId ?? '', client_secret: this.clientSecret ?? '' }),
    });
  }

  async currentUser(accessToken: string): Promise<ProviderAccount> {
    const { resource } = await this.get<{ resource: CalendlyUser }>(accessToken, `${API_BASE}/users/me`);
    return { id: resource.uri, email: resource.email, name: resource.name };
  }

  async roleOf(accessToken: string, organizationUri: string, userUri: string): Promise<WorkspaceRole | null> {
    const url = `${API_BASE}/organization_memberships?${new URLSearchParams({ organization: organizationUri, user: userUri })}`;
    const page = await this.get<Page<CalendlyMembership>>(accessToken, url);
    const role = page.collection[0]?.role;
    return role ? toRole(role) : null;
  }

  async members(accessToken: string, organizationUri: string): Promise<SchedulingMember[]> {
    const memberships = await this.collect<CalendlyMembership>(
      accessToken,
      `${API_BASE}/organization_memberships?${new URLSearchParams({ organization: organizationUri, count: String(PAGE_SIZE) })}`,
    );
    return memberships.map(({ role, user }) => ({
      externalId: user.uri,
      name: user.name,
      email: user.email,
      role: toRole(role),
      schedulingUrl: user.scheduling_url,
      timezone: user.timezone,
      username: user.slug,
    }));
  }

  /**
   * The organization's active event types. Calendly's `?organization=` list
   * leaves some shared pages out (a multi-pool event, for one), so
   * `knownUris` — event types seen on booked meetings — are read one by one
   * when the list does not have them.
   */
  async eventTypes(accessToken: string, organizationUri: string, knownUris: string[] = []): Promise<SchedulingEventType[]> {
    return (await this.organizationEventTypes(accessToken, organizationUri, knownUris)).map(toEventType);
  }

  private async organizationEventTypes(
    accessToken: string,
    organizationUri: string,
    knownUris: string[],
  ): Promise<CalendlyEventType[]> {
    const listed = await this.collect<CalendlyEventType>(
      accessToken,
      `${API_BASE}/event_types?${new URLSearchParams({ organization: organizationUri, active: 'true', count: String(PAGE_SIZE) })}`,
    );
    return [...listed, ...(await this.missingEventTypes(accessToken, listed, knownUris))];
  }

  /** The active ones of `uris` that `listed` does not have, each read on its own. Best effort per event type. */
  private async missingEventTypes(accessToken: string, listed: CalendlyEventType[], uris: string[]): Promise<CalendlyEventType[]> {
    const have = new Set(listed.map((eventType) => eventType.uri));
    const missing = [...new Set(uris)].filter((uri) => uri.startsWith(`${API_BASE}/event_types/`) && !have.has(uri));
    const read = await mapLimit(missing, INVITEE_CONCURRENCY, async (uri) => {
      try {
        const { resource } = await this.get<{ resource: CalendlyEventType & { active?: boolean } }>(accessToken, uri);
        return resource.active === false ? null : resource;
      } catch (error) {
        if (error instanceof ProviderHttpError && error.credentialRejected) throw error;
        this.logger.warn(`Calendly event type ${uri} unavailable: ${(error as Error).message}`);
        return null;
      }
    });
    return read.filter((eventType): eventType is CalendlyEventType & { active?: boolean } => eventType !== null);
  }

  /** Meetings booked in the organization between `from` and `to`, with who booked each. */
  async scheduledMeetings(accessToken: string, organizationUri: string, from: Date, to: Date): Promise<BookedMeeting[]> {
    const query = new URLSearchParams({
      organization: organizationUri,
      min_start_time: from.toISOString(),
      max_start_time: to.toISOString(),
      sort: 'start_time:asc',
      count: String(PAGE_SIZE),
    });
    const events = await this.collect<CalendlyScheduledEvent>(
      accessToken,
      `${API_BASE}/scheduled_events?${query}`,
      MAX_MEETING_PAGES,
    );
    return mapLimit(events, INVITEE_CONCURRENCY, async (event) =>
      toMeeting(event, await this.invitees(accessToken, event.uri)),
    );
  }

  private async invitees(accessToken: string, eventUri: string): Promise<CalendlyInvitee[]> {
    try {
      return await this.collect<CalendlyInvitee>(accessToken, `${eventUri}/invitees?count=${PAGE_SIZE}`, 1);
    } catch (error) {
      // One unreadable event should not hide every other meeting; a rejected token still should.
      if (error instanceof ProviderHttpError && error.credentialRejected) throw error;
      return [];
    }
  }

  async defaultSchedule(accessToken: string, userUri: string): Promise<CalendlySchedule | null> {
    const { collection } = await this.get<{ collection: CalendlyAvailabilitySchedule[] }>(
      accessToken,
      `${API_BASE}/user_availability_schedules?${new URLSearchParams({ user: userUri })}`,
    );
    const schedule = collection.find((candidate) => candidate.default) ?? collection[0];
    if (!schedule) return null;

    const weekly: Record<string, ScheduleInterval[]> = {};
    const dates: Record<string, ScheduleInterval[]> = {};
    for (const rule of schedule.rules) {
      const intervals = rule.intervals.map(({ from, to }) => ({ from, to }));
      if (rule.type === 'date' && rule.date) dates[rule.date] = intervals;
      if (rule.type === 'wday' && rule.wday && WEEKDAYS.includes(rule.wday)) {
        weekly[String(WEEKDAYS.indexOf(rule.wday))] = intervals;
      }
    }
    return { timezone: schedule.timezone, weekly, dates };
  }

  async busyTimes(accessToken: string, userUri: string, start: Date, end: Date): Promise<CalendlyBusy[]> {
    const query = new URLSearchParams({ user: userUri, start_time: start.toISOString(), end_time: end.toISOString() });
    const { collection } = await this.get<{ collection: CalendlyBusyTime[] }>(
      accessToken,
      `${API_BASE}/user_busy_times?${query}`,
    );
    return collection.map((busy) => {
      const startMs = Date.parse(busy.start_time);
      const endMs = Date.parse(busy.end_time);
      return {
        start: startMs,
        end: endMs,
        blockedStart: busy.buffered_start_time ? Date.parse(busy.buffered_start_time) : startMs,
        blockedEnd: busy.buffered_end_time ? Date.parse(busy.buffered_end_time) : endMs,
        source: busy.type === 'external' ? 'calendar' : busy.type === 'reserved' ? 'hold' : 'booking',
      };
    });
  }

  /**
   * Every active event type the member hosts: their own one-on-one pages and
   * the shared ones they are a host on (round robin, collective, multi-pool),
   * each with its `poolingType`.
   *
   * `?user=` leaves out team-owned pages such as a multi-pool event, so the
   * organization's shared event types (with `knownUris`, see `eventTypes`)
   * are read too and kept when the member is one of their hosts.
   */
  async memberEventTypes(
    accessToken: string,
    organizationUri: string,
    userUri: string,
    knownUris: string[] = [],
  ): Promise<SchedulingEventType[]> {
    const [own, shared] = await Promise.all([
      this.collect<CalendlyEventType>(
        accessToken,
        `${API_BASE}/event_types?${new URLSearchParams({ user: userUri, active: 'true', count: String(PAGE_SIZE) })}`,
      ),
      this.sharedEventTypes(accessToken, organizationUri, knownUris),
    ]);
    const ownUris = new Set(own.map((eventType) => eventType.uri));
    const candidates = shared.filter((eventType) => !ownUris.has(eventType.uri));
    const hosted = await mapLimit(candidates, INVITEE_CONCURRENCY, async (eventType) =>
      (await this.hostsEventType(accessToken, eventType.uri, userUri)) ? eventType : null,
    );
    return [...own, ...hosted.filter((eventType): eventType is CalendlyEventType => eventType !== null)].map(toEventType);
  }

  /** The organization's active shared (pooled) event types. Best effort: unreadable means none. */
  private async sharedEventTypes(accessToken: string, organizationUri: string, knownUris: string[]): Promise<CalendlyEventType[]> {
    try {
      const all = await this.organizationEventTypes(accessToken, organizationUri, knownUris);
      return all.filter((eventType) => toPooling(eventType.pooling_type) !== null);
    } catch (error) {
      if (error instanceof ProviderHttpError && error.credentialRejected) throw error;
      this.logger.warn(`Calendly shared event types unavailable: ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * Whether `userUri` is a host on a shared event type, from its memberships.
   * When they cannot be read the event type is kept: offering a page the agent
   * is not on is better than hiding one they are.
   */
  private async hostsEventType(accessToken: string, eventTypeUri: string, userUri: string): Promise<boolean> {
    try {
      const memberships = await this.collect<unknown>(
        accessToken,
        `${API_BASE}/event_type_memberships?${new URLSearchParams({ event_type: eventTypeUri, count: String(PAGE_SIZE) })}`,
      );
      // The host's user URI sits in a nested field; match it wherever it is.
      return JSON.stringify(memberships).includes(JSON.stringify(userUri));
    } catch (error) {
      if (error instanceof ProviderHttpError && error.credentialRejected) throw error;
      this.logger.warn(`Calendly hosts for event type ${eventTypeUri} unavailable, keeping it: ${(error as Error).message}`);
      return true;
    }
  }

  async eventType(accessToken: string, eventTypeUri: string): Promise<CalendlyEventTypeDetail> {
    const { resource } = await this.get<{ resource: CalendlyEventTypeDetail }>(accessToken, eventTypeUri);
    return resource;
  }

  /** Open start times for an event type. Calendly answers at most seven days per request. */
  async availableTimes(accessToken: string, eventTypeUri: string, start: Date, end: Date): Promise<Date[]> {
    const query = new URLSearchParams({ event_type: eventTypeUri, start_time: start.toISOString(), end_time: end.toISOString() });
    const { collection } = await this.get<{ collection: { status: string; start_time: string }[] }>(
      accessToken,
      `${API_BASE}/event_type_available_times?${query}`,
    );
    return collection.filter((t) => t.status === 'available').map((t) => new Date(t.start_time));
  }

  /** Books a time on the invitee's behalf (Calendly's scheduling API). A taken slot answers 409. */
  async createInvitee(
    accessToken: string,
    body: {
      event_type: string;
      start_time: string;
      invitee: { name: string; email: string; timezone: string };
      location?: { kind: string; location?: string };
      tracking?: { utm_source: string; utm_content: string };
    },
  ): Promise<CalendlyBookedInvitee> {
    const { resource } = await requestJson<{ resource: CalendlyBookedInvitee }>(PROVIDER, `${API_BASE}/invitees`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return resource;
  }

  async scheduledEvent(accessToken: string, eventUri: string): Promise<CalendlyBookedEvent> {
    const { resource } = await this.get<{ resource: CalendlyBookedEvent }>(accessToken, eventUri);
    return resource;
  }

  async createWebhook(accessToken: string, organizationUri: string, url: string, signingKey: string): Promise<string> {
    const { resource } = await requestJson<{ resource: { uri: string } }>(PROVIDER, `${API_BASE}/webhook_subscriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        events: WEBHOOK_EVENTS,
        organization: organizationUri,
        scope: 'organization',
        signing_key: signingKey,
      }),
    });
    return resource.uri;
  }

  async deleteWebhook(accessToken: string, webhookUri: string): Promise<void> {
    await requestJson(PROVIDER, webhookUri, { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } });
  }

  private async token(grant: Record<string, string>): Promise<CalendlyGrant> {
    const body = await requestJson<TokenResponse>(PROVIDER, `${AUTH_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...grant, client_id: this.clientId ?? '', client_secret: this.clientSecret ?? '' }),
    });
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: new Date(Date.now() + body.expires_in * 1000),
      userUri: body.owner,
      organizationUri: body.organization,
      scope: body.scope ?? null,
    };
  }

  private get<T>(accessToken: string, url: string): Promise<T> {
    return requestJson<T>(PROVIDER, url, { headers: { Authorization: `Bearer ${accessToken}` } });
  }

  private async collect<T>(accessToken: string, firstPage: string, maxPages = MAX_PAGES): Promise<T[]> {
    const items: T[] = [];
    let next: string | null = firstPage;
    for (let page = 0; next && page < maxPages; page++) {
      const result: Page<T> = await this.get<Page<T>>(accessToken, next);
      items.push(...(result.collection ?? []));
      next = result.pagination?.next_page ?? null;
    }
    if (next) {
      this.logger.warn(`Calendly returned more than ${items.length} items for ${new URL(firstPage).pathname}; the rest were skipped.`);
    }
    return items;
  }
}

function toMeeting(event: CalendlyScheduledEvent, invitees: CalendlyInvitee[]): BookedMeeting {
  const place = meetingPlace([event.location?.join_url], [event.location?.location]);
  // Calendly's cancel and reschedule pages are per invitee; the first one still booked speaks for the meeting.
  const booker = invitees.find((invitee) => invitee.status === 'active') ?? invitees[0];
  const canceled = event.status === 'canceled';
  const open = !canceled && Date.parse(event.end_time) > Date.now();
  return {
    id: event.uri,
    eventTypeId: event.event_type,
    title: event.name,
    start: event.start_time,
    end: event.end_time,
    // Calendly does not say; the sync fills it from the host's calendar member.
    timezone: null,
    status: canceled ? (invitees.some((i) => i.rescheduled) ? 'rescheduled' : 'canceled') : 'scheduled',
    invitees: invitees.map(({ name, email, timezone }) => ({ name, email, timezone: timezone ?? null })),
    hosts: event.event_memberships.map((host) => ({
      name: host.user_name ?? host.user_email ?? 'Host',
      email: host.user_email ?? null,
      timezone: null,
    })),
    meetingUrl: place.meetingUrl,
    location: place.location ?? LOCATION_LABEL[event.location?.type ?? ''] ?? null,
    rescheduleUrl: open ? (booker?.reschedule_url ?? null) : null,
    cancelUrl: open ? (booker?.cancel_url ?? null) : null,
    canceledReason: canceled ? (event.cancellation?.reason ?? null) : null,
    leadRef: invitees.find((i) => i.tracking?.utm_source === LEAD_BOOKING_UTM_SOURCE)?.tracking?.utm_content ?? null,
  };
}

/** What to say when Calendly gives a location type but no address, number or link (yet). */
const LOCATION_LABEL: Record<string, string> = {
  zoom: 'Zoom',
  google_conference: 'Google Meet',
  microsoft_teams_conference: 'Microsoft Teams',
  webex_conference: 'Webex',
  gotomeeting: 'GoTo Meeting',
  outbound_call: 'Phone call',
  inbound_call: 'Phone call',
  ask_invitee: 'Set by invitee',
};

function toRole(role: string): WorkspaceRole {
  return role === 'owner' || role === 'admin' ? role : 'member';
}

function toEventType(eventType: CalendlyEventType): SchedulingEventType {
  return {
    id: eventType.uri,
    name: eventType.name,
    durationMinutes: eventType.duration,
    bookingUrl: eventType.scheduling_url,
    poolingType: toPooling(eventType.pooling_type),
    hostName: eventType.profile?.name ?? null,
    color: hexColor(eventType.color),
  };
}

function toPooling(type: string | null): PoolingType | null {
  return type === 'round_robin' || type === 'collective' || type === 'multi_pool' ? type : null;
}
