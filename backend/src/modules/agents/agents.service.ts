import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { hashPassword } from '../../auth/password';
import { ROLES, type Role } from '../../auth/types';
import { AppError } from '../../common/errors';
import { TENANT_PRISMA, type GuardedPrisma } from '../../prisma/prisma.service';
import type { CreateAgentInput } from './schemas';
import type { OrganizationMemberDTO } from './types';

/** Verbatim from organization_members_status_check. */
const ACTIVE = 'active';
const SUSPENDED = 'suspended';

/**
 * Prisma reports a unique violation's target as a string[], a string, or nothing
 * at all. The email constraint is an EXPRESSION index on lower(email) that
 * Prisma cannot model, so it arrives as a raw constraint name. Same handling as
 * AuthService.signup — see the comment there.
 */
function isDuplicateEmail(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  const target = err.meta?.['target'];
  const targets = Array.isArray(target) ? target.map(String) : typeof target === 'string' ? [target] : [];
  return targets.some((t) => ['idx_users_email_unique', 'users_email_key', 'email'].some((n) => t.includes(n)));
}

const toRole = (value: string): Role => (ROLES.includes(value as Role) ? (value as Role) : 'agent');

/** Matches the organizations.timezone / agent_profiles.timezone column default. */
const DEFAULT_TIMEZONE = 'America/Chicago';

/**
 * The one shape the roster is read in, shared by list() and suspend() so both
 * answer with identical data. Columns are named individually and never spread:
 * password_hash lives on users, and a `select: true` here would ship it.
 *
 * The two counts come back as part of this single query rather than as follow-up
 * round trips. Both tables are real and both are empty today — nothing assigns
 * leads and nothing connects calendars yet — so the honest answer is 0/false and
 * it starts being right on its own the day those features land.
 */
const memberSelect = (organizationId: string) =>
  ({
    role: true,
    status: true,
    joined_at: true,
    created_at: true,
    users: {
      select: {
        id: true,
        email: true,
        first_name: true,
        last_name: true,
        phone: true,
        // A list relation scoped to this organization: a user could in principle
        // hold a profile in another tenant, and that one must not be read here.
        agent_profiles: {
          where: { organization_id: organizationId },
          select: {
            timezone: true,
            _count: {
              select: {
                calendar_connections: true,
                lead_assignments: { where: { is_current: true } },
              },
            },
          },
        },
      },
    },
  }) satisfies Prisma.organization_membersSelect;

type MemberRow = {
  role: string;
  status: string;
  joined_at: Date | null;
  created_at: Date;
  users: {
    id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
    agent_profiles: Array<{
      timezone: string;
      _count: { calendar_connections: number; lead_assignments: number };
    }>;
  };
};

function toMemberDTO(m: MemberRow, organizationTimezone: string): OrganizationMemberDTO {
  // At most one, guaranteed by the (organization_id, user_id) unique index.
  const profile = m.users.agent_profiles[0];

  return {
    id: m.users.id,
    firstName: m.users.first_name,
    lastName: m.users.last_name,
    email: m.users.email,
    phone: m.users.phone,
    role: toRole(m.role),
    status: m.status,
    memberSince: m.joined_at ?? m.created_at,
    timezone: profile?.timezone ?? organizationTimezone,
    hasProfile: profile !== undefined,
    activeLeads: profile?._count.lead_assignments ?? 0,
    calendarConnected: (profile?._count.calendar_connections ?? 0) > 0,
  };
}

/**
 * Agent management: the organization roster, adding a member, suspending one.
 *
 * There is no `agents` table. An agent is three rows — users (identity and
 * credentials), organization_members (which tenant, which role, whether they may
 * sign in) and agent_profiles (the per-organization profile that routing and
 * assignment will later read). All three are created together or not at all.
 *
 * `organizationId` is a parameter on every method and always comes from the
 * caller's session via SessionGuard. Nothing here ever reads an organization id
 * out of a body, a query string or a path.
 */
@Injectable()
export class AgentsService {
  constructor(@Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma) {}

  /**
   * Every member of the calling organization, owner first.
   *
   * role descending is exactly owner-before-agent while the role check
   * constraint permits only those two values, and created_at then id break every
   * remaining tie, so the order is stable across calls.
   */
  async list(organizationId: string): Promise<OrganizationMemberDTO[]> {
    // The organization's timezone is the fallback for a member with no agent
    // profile — an owner, in practice. One row, fetched once for the whole page.
    const [organization, members] = await Promise.all([
      // organizations is the tenancy root and is not tenant-scoped: it IS the
      // scope, addressed here by the id the session resolved.
      this.prisma.organizations.findUnique({
        where: { id: organizationId },
        select: { timezone: true },
      }),
      this.prisma.organization_members.findMany({
        where: { organization_id: organizationId },
        orderBy: [{ role: 'desc' }, { created_at: 'asc' }, { id: 'asc' }],
        select: memberSelect(organizationId),
      }),
    ]);

    return members.map((m) => toMemberDTO(m, organization?.timezone ?? DEFAULT_TIMEZONE));
  }

