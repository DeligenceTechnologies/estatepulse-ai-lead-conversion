import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { AppError } from '../errors.js';
import { signToken } from './jwt.js';
import { hashPassword, verifyPassword } from './password.js';
import type { AuthContext, AuthSessionDTO, Role } from './types.js';
import { ROLES } from './types.js';
import type { LoginInput, SignupInput } from './schemas.js';

/**
 * Prisma reports a unique violation's target as a string[], a string, or
 * nothing at all depending on whether the index is modelled. The email
 * constraint is an EXPRESSION index on lower(email) which Prisma cannot model,
 * so it arrives as a raw constraint name rather than a field list. Match on
 * every spelling.
 */
function uniqueViolationTargets(err: unknown): string[] {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return [];
  const target = err.meta?.['target'];
  if (Array.isArray(target)) return target.map(String);
  if (typeof target === 'string') return [target];
  return [];
}

const hits = (targets: string[], names: string[]): boolean =>
  targets.some((t) => names.some((n) => t === n || t.includes(n)));

const EMAIL_CONSTRAINTS = ['idx_users_email_unique', 'users_email_key', 'email'];
const SLUG_CONSTRAINTS = ['organizations_slug_key', 'slug'];

/**
 * The only users.status and organization_members.status value that
 * authenticates. Both columns also permit 'invited', 'suspended' and
 * (on users) 'inactive'; none of those may hold a session.
 */
const ACTIVE = 'active';

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
  return base.length > 0 ? base : 'org';
}

/**
 * organization_members_role_check limits the column to 'owner' and 'agent', so
 * anything else means the constraint moved without this code following. Returns
 * null rather than guessing a role: the caller fails closed.
 */
const toRole = (value: string): Role | null => (ROLES.includes(value as Role) ? (value as Role) : null);

/**
 * Creates three rows - users, organizations, organization_members(owner) - in
 * one interactive transaction. No agent_profiles row: not every user is an
 * agent. No organization_settings row: that table does not exist.
 *
 * The bcrypt hash is computed before the transaction opens, so a ~250ms CPU
 * burn never holds a database connection idle.
 */
export async function signup(input: SignupInput): Promise<AuthSessionDTO> {
  const passwordHash = await hashPassword(input.password);
  const baseSlug = slugify(input.organizationName);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = attempt === 0 ? baseSlug : baseSlug + '-' + String(attempt + 1);

    try {
      return await prisma.$transaction(async (tx) => {
        const user = await tx.users.create({
          data: {
            email: input.email,
            password_hash: passwordHash,
            first_name: input.firstName,
            last_name: input.lastName,
          },
          select: { id: true, email: true, first_name: true, last_name: true },
        });

        // timezone, status and routing_policy all carry database defaults.
        const organization = await tx.organizations.create({
          data: { name: input.organizationName, slug },
          select: { id: true, name: true, slug: true },
        });

        await tx.organization_members.create({
          data: {
            organization_id: organization.id,
            user_id: user.id,
            role: 'owner',
            status: 'active',
            joined_at: new Date(),
          },
          select: { id: true },
        });

        return {
          token: signToken(user.id),
          user: {
            id: user.id,
            email: user.email,
            firstName: user.first_name,
            lastName: user.last_name,
          },
          organization,
          role: 'owner' as const,
        };
      });
    } catch (err) {
      const targets = uniqueViolationTargets(err);
      if (hits(targets, EMAIL_CONSTRAINTS)) {
        throw new AppError('EMAIL_TAKEN', 'An account with that email already exists');
      }
      if (hits(targets, SLUG_CONSTRAINTS)) continue; // retry with a suffixed slug
      throw err;
    }
  }

  throw new AppError('INTERNAL', 'Could not allocate an organization slug');
}

