import { apiFetch } from '../lib/api';

/**
 * Calendars: the OFFICE's one Calendly connection, each agent's working hours,
 * and the appointments that syncing produces.
 *
 * Calendly belongs to the organization. The owner connects a single Calendly
 * account — one whose user is an owner or admin of its Calendly organization —
 * invites the agents into it there, and every member's bookings are read
 * through that one connection. So there is no per-agent connect here, and
 * nothing under `/agents/me/...` writes to Calendly any more.
 *
 * Split the same way the API is. Everything under `/agents/me/...` carries no
 * agent id at all — the server resolves the agent from the session, and nothing
 * here should ever grow a parameter that would let a browser ask about somebody
 * else. The owner-facing calls below are answered only for an owner, by
 * OwnerGuard.
 *
 * These types are declared here rather than in `types.ts` for the same reason
 * `LiveLead` lives in `api/client.ts`: `types.ts` belongs to the demo store, and
 * its unions are narrower than what the backend really returns.
 */

/**
 * The office's Calendly account, as much of it as the SPA is told.
 *
 * Narrow on purpose. It once carried the connected account's own `name`,
 * `timezone` and `schedulingUrl` — meaningful while a connection WAS an agent,
 * and misleading now that one account covers the whole office: booking pages
 * come from event types, and each agent's timezone from the member roster.
 */
export interface CalendarConnection {
  status: 'active' | 'inactive' | 'error';
  connected: boolean;
  /** The Calendly account that authorized us — the office's, not an agent's. */
  email: string | null;
  lastSyncedAt: string | null;
  /** Set when the connection needs the owner to re-authorize. */
  lastError: string | null;
}

/** 'calendly' | 'cal' — the scheduling tools this build supports. */
export type CalendarProviderId = 'calendly' | 'cal';

/** One provider, and whether this deployment can offer it. */
export interface CalendarProviderStatus {
  id: CalendarProviderId;
  label: string;
  /**
   * False when the deployment cannot offer it at all — Calendly without an
   * OAuth app registered on the server. Cal.com needs no such registration, so
   * it is always true.
   */
  canConnect: boolean;
  reason: string | null;
}

/**
 * The office's scheduling account, as the OWNER sees it.
 *
 * At most one provider is ever connected. Calendly and Cal.com are
 * alternatives: connecting one retires the other, because two live calendars
 * would sweep the same office twice.
 */
export interface OrganizationCalendarStatus {
  /** Which provider is live, or null. */
  provider: CalendarProviderId | null;
  /** Every provider, connected or not — the screen has to offer the other one. */
  providers: CalendarProviderStatus[];
  /** Whether the background sweep is running. Off means "Sync now" only. */
  syncEnabled: boolean;
  connection: CalendarConnection | null;
  /**
   * The team this connection reads. Null for Calendly, which names an
   * organization only by URI.
   */
  workspaceName: string | null;
  /** The connected account's role there: owner | admin | member. */
  workspaceRole: string | null;
  membersSyncedAt: string | null;
}

/** A Cal.com team the pasted API key can see. */
export interface CalComTeamOption {
  id: number;
  name: string;
  slug: string | null;
  /** Cal.com organizations are a separate paid tier and cannot be used here. */
  isOrganization: boolean;
}

/**
 * What an AGENT sees. Two facts, neither of them actionable by them: has the
 * office connected Calendly, and am I on it? Nothing about the office's
 * credentials reaches this shape.
 */
export interface CalendarStatus {
  organizationConnected: boolean;
  /**
   * Which provider the office connected, or null. The agent's screen names the
   * tool they are actually expected to log into.
   */
  provider: CalendarProviderId | null;
  syncEnabled: boolean;
  /** This agent's id on that provider, or null when they are not linked. */
  schedulingUserId: string | null;
  /** This agent's own booking page, when they have one. */
  schedulingUrl: string | null;
  lastSyncedAt: string | null;
}

/** One member of the office's scheduling team, and who they are here. */
export interface CalendarMember {
  /** The provider's own id for them — a Calendly URI, or a Cal.com user id. */
  schedulingUserId: string;
  name: string;
  email: string;
  /** owner | admin | user, in Calendly's organization. */
  role: string;
  schedulingUrl: string;
  timezone: string;
  /** The agent this member is linked to, or null when unmatched. */
  agentId: string | null;
  agentName: string | null;
}

export interface MemberSyncResult {
  members: number;
  linked: number;
  /** Calendly members whose email matches nobody on the EstatePulse roster. */
  unmatched: number;
  /** Agents linked to no member — their bookings cannot be attributed. */
  agentsUnlinked: number;
}

