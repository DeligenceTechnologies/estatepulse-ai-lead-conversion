import { apiFetch } from '../lib/api';

export type CalendarProviderId = 'calendly' | 'cal';

export type WorkspaceRole = 'owner' | 'admin' | 'member';

export type WorkspaceType = 'organization' | 'team' | 'personal';

export interface CalendarConnection {
  status: 'active' | 'error';
  accountEmail: string | null;
  accountName: string | null;
  workspaceType: WorkspaceType;
  workspaceName: string | null;
  workspaceRole: WorkspaceRole | null;
  connectedAt: string;
  /** When its data was last synced from the provider; null before the first sync. */
  syncedAt?: string | null;
  lastError: string | null;
}

export interface CalendarProviderStatus {
  id: CalendarProviderId;
  label: string;
  canConnect: boolean;
  reason: string | null;
  saved: CalendarConnection | null;
}

export interface OrganizationCalendarStatus {
  provider: CalendarProviderId | null;
  providers: CalendarProviderStatus[];
  connection: CalendarConnection | null;
}

export interface CalComTeamOption {
  id: number;
  name: string;
  slug: string | null;
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

export interface CalendarMember {
  externalId: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  schedulingUrl: string | null;
  timezone: string | null;
  userId: string | null;
  userName: string | null;
  /** Working hours in their calendar, as last synced; null when unknown. */
  schedule: MemberSchedule | null;
}

export interface MemberSchedule {
  timezone: string | null;
  /** '0' = Sunday .. '6' = Saturday → 'HH:MM' spans, wall-clock in `timezone`. Missing day = off. */
  weekly: Record<string, { from: string; to: string }[]>;
}

export type PoolingType = 'round_robin' | 'collective' | 'managed' | 'multi_pool';

export interface CalendarEventType {
  id: string;
  name: string;
  durationMinutes: number;
  bookingUrl: string | null;
  poolingType: PoolingType | null;
  hostName: string | null;
  /** `#rrggbb` from the provider, or null. */
  color: string | null;
}

export type MeetingStatus = 'scheduled' | 'pending' | 'canceled';

export interface MeetingPerson {
  name: string;
  email: string | null;
  timezone: string | null;
}

/** A meeting someone booked on one of the workspace's meeting types. */
export interface BookedMeeting {
  id: string;
  /** Matches `CalendarEventType.id`; null when the provider did not say. */
  eventTypeId: string | null;
  title: string;
  start: string;
  end: string;
  /** The host's timezone: the clock the meeting was set in. */
  timezone: string | null;
  status: MeetingStatus;
  /** Who booked. */
  invitees: MeetingPerson[];
  hosts: MeetingPerson[];
  /** Video call link (Zoom, Meet, Teams, Cal Video…). Always http(s). */
  meetingUrl: string | null;
  /** Address, phone number or note when the place is not a link. */
  location: string | null;
  rescheduleUrl: string | null;
  cancelUrl: string | null;
  canceledReason: string | null;
}

export interface MeetingTypesReport {
  eventTypes: CalendarEventType[];
  /** Oldest first, from two weeks ago to a month ahead. */
  meetings: BookedMeeting[];
  meetingsWindow: { from: string; to: string };
  /** When the booked meetings were last synced from the provider into the database. */
  meetingsSyncedAt: string | null;
  /** Set when meeting types loaded but booked meetings did not. */
  meetingsError: string | null;
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

// --- the organization's scheduling account ----------------------------------

const ORG_CALENDAR = '/org-settings/calendar';

export const getOrganizationCalendar = (): Promise<OrganizationCalendarStatus> =>
  apiFetch<OrganizationCalendarStatus>(ORG_CALENDAR, { auth: true });

export const startCalendlyConnect = (): Promise<{ authorizeUrl: string }> =>
  apiFetch<{ authorizeUrl: string }>(`${ORG_CALENDAR}/calendly/authorize`, {
    method: 'POST',
    auth: true,
    // The response sets the cookie that lets only this browser finish the sign-in.
    withCookies: true,
  });

export interface CalComAccountCheck {
  account: { email: string | null; name: string | null; username: string | null };
  teams: CalComTeamOption[];
}

export const listCalComTeams = (apiKey: string): Promise<CalComAccountCheck> =>
  apiFetch<CalComAccountCheck>(`${ORG_CALENDAR}/cal/teams`, {
    method: 'POST',
    body: { apiKey },
    auth: true,
  });

export const connectCalCom = (apiKey: string, teamId: number | null): Promise<OrganizationCalendarStatus> =>
  apiFetch<OrganizationCalendarStatus>(`${ORG_CALENDAR}/cal/connect`, {
    method: 'POST',
    body: { apiKey, teamId },
    auth: true,
  });

export const activateCalendar = (provider: CalendarProviderId): Promise<OrganizationCalendarStatus> =>
  apiFetch<OrganizationCalendarStatus>(`${ORG_CALENDAR}/activate`, { method: 'POST', body: { provider }, auth: true });

export const disconnectOrganizationCalendar = (): Promise<void> =>
  apiFetch<void>(ORG_CALENDAR, { method: 'DELETE', auth: true });

export const listCalendarMembers = (): Promise<CalendarMember[]> =>
  apiFetch<CalendarMember[]>(`${ORG_CALENDAR}/members`, { auth: true });

export interface AddedAgent {
  user: { id: string; name: string; email: string };
  /** Their working hours were copied from their calendar, or are the organization's defaults. */
  workingHoursFrom: CalendarProviderId | 'organization';
  credentialsEmail?: { sent: boolean; to: string; reason?: string };
}

export const addCalendarMemberAsAgent = (externalId: string): Promise<AddedAgent> =>
  apiFetch<AddedAgent>(`${ORG_CALENDAR}/members/add-agent`, { method: 'POST', body: { externalId }, auth: true });

export type BusySource = 'booking' | 'hold' | 'calendar';

export type AvailabilityStatus = 'ok' | 'limited' | 'unavailable';

export interface TimeRange {
  start: string;
  end: string;
}

export interface MemberAvailability {
  externalId: string;
  name: string;
  email: string;
  /** Their calendar's timezone; their row is drawn in it. */
  timezone: string;
  /** The report's dates as this member's own days, midnight to midnight in `timezone`. */
  days: AvailabilityReportDay[];
  userId: string | null;
  userName: string | null;
  hours: TimeRange[] | null;
  free: TimeRange[];
  busy: (TimeRange & { source: BusySource })[];
  status: AvailabilityStatus;
  message: string | null;
  summary: {
    freeMinutes: number;
    busyMinutes: number;
    freeNow: boolean;
    busyNow: boolean;
    nextFreeAt: string | null;
  };
}

/** One day of the team availability report, as instants bounding it in the report's timezone. */
export interface AvailabilityReportDay {
  date: string;
  start: string;
  end: string;
}

export interface AvailabilityReport {
  provider: CalendarProviderId;
  generatedAt: string;
  /** The calendar dates shown; each member's row shows them in that member's own timezone. */
  dates: string[];
  range: { minDate: string; maxDate: string };
  members: MemberAvailability[];
  totalMembers: number;
  sync: AvailabilitySync;
}

export interface AvailabilitySync {
  syncedAt: string | null;
  syncing: boolean;
  error: string | null;
}

export interface AvailabilityQuery {
  date?: string;
  days?: 1 | 7;
}

export const getCalendarAvailability = (query: AvailabilityQuery = {}): Promise<AvailabilityReport> => {
  const params = new URLSearchParams();
  if (query.date) params.set('date', query.date);
  if (query.days) params.set('days', String(query.days));
  const search = params.toString();
  return apiFetch<AvailabilityReport>(`${ORG_CALENDAR}/availability${search ? `?${search}` : ''}`, { auth: true });
};

export const syncCalendarAvailability = (): Promise<{ outcome: 'synced' | 'busy' | 'skipped'; sync: AvailabilitySync }> =>
  apiFetch(`${ORG_CALENDAR}/availability/sync`, { method: 'POST', auth: true });

export const getMeetingTypes = (): Promise<MeetingTypesReport> =>
  apiFetch<MeetingTypesReport>(`${ORG_CALENDAR}/event-types`, { auth: true });

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
  leadId?: string;
}): Promise<Appointment[]> => {
  const q = new URLSearchParams();
  if (params?.from) q.set('from', params.from);
  if (params?.to) q.set('to', params.to);
  if (params?.status) q.set('status', params.status);
  if (params?.agentId) q.set('agentId', params.agentId);
  if (params?.leadId) q.set('leadId', params.leadId);
  const suffix = q.toString() ? `?${q.toString()}` : '';
  return apiFetch<Appointment[]>(`/appointments${suffix}`, { auth: true });
};