  /**
   * users + organization_members(agent, active) + agent_profiles, in one
   * interactive transaction. A failure at any step leaves none of them behind — a
   * user row with no membership would be an account that can authenticate but
   * belongs to no tenant.
   *
   * No agent_availability and no agent_territories rows: scheduling and
   * territories are separate features, and rows written now would be defaults
   * nobody chose, which is worse than no rows at all.
   *
   * The bcrypt hash is computed before the transaction opens so a ~250ms CPU burn
   * never holds a database connection idle. Same shape as signup.
   */
  async create(organizationId: string, input: CreateAgentInput): Promise<OrganizationMemberDTO> {
    const passwordHash = await hashPassword(input.password);
    const phone = input.phone && input.phone.length > 0 ? input.phone : null;
    const displayName = `${input.firstName} ${input.lastName}`.trim();

    try {
      return await this.prisma.$transaction(async (tx) => {
        // The email arrives lower-cased from the schema and the database's
        // uniqueness index is on lower(email), so this is the same comparison the
        // constraint makes — Test@Example.com cannot slip past test@example.com.
        // The P2002 catch below is still the authority; this check exists so a
        // duplicate is a clean 409 without depending on recognising an index name.
        const existing = await tx.$queryRaw<Array<{ id: string }>>`
          select id from users where lower(email) = ${input.email} limit 1
        `;
        if (existing.length > 0) {
          throw new AppError('EMAIL_TAKEN', 'An account with that email already exists');
        }

        const user = await tx.users.create({
          data: {
            email: input.email,
            password_hash: passwordHash,
            first_name: input.firstName,
            last_name: input.lastName,
            phone,
          },
          select: { id: true, email: true, first_name: true, last_name: true, phone: true },
        });

        const member = await tx.organization_members.create({
          data: {
            organization_id: organizationId,
            user_id: user.id,
            // Hardcoded, never taken from the request. This is the whole reason
            // the create schema is strict: no role input can reach here.
            role: 'agent',
            status: ACTIVE,
            joined_at: new Date(),
          },
          select: { role: true, status: true, joined_at: true, created_at: true },
        });

        const profile = await tx.agent_profiles.create({
          data: {
            organization_id: organizationId,
            user_id: user.id,
            display_name: displayName,
            email: user.email,
            phone,
            // status, timezone, max_active_leads and routing_enabled all carry
            // database defaults. Restating them here would fork the defaults.
          },
          // The timezone comes back rather than being assumed: it is a database
          // default, and reading it is how the response stays right if it moves.
          select: { id: true, timezone: true },
        });

        return {
          id: user.id,
          firstName: user.first_name,
          lastName: user.last_name,
          email: user.email,
          phone: user.phone,
          role: toRole(member.role),
          status: member.status,
          memberSince: member.joined_at ?? member.created_at,
          timezone: profile.timezone,
          hasProfile: true,
          // Brand new: nothing can be assigned to them and no calendar can be
          // connected yet. Both are facts about the rows just written, not
          // placeholders.
          activeLeads: 0,
          calendarConnected: false,
        };
      });
    } catch (err) {
      // Lost the race against a concurrent signup for the same address.
      if (isDuplicateEmail(err)) {
        throw new AppError('EMAIL_TAKEN', 'An account with that email already exists');
      }
      throw err;
    }
  }

  /**
   * Sets organization_members.status = 'suspended'. Nothing is deleted: the user
   * row, the agent profile and everything already assigned to them stay exactly
   * as they are, and the membership can be reinstated by flipping the column back
   * when that flow is built.
   *
   * The effect on an existing session is inherited, not reimplemented.
   * AuthService.loadAuthContext joins organization_members ON status = 'active'
   * on EVERY request, so the token a suspended agent is already holding stops
   * resolving on their next call. There is no second auth mechanism here and no
   * token to revoke.
   */
  async suspend(
    organizationId: string,
    callerUserId: string,
    targetUserId: string,
  ): Promise<OrganizationMemberDTO> {
    // findFirst, not findUnique on the composite key: the tenancy guard only
    // recognises `organization_id` (or a globally-unique key) at the top level of
    // `where`, and a nested organization_id_user_id selector reads to it as an
    // unscoped query. This spelling is both scoped and guard-visible.
    const [organization, member] = await Promise.all([
      this.prisma.organizations.findUnique({
        where: { id: organizationId },
        select: { timezone: true },
      }),
      this.prisma.organization_members.findFirst({
        where: { organization_id: organizationId, user_id: targetUserId },
        // The same shape list() reads, so the response the roster gets back from
        // a suspend is identical to the one a reload would produce.
        select: { id: true, ...memberSelect(organizationId) },
      }),
    ]);

    // A member of another organization and a user id that does not exist are
    // deliberately the same 404. Distinguishing them would confirm the existence
    // of accounts in other tenants.
    if (!member) {
      throw new AppError('NOT_FOUND', 'No such member in this organization');
    }

    // Checked before the role check: an owner suspending themselves would
    // otherwise get the "owners cannot be suspended" message, which is the right
    // outcome by accident and the wrong one the moment a second owner exists.
    if (member.users.id === callerUserId) {
      throw new AppError('FORBIDDEN', 'You cannot suspend your own membership');
    }

    // Suspending the owner is how an organization loses its last administrator
    // and becomes unmanageable. There is no reinstate flow to recover from it.
    if (member.role === 'owner') {
      throw new AppError('FORBIDDEN', 'An organization owner cannot be suspended');
    }

    const updated = await this.prisma.organization_members.update({
      // organization_members.id is a primary key, so this cannot address a row in
      // another tenant — and the row was just read under the organization scope.
      where: { id: member.id },
      // updated_at carries a default but is not @updatedAt, so it is set here or
      // it never moves.
      data: { status: SUSPENDED, updated_at: new Date() },
      select: { status: true },
    });

    // Everything but the status is unchanged by the update, so the row already
    // read is reused rather than fetched again.
    return { ...toMemberDTO(member, organization?.timezone ?? DEFAULT_TIMEZONE), status: updated.status };
  }
}
