/**
 * Auth DTOs. Deliberately duplicated in the frontend rather than shared: these
 * are three small shapes, and the backend's real source of truth is the
 * generated Prisma types, which must not leak into the client.
 *
 * password_hash appears in none of these by construction.
 */

/** Verbatim from organization_members_role_check. */
export type Role = 'owner' | 'agent';

export const ROLES: readonly Role[] = ['owner', 'agent'];

export interface AuthUserDTO {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

export interface AuthOrgDTO {
  id: string;
  name: string;
  slug: string;
}

/** Response body for signup and login. */
export interface AuthSessionDTO {
  token: string;
  user: AuthUserDTO;
  organization: AuthOrgDTO;
  role: Role;
  /**
   * The same field /me answers. On the session too, so a client knows from the
   * first response whether this user takes leads — an owner who signed up as
   * "Just me" has one — without a second round trip.
   */
  agentProfileId: string | null;
}

/** Response body for GET /api/auth/me. */
export interface MeDTO {
  user: AuthUserDTO;
  organization: AuthOrgDTO;
  role: Role;
  agentProfileId: string | null;
}

/** Attached to req.auth by requireAuth. */
export interface AuthContext {
  userId: string;
  user: AuthUserDTO;
  organizationId: string;
  organization: AuthOrgDTO;
  role: Role;
  agentProfileId: string | null;
}
