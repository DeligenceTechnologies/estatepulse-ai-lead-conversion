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
/**
 * What POST /api/agents answers: the new member, plus whether their credentials
 * actually reached them.
 *
 * A separate shape from OrganizationMemberDTO on purpose. Delivery is a fact
 * about this one request, not a property of a member, and putting it on the
 * roster DTO would mean every listed agent carried a field that could only ever
 * be meaningful for the few seconds after they were created.
 */
export interface CreateAgentResultDTO extends OrganizationMemberDTO {
  credentialsEmail: {
    sent: boolean;
    /** The address it was sent to, or would have been. */
    to: string;
    /** Why it did not go. Present only when `sent` is false. */
    reason?: string;
  };
}

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
   * agent_profiles.timezone, falling back to the organization's for a member
   * with no agent profile, where the organization's value is the only true
   * answer.
   */
  timezone: string;
  /** agent_profiles.title. Null when unset, and for a member with no profile. */
  title: string | null;
  /**
   * agent_profiles.max_active_leads — how many open leads this agent may hold.
   * Null for a member with no profile: an owner who does not take leads is not
   * a routing target, so there is no cap to report rather than a default to
   * pretend about.
   */
  maxActiveLeads: number | null;
  /**
   * Whether an agent_profiles row exists for this member in this organization.
   * False for an owner who has never taken leads: a team signup creates no
   * profile, and one is only minted by "Just me" at signup or by the owner
   * turning on "I also take leads".
   */
  hasProfile: boolean;
  /**
   * agent_profiles.id — what a lead assignment points at. Null exactly when
   * hasProfile is false.
   */
  profileId: string | null;
  /**
   * Whether routing may hand this member new leads — a profile exists and
   * `agent_profiles.routing_enabled` is on. For an owner this is the
   * "I also take leads" switch; turning it off keeps the profile and every
   * existing assignment, so it is never the same fact as `hasProfile`.
   */
  takingLeads: boolean;
  /**
   * Current lead_assignments for this member's agent profile. Zero for everyone
   * until lead assignment exists — the table is real, nothing writes it yet.
   */
  activeLeads: number;
  /**
   * Whether this agent is on the office's scheduling team, for the provider the
   * office is actually on: `agent_profiles.calendly_user_uri` for Calendly,
   * `agent_profiles.cal_user_id` for Cal.com.
   *
   * Not "has a connection of their own": there is no such thing since the
   * calendar moved to the organization. This is the fact that decides whether a
   * booking hosted by them can be attributed to them at all, so a false here is
   * the reason an agent's appointments are empty.
   */
  calendarLinked: boolean;
}
