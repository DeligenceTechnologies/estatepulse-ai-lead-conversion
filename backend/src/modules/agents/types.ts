import type { Role } from '../../auth/types';

/**
 * What the roster screen renders. Assembled by hand from organization_members +
 * users + agent_profiles rather than returned from Prisma directly: users
 * carries password_hash, and a raw row would put it on the wire the first time
 * someone adds a `select` they did not mean to.
 *
 * Every field below is read from a table that already exists. Nothing here is a
 * placeholder the API invents — where a feature is not built, the underlying
 * table is simply empty and the number is honestly zero.
 */
export interface OrganizationMemberDTO {
  /** users.id — the id PATCH /api/agents/:userId addresses. */
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  phone: string | null;
  role: Role;
  /** organization_members.status: 'active' | 'invited' | 'suspended'. */
  status: string;
  /** joined_at, falling back to created_at for a row that predates joined_at. */
  memberSince: Date | null;
  /**
   * agent_profiles.timezone, falling back to the organization's. An owner has
   * no agent profile, so the organization's value is the only true answer.
   */
  timezone: string;
  /** agent_profiles.title. Null when unset, and for a member with no profile. */
  title: string | null;
  /**
   * agent_profiles.max_active_leads — how many open leads this agent may hold.
   * Null for a member with no profile: an owner is not a routing target, so
   * there is no cap to report rather than a default to pretend about.
   */
  maxActiveLeads: number | null;
  /**
   * Whether an agent_profiles row exists for this member in this organization.
   * False for an owner created by signup, which deliberately creates no profile.
   */
  hasProfile: boolean;
  /**
   * Current lead_assignments for this member's agent profile. Zero for everyone
   * until lead assignment exists — the table is real, nothing writes it yet.
   */
  activeLeads: number;
  /**
   * Whether a calendar_connections row exists. False for everyone until calendar
   * integration exists — same story as activeLeads.
   */
  calendarConnected: boolean;
}
