import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { hashPassword } from '../../auth/password';
import { ROLES, type Role } from '../../auth/types';
import { AppError } from '../../common/errors';
import { newId } from '../../common/ids';
import { isDuplicateEmail } from '../../common/prisma-errors';
import { MailService } from '../../mail/mail.service';
import { TENANT_PRISMA, type GuardedPrisma } from '../../prisma/prisma.service';
import type { CreateAgentInput, UpdateAgentInput } from './schemas';
import type { CreateAgentResultDTO, OrganizationMemberDTO } from './types';

/** Verbatim from organization_members_status_check. */
const ACTIVE = 'active';
const SUSPENDED = 'suspended';

const toRole = (value: string): Role => (ROLES.includes(value as Role) ? (value as Role) : 'agent');

/** Matches the organizations.timezone / agent_profiles.timezone column default. */
const DEFAULT_TIMEZONE = 'America/Chicago';

/**
 * The one shape the roster is read in, so every roster answer carries identical
 * data — see rosterRows(), the only place it is read. Columns are named
 * individually and never spread: password_hash lives on users, and a `u.*`
 * would ship it.
 *
 * agent_profiles is the member's profile in THIS organization only: a user
 * could in principle hold one in another tenant, and that one must not be read.
 * Its id is there so an edit can address the row it just read by primary key.
 *
 * calendly_user_uri / cal_user_id are NOT a count of calendar_connections. The
 * calendar belongs to the organization now, so the rows that still carry an
 * agent_id are the RETIRED per-agent connections — counting them would report
 * "calendar connected" for anyone who ever connected one, forever. What is true
 * per agent is whether they are on the office's scheduling team, and that is
 * one of these two columns, picked by the provider the office is on — see
 * toMemberDTO.
 */
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
      id: string;
      title: string | null;
      timezone: string;
      max_active_leads: number;
      routing_enabled: boolean;
      calendly_user_uri: string | null;
      cal_user_id: number | null;
      _count: { lead_assignments: number };
    }>;
  };
};

/**
 * What every roster answer needs beyond the member rows: the organization's
 * timezone (the fallback for a member with no profile) and which scheduling
 * provider the office is on (which host-id column says "linked").
 */
interface RosterContext {
  timezone: string;
  /** calendar_connections.provider of the office connection, or null for none. */
  provider: string | null;
}

