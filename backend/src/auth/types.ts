/**
 * Auth DTOs. Deliberately duplicated in the frontend rather than shared: these
 * are three small shapes, and the backend's real source of truth is the
 * generated Prisma types, which must not leak into the client.
 *
 * password_hash appears in none of these by construction.
 */

/** Verbatim from organization_members.role_check. Not narrowed. */
export type Role = 'owner' | 'admin' | 'team_lead' | 'manager' | 'agent' | 'viewer';

export const ROLES: readonly Role[] = ['owner', 'admin', 'team_lead', 'manager', 'agent', 'viewer'];

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
