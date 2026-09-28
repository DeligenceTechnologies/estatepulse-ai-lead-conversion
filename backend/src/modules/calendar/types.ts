/**
 * Calendly's wire shapes, and the DTOs we hand the browser.
 *
 * Only the fields we actually read are declared. Calendly returns a great deal
 * more per event; typing all of it would be a second source of truth to keep in
 * sync with a vendor that owns the schema.
 *
 * Nothing here carries a token. `CalendarConnectionDTO` is the shape the SPA
 * receives, and it must stay that way — the same rule `ProviderCredentialSummary`
 * follows in modules/integrations.
 */

/** Wrapper Calendly puts around every single-resource response. */
export interface CalendlyEnvelope<T> {
  resource: T;
}

export interface CalendlyList<T> {
  collection: T[];
  pagination: { count: number; next_page_token: string | null };
}

/** `GET /users/me` */
export interface CalendlyUser {
  uri: string;
  name: string;
  email: string;
  scheduling_url: string;
  timezone: string;
  current_organization: string;
}

/** `POST /oauth/token`, both grant types. */
export interface CalendlyTokenResponse {
  access_token: string;
  refresh_token: string;
  /** Seconds. Calendly currently issues 7200. */
  expires_in: number;
  token_type: string;
  scope?: string;
  owner: string;
  organization: string;
}

export interface CalendlyScheduledEvent {
  uri: string;
  name: string | null;
  /** 'active' | 'canceled'. Calendly spells it with one 'l'; our column uses two. */
  status: string;
  start_time: string;
  end_time: string;
  updated_at: string;
  location?: { type?: string; location?: string | null; join_url?: string | null } | null;
  cancellation?: {
    canceled_by?: string | null;
    reason?: string | null;
    created_at?: string | null;
  } | null;
  /**
   * Who HOSTED the meeting. This is the field the whole organization-level
   * design rests on: one office token returns every member's events, and this
   * is the only thing on the event that says whose it is.
   *
   * A round-robin event type resolves its rotation before the booking is made,
   * so by the time an event exists this already names the single agent who got
   * it. A collective event type legitimately has several; see
   * CalendarSyncService.hostOf for which one is taken.
   */
  event_memberships?: CalendlyEventMembership[];
}

export interface CalendlyEventMembership {
  /** `https://api.calendly.com/users/{uuid}` — matched against agent_profiles.calendly_user_uri. */
  user: string;
  user_email?: string;
  user_name?: string;
}

/** `GET /organization_memberships` — one member of the office's Calendly org. */
export interface CalendlyOrganizationMembership {
  uri: string;
  /** 'owner' | 'admin' | 'user'. Only the first two may read org-scoped events. */
  role: string;
  organization: string;
  user: {
    uri: string;
    name: string;
    email: string;
    scheduling_url: string;
    timezone: string;
  };
}

/**
 * `GET /event_types` — a bookable meeting type.
 *
 * `pooling_type` is what identifies Calendly's team features: 'round_robin'
 * alternates hosts, 'collective' needs everyone free, 'multi_pool' mixes the
 * two, and null is an ordinary one-on-one belonging to a single member.
 */
export interface CalendlyEventType {
  uri: string;
  name: string | null;
  active: boolean;
  slug: string | null;
  duration: number;
  scheduling_url: string;
  kind?: string;
  pooling_type: string | null;
  type?: string;
  profile?: { type?: string; name?: string; owner?: string } | null;
}

export interface CalendlyInvitee {
  uri: string;
  email: string | null;
  name: string | null;
  status: string;
  timezone: string | null;
  text_reminder_number: string | null;
  cancel_url: string | null;
  reschedule_url: string | null;
  /** Set on the OLD event of a reschedule pair. */
  rescheduled: boolean;
  /** On the old event: the replacement. On the new event: `old_invitee`. */
  new_invitee: string | null;
  old_invitee: string | null;
  questions_and_answers?: Array<{ question: string; answer: string; position: number }>;
  tracking?: Record<string, string | null> | null;
}

/** The tokens we hold per connection, encrypted as one blob. */
export interface CalendarTokens {
  access_token: string;
  refresh_token: string;
}

/**
 * `calendar_connections.metadata`. Everything here is non-secret and safe to
 * return; the tokens live in `credentials_secret_ref`.
 *
 * `stateHash` is the exception: it exists only while an OAuth attempt is in
 * flight, and is cleared on success. Its presence on an 'inactive' row is what
 * marks that row as pending — `calendar_connections_status_check` permits only
 * active | inactive | error, so there is no 'pending' status to use.
 */