function toMemberDTO(m: MemberRow, ctx: RosterContext): OrganizationMemberDTO {
  // At most one, guaranteed by the (organization_id, user_id) unique index.
  const profile = m.users.agent_profiles[0];

  // Read for the CONNECTED provider only, the same rule as the owner's
  // calendar panel: an office that switched from Calendly still has
  // calendly_user_uri on every agent, and reporting that as linked would say
  // the roster is fine when no booking can be attributed.
  const hostId = ctx.provider === 'cal' ? profile?.cal_user_id : profile?.calendly_user_uri;

  return {
    id: m.users.id,
    firstName: m.users.first_name,
    lastName: m.users.last_name,
    email: m.users.email,
    phone: m.users.phone,
    role: toRole(m.role),
    status: m.status,
    memberSince: m.joined_at ?? m.created_at,
    timezone: profile?.timezone ?? ctx.timezone,
    title: profile?.title ?? null,
    // Null rather than a stand-in number for a member with no profile: an owner
    // who does not take leads has no lead cap because nothing routes leads to
    // them, and 0 or 25 would both be an invented answer to a question that
    // does not apply.
    maxActiveLeads: profile?.max_active_leads ?? null,
    hasProfile: profile !== undefined,
    profileId: profile?.id ?? null,
    takingLeads: profile?.routing_enabled ?? false,
    activeLeads: profile?._count.lead_assignments ?? 0,
    // No provider connected: nobody is on a scheduling team, whatever a column
    // left over from an earlier connection says.
    calendarLinked: ctx.provider !== null && hostId != null,
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
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma,
    private readonly mail: MailService,
  ) {}

  /**
   * Every member of the calling organization, owner first.
   *
   * role descending is exactly owner-before-agent while the role check
   * constraint permits only those two values, and created_at then id break every
   * remaining tie, so the order is stable across calls.
   */
  async list(organizationId: string): Promise<OrganizationMemberDTO[]> {
    // Fetched once for the whole page, alongside the members.
    const [ctx, members] = await Promise.all([this.rosterContext(organizationId), this.rosterRows(organizationId)]);

    return members.map((m) => toMemberDTO(m, ctx));
  }

  /**
   * The roster's rows for a whole organization — or, given a userId, for that
   * one member of it — in ONE statement.
   *
   * Through Prisma the nested users and agent_profiles relations are each a
   * further sequential query — about 145 ms apiece from a distant region — on
   * the roster every owner screen loads, and twice on every agent edit or
   * taking-leads switch. The rows come back in MemberRow's shape for
   * toMemberDTO, plus the membership's own id for setStatus to update by.
   *
   * No duplicate members: organization_members and agent_profiles are both
   * unique on (organization_id, user_id), so each member joins at most one
   * profile — and only the one in this organization — and a userId matches at
   * most one row. The assignment count is scoped to the organization as well as
   * the profile.
   */
  private async rosterRows(organizationId: string, userId?: string): Promise<Array<MemberRow & { id: string }>> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        role: string;
        status: string;
        joined_at: Date | null;
        created_at: Date;
        user_id: string;
        email: string;
        first_name: string | null;
        last_name: string | null;
        phone: string | null;
        profile_id: string | null;
        title: string | null;
        timezone: string | null;
        max_active_leads: number | null;
        routing_enabled: boolean | null;
        calendly_user_uri: string | null;
        cal_user_id: number | null;
        active_leads: number;
      }>
    >`
      select m.id, m.role, m.status, m.joined_at, m.created_at,
             u.id as user_id, u.email, u.first_name, u.last_name, u.phone,
             ap.id as profile_id, ap.title, ap.timezone, ap.max_active_leads, ap.routing_enabled,
             ap.calendly_user_uri, ap.cal_user_id,
             (select count(*) from lead_assignments la
               where la.agent_id = ap.id and la.organization_id = ap.organization_id and la.is_current
             )::int as active_leads
        from organization_members m
        join users u on u.id = m.user_id
        left join agent_profiles ap on ap.user_id = m.user_id and ap.organization_id = m.organization_id
       where m.organization_id = ${organizationId}::uuid
             ${userId === undefined ? Prisma.empty : Prisma.sql`and m.user_id = ${userId}::uuid`}
       order by m.role desc, m.created_at asc, m.id asc
    `;

    return rows.map((r) => ({
      id: r.id,
      role: r.role,
      status: r.status,
      joined_at: r.joined_at,
      created_at: r.created_at,
      users: {
        id: r.user_id,
        email: r.email,
        first_name: r.first_name,
        last_name: r.last_name,
        phone: r.phone,
        agent_profiles: r.profile_id
          ? [
              {
                id: r.profile_id,
                title: r.title,
                timezone: r.timezone!,
                max_active_leads: r.max_active_leads!,
                routing_enabled: r.routing_enabled!,
                calendly_user_uri: r.calendly_user_uri,
                cal_user_id: r.cal_user_id,
                _count: { lead_assignments: r.active_leads },
              },
            ]
          : [],
      },
    }));
  }

  /**
   * The organization's timezone and its scheduling provider, in parallel.
   *
   * The connection is read the same way CalendarConnectionsService.activeOrgRow
   * reads it — the office row, active first, then the most recent — so the
   * roster and the calendar panel can never disagree about which provider is
   * current. Read here rather than by injecting that service: this module
   * would otherwise depend on the whole calendar module for one column.
   */
  private async rosterContext(organizationId: string): Promise<RosterContext> {
    const [organization, connection] = await Promise.all([
      // organizations is the tenancy root and is not tenant-scoped: it IS the
      // scope, addressed here by the id the session resolved.
      this.prisma.organizations.findUnique({
        where: { id: organizationId },
        select: { timezone: true },
      }),
      this.prisma.calendar_connections.findFirst({
        where: { organization_id: organizationId, agent_id: null },
        orderBy: [{ status: 'asc' }, { updated_at: 'desc' }],
        select: { provider: true },
      }),
    ]);

    return {
      timezone: organization?.timezone ?? DEFAULT_TIMEZONE,
      provider: connection?.provider ?? null,
    };
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
  async create(
    organizationId: string,
    callerUserId: string,
    input: CreateAgentInput,
  ): Promise<CreateAgentResultDTO> {
    const passwordHash = await hashPassword(input.password);
    const phone = input.phone && input.phone.length > 0 ? input.phone : null;
    const displayName = `${input.firstName} ${input.lastName}`.trim();

    let member: OrganizationMemberDTO;
    try {
      member = await this.prisma.$transaction(async (tx) => {
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

        // The creating owner's detected timezone, or failing that the
        // organization's - which list() already treats as a member's default, so
        // inheriting it here is what stops the roster disagreeing with itself.
        // The column default is a US zone and would be wrong for every org that
        // is not; it is reached now only when the organization row is gone.
        const timezone =
          input.timezone ??
          (
            await tx.organizations.findUnique({
              where: { id: organizationId },
              select: { timezone: true },
            })
          )?.timezone;

        const profile = await tx.agent_profiles.create({
          data: {
            organization_id: organizationId,
            user_id: user.id,
            display_name: displayName,
            email: user.email,
            phone,
            timezone,
            // Absent leaves the column default (25) standing, which is the value
            // the form already shows.
            ...(input.maxActiveLeads !== undefined ? { max_active_leads: input.maxActiveLeads } : {}),
            // status and routing_enabled carry database defaults. Restating them
            // here would fork the defaults.
          },
          // These come back rather than being assumed: undefined above leaves
          // each to its column default, and reading them is how the response
          // stays right if a default moves.
          select: { id: true, title: true, timezone: true, max_active_leads: true, routing_enabled: true },
        });

        // Inside the transaction on purpose: the doc comment above promises all
        // of these rows or none, and an audit row for a member that rolled back
        // would be a record of something that never happened.
        await tx.audit_logs.create({
          data: {
            id: newId(),
            organization_id: organizationId,
            // Lowercase: audit_logs_actor_type_check allows only
            // user | agent | ai | system | webhook.
            actor_type: 'user',
            actor_id: callerUserId,
            action: 'member.created',
            entity_type: 'member',
            entity_id: user.id,
            // Never the password or its hash. Email and role are what an audit
            // of "who was given access" has to answer.
            payload: { email: user.email, role: member.role } as never,
          },
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
          title: profile.title,
          maxActiveLeads: profile.max_active_leads,
          hasProfile: true,
          profileId: profile.id,
          takingLeads: profile.routing_enabled,
          // Brand new: nothing can be assigned to them and no calendar can be
          // connected yet. Both are facts about the rows just written, not
          // placeholders.
          activeLeads: 0,
          calendarLinked: false,
        };
      });
    } catch (err) {
      // Lost the race against a concurrent signup for the same address.
      if (isDuplicateEmail(err)) {
        throw new AppError('EMAIL_TAKEN', 'An account with that email already exists');
      }
      throw err;
    }

    // AFTER the commit, deliberately. The agent exists whether or not the email
    // goes out, so a dead SMTP server must not roll back an account that was
    // successfully created — the owner just has to hand the password over
    // themselves instead, which is what this result tells them.
    //
    // Not fire-and-forget either: the owner is standing in front of the form
    // and needs the answer before they decide whether to pick up the phone.
    const organization = await this.prisma.organizations.findUnique({
      where: { id: organizationId },
      select: { name: true },
    });
    const appBaseUrl = process.env['APP_BASE_URL'];

    // .catch as well as MailService's own try/catch: that one covers a failed
    // SEND, this one covers the mailer failing in some way it did not
    // anticipate. Either way the account is already real, so the request must
    // still answer 201 and say the password did not go out.
    const delivery = await this.mail
      .sendAgentWelcome({
        to: member.email,
        firstName: member.firstName,
        organizationName: organization?.name ?? 'your team',
        // The only place the plaintext password travels after hashing. It is
        // not stored, not logged, and not echoed back in the response below.
        password: input.password,
        signInUrl: appBaseUrl ? `${appBaseUrl.replace(/\/$/, '')}/login` : null,
      })
      .catch(() => ({ sent: false, reason: 'The email could not be delivered' }));

    return { ...member, credentialsEmail: { ...delivery, to: member.email } };
  }

  /**
   * Edits an existing agent's profile: the two name columns, the sign-in email
   * and the phone on `users`, and the title, timezone and lead cap on
   * `agent_profiles`. One PATCH, two tables, one transaction.
   *
   * What it deliberately CANNOT change, and why each is absent rather than
   * merely ignored — updateAgentSchema is .strict(), so every one of these is a
   * 400 rather than a silent no-op:
   *   role                — an agent promoting themselves is the whole reason
   *                         POST hardcodes role='agent'
   *   organization        — always the session's, never the body's
   *   membership status   — that is setStatus below, with rules of its own
   *   password            — set at creation and nowhere else
   *   routing_enabled,
   *   agent status        — routing is not built; writing either here would be
   *                         configuring a feature that does not exist yet
   *
   * An agent's profile is editable through this route, and so is the CALLING
   * owner's own — but only once they take leads, i.e. once an agent_profiles
   * row exists. Editing an owner with no profile would mean the backfill below
   * minting one, turning that account into a routing target as a side effect of
   * a name change; that decision belongs to setTakingLeads alone. Another
   * owner's profile is never editable here: one owner does not reconfigure
   * another's routing.
   */
  async updateProfile(
    organizationId: string,
    callerUserId: string,
    targetUserId: string,
    input: UpdateAgentInput,
  ): Promise<OrganizationMemberDTO> {
    // The same two reads, the same shape and the same scoping as setStatus
    // below.
    const [ctx, [member]] = await Promise.all([
      this.rosterContext(organizationId),
      this.rosterRows(organizationId, targetUserId),
    ]);

    // A member of another organization and a user id that does not exist are
    // the same 404, for the same reason as setStatus: telling them apart
    // confirms the existence of accounts in other tenants.
    if (!member) {
      throw new AppError('NOT_FOUND', 'No such member in this organization');
    }

    // At most one, guaranteed by the (organization_id, user_id) unique index.
    const profile = member.users.agent_profiles[0];

    if (member.role !== 'agent') {
      if (member.users.id !== callerUserId) {
        throw new AppError('FORBIDDEN', "Only an agent's profile, or your own, can be edited here");
      }
      if (!profile) {
        throw new AppError('FORBIDDEN', 'Turn on "I also take leads" before editing your agent profile');
      }
    }

    // '' means "clear it" — the same fold create() applies to a blank phone.
    // undefined still means "leave it alone", which is why this cannot collapse
    // into a single `?? null`.
    const blankToNull = (v: string | null | undefined): string | null | undefined =>
      v === undefined ? undefined : v === null || v.length === 0 ? null : v;

    const phone = blankToNull(input.phone);
    const title = blankToNull(input.title);

    // Resolved before the transaction so display_name and the profile's mirror
    // columns are computed from the values that will actually be stored.
    const firstName = input.firstName ?? member.users.first_name;
    const lastName = input.lastName ?? member.users.last_name;
    const email = input.email ?? member.users.email;

    const changed = Object.keys(input);
    const emailChanged = input.email !== undefined && input.email !== member.users.email;

    try {
      await this.prisma.$transaction(async (tx) => {
        // The same lower(email) comparison the database's expression index
        // makes, so Test@Example.com cannot slip past test@example.com. The
        // P2002 catch below is still the authority; this exists so a clash is a
        // clean 409 rather than a raw Prisma error. Scoped to OTHER users:
        // re-saving the form without touching the email must not 409 against
        // the agent's own row.
        if (emailChanged) {
          const taken = await tx.$queryRaw<Array<{ id: string }>>`
            select id from users where lower(email) = ${email} limit 1
          `;
          if (taken.some((u) => u.id !== targetUserId)) {
            throw new AppError('EMAIL_TAKEN', 'An account with that email already exists');
          }
        }

        // users.id is a primary key, and the row was just read under the
        // organization scope, so this cannot address a user in another tenant.
        await tx.users.update({
          where: { id: targetUserId },
          data: {
            ...(input.firstName !== undefined ? { first_name: input.firstName } : {}),
            ...(input.lastName !== undefined ? { last_name: input.lastName } : {}),
            ...(input.email !== undefined ? { email } : {}),
            ...(phone !== undefined ? { phone } : {}),
            // Not @updatedAt in the schema, so it moves here or it never moves.
            updated_at: new Date(),
          },
        });

        // agent_profiles carries its own copies of the name, email and phone,
        // written by create(). They are kept in step here rather than left to
        // drift: nothing reads them today, but a stale copy is a bug waiting
        // for the first feature that does.
        const displayName = [firstName, lastName].filter(Boolean).join(' ').trim() || email;

        const profileData = {
          display_name: displayName,
          email,
          ...(phone !== undefined ? { phone } : {}),
          ...(title !== undefined ? { title } : {}),
          ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
          ...(input.maxActiveLeads !== undefined ? { max_active_leads: input.maxActiveLeads } : {}),
          updated_at: new Date(),
        };

        if (profile) {
          // By primary key: agent_profiles is tenant-scoped, and `id` is one of
          // the globally-unique keys the tenancy guard accepts.
          await tx.agent_profiles.update({ where: { id: profile.id }, data: profileData });
        } else {
          // An agent whose profile row is missing. create() has always written
          // one, but rows predating it exist. Backfilling here is what makes the
          // edit succeed instead of silently dropping half of it; every column
          // not supplied keeps its database default.
          await tx.agent_profiles.create({
            data: {
              organization_id: organizationId,
              user_id: targetUserId,
              ...profileData,
              ...(phone === undefined ? { phone: member.users.phone } : {}),
            },
          });
        }

        await tx.audit_logs.create({
          data: {
            id: newId(),
            organization_id: organizationId,
            actor_type: 'user',
            actor_id: callerUserId,
            action: 'member.updated',
            entity_type: 'member',
            entity_id: targetUserId,
            // Field NAMES, not values: the current values are readable from the
            // row, and an audit table is the last place to accumulate a second
            // copy of everyone's phone number. The email is the exception, for
            // the same reason member.created records it — it is the credential,
            // so "who could sign in as this account, and when did that change"
            // must be answerable from the log alone.
            payload: {
              changed,
              ...(emailChanged ? { email: { from: member.users.email, to: email } } : {}),
            } as never,
          },
        });
      });
    } catch (err) {
      // Lost the race against a concurrent signup or edit for the same address.
      if (isDuplicateEmail(err)) {
        throw new AppError('EMAIL_TAKEN', 'An account with that email already exists');
      }
      throw err;
    }

    // Re-read rather than patching the row already in hand: the write touched
    // two tables and may have created a third row, and a hand-assembled answer
    // is exactly where a response drifts from what was actually stored.
    const [updated] = await this.rosterRows(organizationId, targetUserId);

    return toMemberDTO(updated ?? member, ctx);
  }

  /**
   * Sets organization_members.status. Nothing is deleted either way: the user
   * row, the agent profile and everything already assigned to them stay exactly
   * as they are, so a suspension is a reversible lockout rather than a removal.
   *
   * The effect on an existing session is inherited, not reimplemented.
   * AuthService.loadAuthContext joins organization_members ON status = 'active'
   * on EVERY request, so the token a suspended agent is already holding stops
   * resolving on their next call - and resolves again once they are reinstated.
   * There is no second auth mechanism here and no token to revoke.
   */
  async setStatus(
    organizationId: string,
    callerUserId: string,
    targetUserId: string,
    status: typeof ACTIVE | typeof SUSPENDED,
  ): Promise<OrganizationMemberDTO> {
    // Scoped by the session's organization in the statement itself, and the
    // same rows list() reads, so the response the roster gets back from a
    // suspend is identical to the one a reload would produce.
    const [ctx, [member]] = await Promise.all([
      this.rosterContext(organizationId),
      this.rosterRows(organizationId, targetUserId),
    ]);

    // A member of another organization and a user id that does not exist are
    // deliberately the same 404. Distinguishing them would confirm the existence
    // of accounts in other tenants.
    if (!member) {
      throw new AppError('NOT_FOUND', 'No such member in this organization');
    }

    // Only a lockout needs guarding. Reinstating is safe by construction: a
    // suspended caller's token stops resolving, so they cannot reach this at
    // all, and an owner can never have been suspended in the first place.
    if (status === SUSPENDED) {
      // Checked before the role check: an owner suspending themselves would
      // otherwise get the "owners cannot be suspended" message, which is the
      // right outcome by accident and the wrong one once a second owner exists.
      if (member.users.id === callerUserId) {
        throw new AppError('FORBIDDEN', 'You cannot suspend your own membership');
      }

      // Suspending the owner is how an organization loses its last administrator
      // and becomes unmanageable.
      if (member.role === 'owner') {
        throw new AppError('FORBIDDEN', 'An organization owner cannot be suspended');
      }
    }

    const updated = await this.prisma.organization_members.update({
      // organization_members.id is a primary key, so this cannot address a row in
      // another tenant — and the row was just read under the organization scope.
      where: { id: member.id },
      // updated_at carries a default but is not @updatedAt, so it is set here or
      // it never moves.
      data: { status, updated_at: new Date() },
      select: { status: true },
    });

    await this.prisma.audit_logs.create({
      data: {
        id: newId(),
        organization_id: organizationId,
        actor_type: 'user',
        actor_id: callerUserId,
        // Reinstatement is as audit-worthy as the lockout: both change who can
        // reach the tenant, so both leave a row.
        action: status === SUSPENDED ? 'member.suspended' : 'member.reactivated',
        entity_type: 'member',
        entity_id: targetUserId,
        payload: { from: member.status, to: updated.status } as never,
      },
    });

    // Everything but the status is unchanged by the update, so the row already
    // read is reused rather than fetched again.
    return { ...toMemberDTO(member, ctx), status: updated.status };
  }

  /**
   * The owner's "I also take leads" switch. Always the CALLER's own membership:
   * there is no target id, so one owner cannot volunteer another.
   *
   * ON mints the owner's agent_profiles row the first time — the same row an
   * agent gets from create(), so routing, the calendar roster match and every
   * /api/agents/me route treat the owner exactly like any other agent — and
   * afterwards only flips routing_enabled back on.
   *
   * OFF never deletes the profile. It only clears routing_enabled, so current
   * assignments, their history and the Calendly link all stay where they are;
   * routing simply stops handing this owner NEW leads. Turning it back on
   * resumes the same profile rather than starting a fresh one.
   *
   * Idempotent: asking for the state already in place writes nothing and
   * leaves no audit row.
   */
  async setTakingLeads(
    organizationId: string,
    callerUserId: string,
    enabled: boolean,
  ): Promise<OrganizationMemberDTO> {
    const readSelf = async () => (await this.rosterRows(organizationId, callerUserId))[0];

    const [ctx, member] = await Promise.all([this.rosterContext(organizationId), readSelf()]);

    // SessionGuard just resolved this membership, so a miss means it vanished
    // mid-request; the same 404 every other lookup here gives.
    if (!member) {
      throw new AppError('NOT_FOUND', 'No such member in this organization');
    }

    // OwnerGuard already enforces this. Restated because an agent reaching this
    // method would be switching their own routing, which is the owner's call.
    if (member.role !== 'owner') {
      throw new AppError('FORBIDDEN', 'Only an owner can change whether they take leads');
    }

    const profile = member.users.agent_profiles[0];
    const current = profile?.routing_enabled ?? false;
    if (current === enabled) return toMemberDTO(member, ctx);

    try {
      await this.prisma.$transaction(async (tx) => {
        if (profile) {
          // By primary key, read under the organization scope a moment ago.
          await tx.agent_profiles.update({
            where: { id: profile.id },
            data: { routing_enabled: enabled, updated_at: new Date() },
          });
        } else {
          // Only reachable with enabled=true: no profile means current=false.
          // The same columns create() fills. The login email is the profile
          // email to start with; the Edit form can change it afterwards.
          const displayName =
            [member.users.first_name, member.users.last_name].filter(Boolean).join(' ').trim() ||
            member.users.email;
          await tx.agent_profiles.create({
            data: {
              organization_id: organizationId,
              user_id: callerUserId,
              display_name: displayName,
              email: member.users.email,
              phone: member.users.phone,
              timezone: ctx.timezone,
              // max_active_leads, status and routing_enabled (true) keep their
              // column defaults, exactly as for an agent created by create().
            },
          });
        }

        await tx.audit_logs.create({
          data: {
            id: newId(),
            organization_id: organizationId,
            actor_type: 'user',
            actor_id: callerUserId,
            action: enabled ? 'member.routing_enabled' : 'member.routing_disabled',
            entity_type: 'member',
            entity_id: callerUserId,
            payload: { from: current, to: enabled, profileCreated: !profile } as never,
          },
        });
      });
    } catch (err) {
      // A double-click: the other request created the profile between our read
      // and our insert, and the (organization_id, user_id) unique index refused
      // the second one. The state asked for is already in place, and the
      // winning request left the audit row.
      const raced =
        !profile && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
      if (!raced) throw err;
    }

    const updated = await readSelf();
    return toMemberDTO(updated ?? member, ctx);
  }
}