/**
 * A bookable page.
 *
 * `poolingType` is the interesting one: 'round_robin' is the link to hand a
 * lead when the provider should choose the agent.
 */
export interface CalendarEventType {
  uri: string;
  name: string;
  active: boolean;
  durationMinutes: number;
  schedulingUrl: string;
  /** round_robin | collective | multi_pool | null (an ordinary one-on-one). */
  poolingType: string | null;
  ownerName: string | null;
  ownerType: string | null;
}

export interface AvailabilityDay {
  /** 0 = Sunday .. 6 = Saturday. */
  dayOfWeek: number;
  isAvailable: boolean;
  /** 'HH:MM', wall-clock in `timezone` below. */
  startTime: string;
  endTime: string;
}

export interface Availability {
  /** The agent's own timezone. These times are not UTC and not the browser's. */
  timezone: string;
  days: AvailabilityDay[];
}

export interface Appointment {
  id: string;
  leadId: string;
  leadName: string;
  leadEmail: string | null;
  leadPhone: string | null;
  leadStatus: string;
  agentId: string;
  agentName: string;
  provider: string;
  externalEventId: string | null;
  startTime: string;
  endTime: string;
  /** scheduled | rescheduled | cancelled | completed | no_show */
  status: string;
  appointmentType: string | null;
  meetingUrl: string | null;
  notes: string | null;
  cancelUrl: string | null;
  rescheduleUrl: string | null;
  canceledReason: string | null;
  createdAt: string;
}

export interface SyncResult {
  scanned: number;
  created: number;
  updated: number;
  /** Events on the calendar that matched no lead, and so were not stored. */
  skippedNoLead: number;
  /** Events whose Calendly host is not linked to any agent on this roster. */
  skippedNoAgent: number;
}

export interface AgentCalendar {
  agentId: string;
  agentName: string;
  /**
   * The scheduling member this agent is, for whichever provider is connected,
   * or null when they are not on it.
   */
  schedulingUserId: string | null;
  schedulingUrl: string | null;
  availability: Availability;
  upcoming: Appointment[];
}

// --- the office's Calendly (owner only) --------------------------------------

export const getOrganizationCalendar = (): Promise<OrganizationCalendarStatus> =>
  apiFetch<OrganizationCalendarStatus>('/organization/calendar', { auth: true });

export const startOrganizationCalendarConnect = (): Promise<{ authorizeUrl: string }> =>
  apiFetch<{ authorizeUrl: string }>('/organization/calendar/connect', {
    method: 'POST',
    auth: true,
  });

export const syncOrganizationCalendar = (): Promise<SyncResult> =>
  apiFetch<SyncResult>('/organization/calendar/sync', { method: 'POST', auth: true });

export const disconnectOrganizationCalendar = (): Promise<void> =>
  apiFetch<void>('/organization/calendar', { method: 'DELETE', auth: true });

export const listCalendarMembers = (): Promise<CalendarMember[]> =>
  apiFetch<CalendarMember[]>('/organization/calendar/members', { auth: true });

/** POST, not GET: it writes which agent each Calendly member is. */
export const syncCalendarMembers = (): Promise<MemberSyncResult> =>
  apiFetch<MemberSyncResult>('/organization/calendar/members/sync', {
    method: 'POST',
    auth: true,
  });

export const listCalendarEventTypes = (): Promise<CalendarEventType[]> =>
  apiFetch<CalendarEventType[]>('/organization/calendar/event-types', { auth: true });

/**
 * Check a Cal.com key and list the teams it unlocks. Writes nothing, so a
 * mistyped key costs a round trip and no state.
 */
export const listCalComTeams = (
  apiKey: string,
): Promise<{ email: string; teams: CalComTeamOption[] }> =>
  apiFetch<{ email: string; teams: CalComTeamOption[] }>('/organization/calendar/cal/teams', {
    method: 'POST',
    body: { apiKey },
    auth: true,
  });

/** Connect Cal.com. Retires an active Calendly connection as a side effect. */
export const connectCalCom = (
  apiKey: string,
  teamId: number,
): Promise<OrganizationCalendarStatus> =>
  apiFetch<OrganizationCalendarStatus>('/organization/calendar/cal/connect', {
    method: 'POST',
    body: { apiKey, teamId },
    auth: true,
  });

// --- the agent's own calendar ------------------------------------------------

export const getMyCalendar = (): Promise<CalendarStatus> =>
  apiFetch<CalendarStatus>('/agents/me/calendar', { auth: true });

export const getMyAvailability = (): Promise<Availability> =>
  apiFetch<Availability>('/agents/me/availability', { auth: true });

export const saveMyAvailability = (days: AvailabilityDay[]): Promise<Availability> =>
  apiFetch<Availability>('/agents/me/availability', {
    method: 'PUT',
    body: { days },
    auth: true,
  });