export interface CalendarConnectionMetadata {
  /** The Calendly account that authorized this — the office's, not an agent's. */
  email?: string;
  name?: string;
  timezone?: string;
  schedulingUrl?: string;
  calendlyUserUri?: string;
  /**
   * The Calendly ORGANIZATION this connection reads.
   *
   * Load-bearing since the move to office-level: it is the `organization`
   * parameter on every `/scheduled_events`, `/organization_memberships` and
   * `/event_types` call, so a connection without it can sync nothing.
   */
  calendlyOrgUri?: string;
  /**
   * The authorizing account's role in that Calendly organization: 'owner',
   * 'admin' or 'user'. Calendly only answers org-scoped reads for the first
   * two, so this is checked at connect time rather than discovered as a 403 on
   * the first sweep.
   */
  calendlyOrgRole?: string;
  scope?: string;
  /** ISO. When the access token stops being usable. */
  tokenExpiresAt?: string;
  /** sha256 of the OAuth nonce, present only while an attempt is in flight. */
  stateHash?: string;
  startedAt?: string;
  connectedAt?: string;
  /** ISO. When the Calendly member roster was last matched to agent_profiles. */
  membersSyncedAt?: string;
  lastError?: string;
  consecutiveFailures?: number;
}

export type CalendarConnectionStatus = 'active' | 'inactive' | 'error';

/**
 * What the SPA sees about the office's Calendly account. No tokens, ever.
 *
 * Deliberately narrow. It once also carried the connected account's own
 * `name`, `timezone` and `schedulingUrl`, which made sense while a connection
 * WAS an agent — their personal booking page was the thing being connected.
 * For an office connection those describe whichever admin happened to
 * authorize it, and are no answer to any question the screen asks: booking
 * pages come from event types, and each agent's timezone from the member
 * roster. Returning them invited exactly the wrong reading, so they are gone.
 */
export interface CalendarConnectionDTO {
  status: CalendarConnectionStatus;
  /** True only for an 'active' row with credentials on file. */
  connected: boolean;
  /** The Calendly account that authorized us — the office's, not an agent's. */
  email: string | null;
  lastSyncedAt: string | null;
  /** Set when the connection needs the owner to re-authorize. */
  lastError: string | null;
}

/**
 * The office's Calendly, as the OWNER sees it.
 *
 * `connection` describes one Calendly account — the one that authorized us —
 * and `calendlyOrganization` describes the team whose bookings it can read.
 * They are different things and the UI says so: connecting a Calendly account
 * that is only a 'user' of its organization is a configuration mistake we can
 * name, not a sync that mysteriously returns nothing.
 */
/** One scheduling provider this build supports, and whether it can be offered. */
export interface CalendarProviderStatusDTO {
  /** 'calendly' | 'cal'. */
  id: string;
  label: string;
  /**
   * False when this deployment cannot offer this provider at all — Calendly
   * without CALENDLY_CLIENT_ID, for instance. Cal.com needs no server-side
   * registration (the office pastes its own key), so it is always true.
   */
  canConnect: boolean;
  /** Why not, when canConnect is false. */
  reason: string | null;
}

export interface OrganizationCalendarStatusDTO {
  /**
   * Which provider is connected, or null.
   *
   * At most one, ever: calendar_connections_org_one_active permits a single
   * live office calendar and connecting one provider retires the other.
   */
  provider: string | null;
  /** Every provider this build supports, connected or not. */
  providers: CalendarProviderStatusDTO[];
  /** Whether the background sweep is running at all. */
  syncEnabled: boolean;
  connection: CalendarConnectionDTO | null;
  /**
   * The team the connection reads, named the way the provider names it — a
   * Cal.com team, or a Calendly organization.
   *
   * Null for Calendly: its API identifies an organization by URI and never
   * returns a human name for it, and showing a UUID would be worse than
   * showing nothing.
   */
  workspaceName: string | null;
  /** The connected account's role on that team: owner | admin | member. */
  workspaceRole: string | null;
  /** ISO. When the member roster was last matched against the agent roster. */
  membersSyncedAt: string | null;
}

/**
 * A Cal.com team the pasted API key can see.
 *
 * Offered before the connection is created: a key's user may belong to several
 * teams, and which one an office books through is a choice only they can make.
 */
