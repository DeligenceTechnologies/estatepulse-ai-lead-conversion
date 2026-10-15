import { apiFetch, type Role } from '../lib/api';

/**
 * The organization's member list. A thin wrapper over apiFetch, which is where
 * the token is attached and the {error:{code}} envelope is decoded.
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
   * owner who does not take leads is not a routing target, so there is no cap.
   */
  maxActiveLeads: number | null;
  /** False for an owner who has never taken leads; true for every agent. */
  hasProfile: boolean;
  /** agent_profiles.id — what a lead is assigned to. Null when hasProfile is false. */
  profileId: string | null;
  /**
   * Whether routing may hand this member NEW leads. For an owner, the
   * "I also take leads" switch; off keeps the profile and current leads.
   */
  takingLeads: boolean;
  /** Real count from lead_assignments. 0 until lead assignment is built. */
  activeLeads: number;
  /**
   * Whether this agent is on the office's Calendly. False means their bookings
   * cannot be attributed to them — not that the office has no calendar.
   */
  calendarLinked: boolean;
}

export const listMembers = (): Promise<OrganizationMember[]> =>
  apiFetch<OrganizationMember[]>('/agents', { auth: true });

/** "Ada Lovelace", or the email when both name columns are null. */
export const memberName = (m: OrganizationMember): string => {
  const name = [m.firstName, m.lastName].filter(Boolean).join(' ').trim();
  return name.length > 0 ? name : m.email;
};