export const getMyAppointments = (): Promise<Appointment[]> =>
  apiFetch<Appointment[]>('/agents/me/appointments', { auth: true });

// --- the owner's view --------------------------------------------------------

export const listAppointments = (params?: {
  from?: string;
  to?: string;
  status?: string;
  agentId?: string;
}): Promise<Appointment[]> => {
  const q = new URLSearchParams();
  if (params?.from) q.set('from', params.from);
  if (params?.to) q.set('to', params.to);
  if (params?.status) q.set('status', params.status);
  if (params?.agentId) q.set('agentId', params.agentId);
  const suffix = q.toString() ? `?${q.toString()}` : '';
  return apiFetch<Appointment[]>(`/appointments${suffix}`, { auth: true });
};

/** Takes the member's `users.id`, the same id `PATCH /agents/:userId` uses. */
export const getAgentCalendar = (userId: string): Promise<AgentCalendar> =>
  apiFetch<AgentCalendar>(`/agents/${userId}/calendar`, { auth: true });

// --- shared helpers ----------------------------------------------------------

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Origins the OAuth result may legitimately arrive from: this app (when the API
 * is same-origin behind a proxy) and the configured API host.
 */
function apiOrigins(): string[] {
  const origins = [window.location.origin];
  const base = import.meta.env.VITE_API_URL;
  if (base) {
    try {
      origins.push(new URL(base, window.location.origin).origin);
    } catch {
      /* a malformed VITE_API_URL is a config problem, not a reason to throw here */
    }
  }
  return origins;
}

/**
 * Open the Calendly consent screen and resolve once it finishes.
 *
 * The popup is an optimisation, not the mechanism: the caller reloads its
 * status either way, and that reload is what actually flips the card to
 * connected. If the popup is blocked, or the message never arrives, the page
 * still catches up — so this resolves rather than rejects when the window
 * simply closes.
 */
export function openCalendlyPopup(authorizeUrl: string): Promise<'ok' | 'failed' | 'closed'> {
  return new Promise((resolve) => {
    const popup = window.open(authorizeUrl, 'calendly-oauth', 'width=600,height=780');
    if (!popup) {
      // Blocked. The callback page falls back to a redirect with ?calendly=,
      // which AppContext reads once at boot.
      window.location.href = authorizeUrl;
      return;
    }

    let settled = false;
    const finish = (outcome: 'ok' | 'failed' | 'closed') => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      clearInterval(poll);
      resolve(outcome);
    };

    const onMessage = (event: MessageEvent) => {
      // `event.origin` is the SENDER's origin — the API, which served the
      // callback page — not this app's. In development they differ (the Vite
      // proxy only makes XHR same-origin; the OAuth redirect is a real
      // navigation to PUBLIC_API_BASE_URL), and in production they are
      // different hosts, so comparing against window.location.origin here
      // would reject every message we actually want.
      //
      // Confidentiality is already handled on the other side: the callback
      // posts with an explicit targetOrigin, so only this app can receive it.
      // What is left to check is that the message is ours in shape, and it is
      // only a hint to refresh — the authoritative state comes from the
      // authenticated status endpoint immediately afterwards.
      if (!apiOrigins().includes(event.origin)) return;
      const data = event.data as { source?: string; ok?: boolean } | null;
      if (data?.source !== 'estatepulse:calendly') return;
      finish(data.ok ? 'ok' : 'failed');
    };

    window.addEventListener('message', onMessage);
    // The user can always just close the window; treat that as done and let the
    // status refresh decide what really happened.
    const poll = setInterval(() => {
      if (popup.closed) finish('closed');
    }, 500);
  });
}

// ---------------------------------------------------------------------------
// Booking for a lead
// ---------------------------------------------------------------------------

/** Why a lead cannot be booked yet — see LeadBookingService on the backend. */
export type LeadBookingBlocker = 'no_agent' | 'no_calendar' | 'agent_not_linked' | 'no_event_types';

export interface LeadBookingOptions {
  agent: { id: string; name: string } | null;
  provider: 'calendly' | 'cal' | null;
  /** The assigned agent's own event types, as links pre-filled for this lead. */
  eventTypes: { id: string; name: string; durationMinutes: number; bookingUrl: string }[];
  blocker: LeadBookingBlocker | null;
}

export const getLeadBookingOptions = (leadId: string) =>
  apiFetch<LeadBookingOptions>(`/leads/${leadId}/booking-options`, { auth: true });

export const getLeadAppointments = (leadId: string) =>
  apiFetch<Appointment[]>(`/leads/${leadId}/appointments`, { auth: true });