// --- shared helpers ----------------------------------------------------------

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export type CalendlyPopupResult = { outcome: 'ok' | 'failed' | 'closed'; message: string | null };

export function openCalendlyPopup(authorizeUrl: string): Promise<CalendlyPopupResult> {
  return new Promise((resolve) => {
    const width = 600;
    const height = 760;
    const left = Math.max(0, window.screenX + (window.outerWidth - width) / 2);
    const top = Math.max(0, window.screenY + (window.outerHeight - height) / 2);
    const popup = window.open(authorizeUrl, 'calendly-oauth', `width=${width},height=${height},left=${left},top=${top}`);
    if (!popup) {
      window.location.assign(authorizeUrl);
      return;
    }
    popup.focus();

    const finish = (result: CalendlyPopupResult) => {
      window.removeEventListener('message', onMessage);
      clearInterval(poll);
      resolve(result);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.source !== popup) return;
      const data = event.data as { source?: unknown; ok?: unknown; message?: unknown } | null;
      if (data?.source !== 'estatepulse:calendly') return;
      finish({ outcome: data.ok === true ? 'ok' : 'failed', message: typeof data.message === 'string' ? data.message : null });
    };

    window.addEventListener('message', onMessage);
    const poll = window.setInterval(() => {
      if (popup.closed) finish({ outcome: 'closed', message: null });
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
  /** Every event type the assigned agent hosts (own and shared), as links pre-filled for this lead. */
  eventTypes: { id: string; name: string; durationMinutes: number; bookingUrl: string; poolingType: PoolingType | null }[];
  blocker: LeadBookingBlocker | null;
}

export const getLeadBookingOptions = (leadId: string) =>
  apiFetch<LeadBookingOptions>(`/leads/${leadId}/booking-options`, { auth: true });

export const getLeadAppointments = (leadId: string) =>
  apiFetch<Appointment[]>(`/leads/${leadId}/appointments`, { auth: true });