export interface CalComTeamOptionDTO {
  id: number;
  name: string;
  slug: string | null;
  /**
   * True for a Cal.com ORGANIZATION rather than a plain team. Those live behind
   * a separate paid tier and different endpoints, so they are listed as
   * unselectable rather than hidden — an owner who sees only an empty list
   * would reasonably conclude their key was wrong.
   */
  isOrganization: boolean;
}

/**
 * What an AGENT sees. Deliberately not the owner's DTO: an agent has nothing
 * to connect and no token to speak of, only two questions — has the office
 * connected a calendar, and am I on it?
 */
export interface CalendarStatusDTO {
  /** Whether the office has a live scheduling connection. */
  organizationConnected: boolean;
  /**
   * Which provider that is — 'calendly' | 'cal' — or null.
   *
   * The agent's screen names the tool they are actually expected to log into,
   * and an office on Cal.com being told to check Calendly would send them
   * somewhere they have no account.
   */
  provider: string | null;
  /** Whether the background sweep is running at all. */
  syncEnabled: boolean;
  /** This agent's id on the provider, or null when they are not linked yet. */
  schedulingUserId: string | null;
  /** This agent's own booking page, when they have one. */
  schedulingUrl: string | null;
  /** ISO. The office connection's last successful sweep. */
  lastSyncedAt: string | null;
}

/** One member of the office's scheduling team, and who they are here. */
export interface CalendarMemberDTO {
  /**
   * The provider's own id for them — a Calendly user URI, or a Cal.com user id
   * as a string. Stable; this is the join key.
   */
  schedulingUserId: string;
  name: string;
  email: string;
  /** owner | admin | user, in Calendly's organization. */
  role: string;
  schedulingUrl: string;
  timezone: string;
  /** The agent_profiles.id this member is linked to, or null when unmatched. */
  agentId: string | null;
  agentName: string | null;
}

/** What one roster match pass did. */
export interface MemberSyncResultDTO {
  /** Calendly members returned by the organization. */
  members: number;
  /** Members newly linked to an agent_profiles row on this pass. */
  linked: number;
  /** Members whose email matches nobody on the EstatePulse roster. */
  unmatched: number;
  /** Agents linked to no member — they cannot receive a synced booking. */
  agentsUnlinked: number;
}

/**
 * A bookable meeting type.
 *
 * `poolingType` is why this endpoint exists at all: 'round_robin' is the link
 * to hand a lead when the provider should pick the agent, and it is the only
 * way to see from here that the office has configured one.
 */
export interface CalendarEventTypeDTO {
  uri: string;
  name: string;
  active: boolean;
  durationMinutes: number;
  schedulingUrl: string;
  /** round_robin | collective | multi_pool | null (an ordinary one-on-one). */
  poolingType: string | null;
  /** The owning member's name, for a personal event type. */
  ownerName: string | null;
  /** 'User' or 'Team', as Calendly reports it. */
  ownerType: string | null;
}

export interface AvailabilityDayDTO {
  /** 0 = Sunday .. 6 = Saturday, matching agent_availability_day_of_week_check. */
  dayOfWeek: number;
  isAvailable: boolean;
  /** 'HH:MM', wall-clock in the agent's own timezone. */
  startTime: string;
  endTime: string;
}

export interface AvailabilityDTO {
  /** agent_profiles.timezone — the zone the times below are written in. */
  timezone: string;
  days: AvailabilityDayDTO[];
}

export interface AppointmentDTO {
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
  status: string;
  /** The Calendly event-type name, e.g. "Buyer Consultation". User-authored. */
  appointmentType: string | null;
  meetingUrl: string | null;
  notes: string | null;
  cancelUrl: string | null;
  rescheduleUrl: string | null;
  canceledReason: string | null;
  createdAt: string;
}

/** What one sync pass did, for the "Sync now" button to report. */
export interface SyncResultDTO {
  scanned: number;
  created: number;
  updated: number;
  /** Events skipped because no lead in this organization matched the invitee. */
  skippedNoLead: number;
  /**
   * Events skipped because their Calendly host is not linked to any agent here.
   *
   * Distinct from skippedNoLead on purpose: a lead that does not exist is
   * ordinary, but a host we cannot place is a roster the owner needs to fix,
   * and the two would be indistinguishable in one counter.
   */
  skippedNoAgent: number;
}