export async function login(input: LoginInput): Promise<AuthSessionDTO> {
  // email is no longer a Prisma @unique field - the only remaining constraint
  // is the expression index - so this matches lower(email) directly, which is
  // exactly what that index covers.
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      email: string;
      first_name: string | null;
      last_name: string | null;
      password_hash: string | null;
      status: string;
    }>
  >`
    select id, email, first_name, last_name, password_hash, status
    from users
    where lower(email) = ${input.email}
    limit 1
  `;

  const user = rows[0];
  // Unknown email still runs a bcrypt comparison (verifyPassword against a
  // null hash) so the response time does not reveal whether the account exists.
  // The comparison deliberately runs BEFORE the status check, so a suspended
  // account cannot be identified by a fast rejection either.
  const ok = await verifyPassword(input.password, user?.password_hash ?? null);

  // Only 'active' authenticates. 'invited' has no password set yet, and
  // 'suspended'/'inactive' have had it taken away. All of them fail with the
  // same code as a wrong password: a distinct error would tell whoever holds
  // the credentials that the account exists and is merely disabled.
  if (!user || !ok || user.status !== ACTIVE) {
    throw new AppError('INVALID_CREDENTIALS', 'Invalid email or password');
  }

  const context = await loadAuthContext(user.id);

  return {
    token: signToken(context.userId),
    user: context.user,
    organization: context.organization,
    role: context.role,
  };
}

/**
 * Resolves identity, active organization, role and agent profile in one round
 * trip. Only the user id comes from the token; role and organization are read
 * fresh here on every request.
 *
 * The membership status filter sits in the JOIN condition, before the LIMIT, so
 * an older suspended membership cannot shadow a newer active one.
 *
 * The user status filter sits in the WHERE clause, so a user suspended after
 * their token was issued stops resolving entirely and is rejected as
 * UNAUTHENTICATED rather than keeping access until the token expires. A
 * deleted user and a suspended one are indistinguishable from outside.
 */
export async function loadAuthContext(userId: string): Promise<AuthContext> {
  const rows = await prisma.$queryRaw<
    Array<{
      user_id: string;
      email: string;
      first_name: string | null;
      last_name: string | null;
      role: string | null;
      org_id: string | null;
      org_name: string | null;
      org_slug: string | null;
      agent_profile_id: string | null;
    }>
  >`
    select u.id  as user_id,
           u.email,
           u.first_name,
           u.last_name,
           m.role,
           o.id   as org_id,
           o.name as org_name,
           o.slug as org_slug,
           ap.id  as agent_profile_id
      from users u
      left join organization_members m
        on m.user_id = u.id and m.status = ${ACTIVE}
      left join organizations o
        on o.id = m.organization_id
      left join agent_profiles ap
        on ap.organization_id = m.organization_id and ap.user_id = u.id
     where u.id = ${userId}::uuid
       and u.status = ${ACTIVE}
     order by m.created_at asc nulls last
     limit 1
  `;

  const row = rows[0];
  // Token verified but the user is gone, suspended, invited or inactive: all
  // treated as an unauthenticated caller, never as a server error and never
  // distinguished from one another.
  if (!row) throw new AppError('UNAUTHENTICATED', 'Invalid token');

  // Zero memberships and zero *active* memberships are deliberately the same
  // response. Telling a suspended user they are suspended leaks account state
  // to whoever is holding the token.
  // An unrecognised role resolves to no usable membership, exactly like a
  // missing one: same response, so neither leaks which case it was.
  const role = row.role === null ? null : toRole(row.role);
  if (!row.org_id || !row.org_name || !row.org_slug || !role) {
    throw new AppError('NO_ORGANIZATION', 'No active organization for this user');
  }

  return {
    userId: row.user_id,
    user: { id: row.user_id, email: row.email, firstName: row.first_name, lastName: row.last_name },
    organizationId: row.org_id,
    organization: { id: row.org_id, name: row.org_name, slug: row.org_slug },
    role,
    agentProfileId: row.agent_profile_id,
  };
}
