import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import jwt from 'jsonwebtoken';
import { AppError } from '../common/errors';
import {
  EMAIL_CONSTRAINTS,
  SLUG_CONSTRAINTS,
  matchesConstraint,
  uniqueViolationTargets,
} from '../common/prisma-errors';
import { TENANT_PRISMA, type GuardedPrisma } from '../prisma/prisma.service';
import { hashPassword, verifyPassword } from './password';
import type { LoginInput, SignupInput } from './schemas';
import { ROLES, type AuthContext, type AuthSessionDTO, type Role } from './types';

/**
 * Absolute session lifetime, enforced twice: by the JWT's own `exp` and by
 * user_sessions.expires_at. There is no refresh: 24 hours after sign-in the
 * holder signs in again, however active they were.
 */
const TOKEN_EXPIRES_IN = '24h';
const SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * Idle timeout, enforced here rather than trusted to the browser: a session
 * whose last heartbeat is this old is rejected on every route. Matches the
 * frontend's IDLE_TIMEOUT_MS, which only exists to show the login page on time.
 */
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

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

@Injectable()
export class AuthService {
  private readonly jwtSecret: string;
  private readonly jwtIssuer: string;

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma,
    config: ConfigService,
  ) {
    // Read once. getOrThrow at construction turns a missing secret into a boot
    // failure instead of a 500 on the first login.
    this.jwtSecret = config.getOrThrow<string>('JWT_SECRET');
    this.jwtIssuer = config.get<string>('JWT_ISSUER') ?? 'estatepulse';
  }

  /**
   * Payload is {sub, jti, iss, iat, exp} and nothing else. No email, no role, no
   * org: role and organization are resolved from organization_members on every
   * request, so a demotion or removal takes effect immediately instead of
   * whenever the token happens to expire. `jti` is the user_sessions row.
   */
  signToken(userId: string, sessionId: string): string {
    return jwt.sign({}, this.jwtSecret, {
      subject: userId,
      jwtid: sessionId,
      issuer: this.jwtIssuer,
      expiresIn: TOKEN_EXPIRES_IN,
      algorithm: 'HS256',
    });
  }

  /**
   * Signature, issuer and `exp` only; says nothing about whether the session is
   * still live. Use authenticate() to admit a request. Throws AppError on any
   * verification failure.
   */
  verifyToken(token: string): { userId: string; sessionId: string } {
    try {
      // The algorithm allowlist is what prevents 'alg: none' and RS/HS confusion.
      const payload = jwt.verify(token, this.jwtSecret, {
        algorithms: ['HS256'],
        issuer: this.jwtIssuer,
      });

      if (typeof payload === 'string' || typeof payload.sub !== 'string' || payload.sub.length === 0) {
        throw new AppError('UNAUTHENTICATED', 'Invalid token');
      }
      // A token issued before server-side sessions existed has no jti, and
      // therefore nothing that could ever revoke or idle it out.
      if (typeof payload.jti !== 'string' || payload.jti.length === 0) {
        throw new AppError('UNAUTHENTICATED', 'Invalid token');
      }
      return { userId: payload.sub, sessionId: payload.jti };
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (err instanceof jwt.TokenExpiredError) {
        throw new AppError('TOKEN_EXPIRED', 'Session expired');
      }
      throw new AppError('UNAUTHENTICATED', 'Invalid token');
    }
  }

  /**
   * The one way a request is admitted, for SessionGuard and TenantGuard alike:
   * a valid signature, a live user_sessions row, and an active membership.
   *
   * The two lookups are independent reads, so they run concurrently. A dead
   * session is reported ahead of a membership problem either way, so a revoked
   * token learns nothing about the account behind it.
   */
  async authenticate(token: string): Promise<{ sessionId: string; auth: AuthContext }> {
    const { userId, sessionId } = this.verifyToken(token);
    const [session, context] = await Promise.allSettled([
      this.assertSessionLive(sessionId, userId),
      this.loadAuthContext(userId),
    ]);
    if (session.status === 'rejected') throw session.reason;
    if (context.status === 'rejected') throw context.reason;
    return { sessionId, auth: context.value };
  }

  /**
   * Revoked and unknown sessions are UNAUTHENTICATED; idle and absolute expiry
   * are TOKEN_EXPIRED, which the client words as "your session has expired".
   */
  async assertSessionLive(sessionId: string, userId: string): Promise<void> {
    const session = await this.prisma.user_sessions.findUnique({
      where: { id: sessionId },
      select: { user_id: true, last_seen_at: true, expires_at: true, revoked_at: true },
    });

    if (!session || session.user_id !== userId || session.revoked_at) {
      throw new AppError('UNAUTHENTICATED', 'Invalid token');
    }

    const now = Date.now();
    if (session.expires_at.getTime() <= now || now - session.last_seen_at.getTime() >= IDLE_TIMEOUT_MS) {
      throw new AppError('TOKEN_EXPIRED', 'Session expired');
    }
  }

  /** The caller is behind SessionGuard, so the session was live a moment ago. */
  async heartbeat(sessionId: string): Promise<void> {
    await this.prisma.user_sessions.updateMany({
      where: { id: sessionId, revoked_at: null },
      data: { last_seen_at: new Date() },
    });
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.prisma.user_sessions.updateMany({
      where: { id: sessionId, revoked_at: null },
      data: { revoked_at: new Date() },
    });
  }

  /**
   * Creates three rows - users, organizations, organization_members(owner) - in
   * one interactive transaction. No agent_profiles row: not every user is an
   * agent. No organization_settings row: that table does not exist.
   *
   * The bcrypt hash is computed before the transaction opens, so a ~250ms CPU
   * burn never holds a database connection idle.
   */
  async signup(input: SignupInput): Promise<AuthSessionDTO> {
    const passwordHash = await hashPassword(input.password);
    const baseSlug = slugify(input.organizationName);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const slug = attempt === 0 ? baseSlug : baseSlug + '-' + String(attempt + 1);

      try {
        return await this.prisma.$transaction(async (tx) => {
          const user = await tx.users.create({
            data: {
              email: input.email,
              password_hash: passwordHash,
              first_name: input.firstName,
              last_name: input.lastName,
            },
            select: { id: true, email: true, first_name: true, last_name: true },
          });

          // status and routing_policy carry database defaults, and so does
          // timezone when the client sent none: passing undefined leaves the
          // column out of the INSERT. When the client did detect one, a new
          // org's calling hours (the quiet-hours gate) match the operator's
          // day out of the box instead of a guess.
          const organization = await tx.organizations.create({
            data: { name: input.organizationName, slug, timezone: input.timezone },
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

          // Inside the transaction: a session for a user whose signup rolled
          // back would be a row pointing at nothing.
          const session = await tx.user_sessions.create({
            data: { user_id: user.id, expires_at: new Date(Date.now() + SESSION_LIFETIME_MS) },
            select: { id: true },
          });

          return {
            token: this.signToken(user.id, session.id),
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
        if (matchesConstraint(targets, EMAIL_CONSTRAINTS)) {
          throw new AppError('EMAIL_TAKEN', 'An account with that email already exists');
        }
        if (matchesConstraint(targets, SLUG_CONSTRAINTS)) continue; // retry with a suffixed slug
        throw err;
      }
    }

    throw new AppError('INTERNAL', 'Could not allocate an organization slug');
  }

  async login(input: LoginInput): Promise<AuthSessionDTO> {
    // email is no longer a Prisma @unique field - the only remaining constraint
    // is the expression index - so this matches lower(email) directly, which is
    // exactly what that index covers.
    const rows = await this.prisma.$queryRaw<
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

    const context = await this.loadAuthContext(user.id);

    // After loadAuthContext, so a user with no active organization gets no
    // session row either.
    const session = await this.prisma.user_sessions.create({
      data: { user_id: context.userId, expires_at: new Date(Date.now() + SESSION_LIFETIME_MS) },
      select: { id: true },
    });

    return {
      token: this.signToken(context.userId, session.id),
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
  async loadAuthContext(userId: string): Promise<AuthContext> {
    const rows = await this.prisma.$queryRaw<
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
}
