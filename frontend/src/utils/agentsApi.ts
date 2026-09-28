import { apiFetch, localTimeZone, type Role } from '../lib/api';

/**
 * Agent management. Same shape as strategiesApi: a thin wrapper over apiFetch,
 * which is where the token is attached and the {error:{code}} envelope is
 * decoded, so nothing here does its own error handling.
 *
 * Every call is owner-only server-side. The UI hides the controls from an agent
 * as a courtesy; the 403 is the actual boundary.
 */

/** One row of GET /api/agents — an organization member, owner included. */
export interface OrganizationMember {
  /** users.id. This is what PATCH addresses. */
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  phone: string | null;
  role: Role;
  /** 'active' | 'invited' | 'suspended' */
  status: string;
  /** organization_members.joined_at, falling back to created_at. */
  memberSince: string | null;
  /** The member's agent profile timezone, or the organization's. */
  timezone: string;
  /** agent_profiles.title. Null when unset, and for a member with no profile. */
  title: string | null;
  /**
   * agent_profiles.max_active_leads. Null for a member with no profile — an
   * owner is not a routing target, so there is no cap to show.
   */
  maxActiveLeads: number | null;
  /** False for an owner: signup deliberately creates no agent_profiles row. */
  hasProfile: boolean;
  /** Real count from lead_assignments. 0 until lead assignment is built. */
  activeLeads: number;
  /**
   * Whether this agent is on the office's Calendly. False means their bookings
   * cannot be attributed to them — not that the office has no calendar.
   */
  calendarLinked: boolean;
}

export interface NewAgentInput {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  /** The initial password the owner sets. Never stored or echoed anywhere. */
  password: string;
  /** Omitted leaves the column default (25) standing. */
  maxActiveLeads?: number;
}

export const listMembers = (): Promise<OrganizationMember[]> =>
  apiFetch<OrganizationMember[]>('/agents', { auth: true });

/**
 * No role and no organization id in the body: the server hardcodes role=agent
 * and takes the organization from the session, and rejects either field with a
 * 400 if it is sent.
 */
/**
 * POST /api/agents answers the new member plus whether their credentials
 * actually reached them. Delivery belongs to the request, not to the member, so
 * it is not on OrganizationMember.
 */
export interface CreateAgentResult extends OrganizationMember {
  credentialsEmail: {
    sent: boolean;
    to: string;
    /** Present only when `sent` is false. */
    reason?: string;
  };
}

export const createAgent = (input: NewAgentInput): Promise<CreateAgentResult> =>
  apiFetch<CreateAgentResult>('/agents', {
    method: 'POST',
    // Detected, never a field on the form. Omitted when the browser cannot say,
    // and the new agent then inherits the organization's timezone.
    body: { ...input, timezone: localTimeZone() },
    auth: true,
  });

/**
 * The editable half of an agent. Every key is optional: the server applies only
 * what it is sent, so a title-only edit leaves the rest untouched. `null` on
 * phone or title clears it, which absent cannot express.
 *
 * There is deliberately no role, organization, status or password here — the
 * server rejects all four with a 400, and they are changed (or not) elsewhere.
 */
export interface AgentProfileUpdate {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string | null;
  title?: string | null;
  timezone?: string;
  maxActiveLeads?: number;
}

/** Saves the Edit Agent form. Same PATCH route as the membership switch below. */
export const updateAgentProfile = (
  userId: string,
  input: AgentProfileUpdate,
): Promise<OrganizationMember> =>
  apiFetch<OrganizationMember>(`/agents/${userId}`, {
    method: 'PATCH',
    body: input,
    auth: true,
  });

/**
 * Both directions of the membership switch. 'suspended' locks the agent out on
 * their next request; 'active' puts them back. Reinstating is what keeps a
 * misclick from needing direct SQL.
 */
export const setAgentStatus = (
  userId: string,
  status: 'suspended' | 'active',
): Promise<OrganizationMember> =>
  apiFetch<OrganizationMember>(`/agents/${userId}`, {
    method: 'PATCH',
    body: { status },
    auth: true,
  });

/** "Ada Lovelace", or the email when both name columns are null. */
export const memberName = (m: OrganizationMember): string => {
  const name = [m.firstName, m.lastName].filter(Boolean).join(' ').trim();
  return name.length > 0 ? name : m.email;
};

/** "AL", or the first two characters of the email. */
export const memberInitials = (m: OrganizationMember): string => {
  const initials = ((m.firstName?.trim()[0] ?? '') + (m.lastName?.trim()[0] ?? '')).toUpperCase();
  return initials.length > 0 ? initials : m.email.slice(0, 2).toUpperCase();
};
