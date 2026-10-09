import { apiFetch } from '../lib/api';
import type { WorkingDay } from './workingHours';

/**
 * Team members (users) and roles, against the backend's /user and /roles
 * modules. A user may hold several roles and gets every permission of each; an
 * "agent" is simply a user who does not hold the system Owner role.
 *
 * Every call is permission-checked server-side (user.read, user.create, ...);
 * the UI hides controls the caller lacks as a courtesy only.
 */

export type UserStatus = 'active' | 'inactive';

export interface RoleSummary {
  id: string;
  name: string;
  /** The Owner role: every permission, cannot be edited. */
  isSystem: boolean;
}

/** One row of GET /user. */
export interface TeamMember {
  id: string;
  orgId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  status: UserStatus;
  /** IANA time zone, e.g. "Asia/Kolkata" (the default). */
  timezone: string;
  /** How many leads routing may hand them at once; 0 = none (server default 25). */
  maxActiveLeads: number;
  /** Seven days, wall-clock in `timezone` (server default Mon-Fri 09:00-18:00). */
  workingHours: WorkingDay[];
  /**
   * Leads currently assigned to them. Not sent by the server until lead
   * assignment is built on this backend; the UI shows "—" while absent.
   */
  activeLeads?: number;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Every role the member holds, in the order they were given. */
  roles: RoleSummary[];
}

export interface Role extends RoleSummary {
  description: string | null;
  permissions: string[];
  _count: { users: number };
}

export interface PaginationMeta {
  page: number;
  limit: number;
  count: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export interface Paginated<T> {
  data: T[];
  meta: PaginationMeta;
}

/**
 * What GET /user accepts: search matches first name, last name and email; the
 * filters are status and role; the only sort is by join date (createdAt).
 */
export interface ListMembersParams {
  page?: number;
  limit?: number;
  search?: string;
  roleIds?: string[];
  status?: UserStatus;
  /** Join date order; newest first by default. */
  sortOrder?: 'asc' | 'desc';
}

/** Builds a query string, leaving out empty values so the server's defaults apply. */
const toQuery = (params: Record<string, string | number | string[] | undefined>): string => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length) query.set(key, value.join(','));
    } else {
      query.set(key, String(value));
    }
  }
  const text = query.toString();
  return text ? `?${text}` : '';
};

/** One page of the caller's organization's members (the server scopes it to the session). */
export const listMembers = (params: ListMembersParams = {}): Promise<Paginated<TeamMember>> =>
  apiFetch<Paginated<TeamMember>>(
    `/user${toQuery({
      page: params.page,
      limit: params.limit,
      search: params.search?.trim(),
      roleId: params.roleIds,
      status: params.status,
      sortBy: params.sortOrder ? 'createdAt' : undefined,
      sortOrder: params.sortOrder,
    })}`,
    { auth: true },
  );

export interface NewMemberInput {
  orgId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  /** IANA time zone; the server defaults to Asia/Kolkata when omitted. */
  timezone?: string;
  /** 0-1000; the server defaults to 25 when omitted. */
  maxActiveLeads?: number;
  /** All seven days; the server defaults to Mon-Fri 09:00-18:00 when omitted. */
  workingHours?: WorkingDay[];
  /** At least one; the member gets every permission of each. */
  roleIds: string[];
}

/** Whether the welcome email with the sign-in details reached the new member. */
export interface CredentialsEmail {
  sent: boolean;
  to: string;
  /** Present only when `sent` is false. */
  reason?: string;
}

export interface CreatedMember extends TeamMember {
  credentialsEmail: CredentialsEmail;
}

/**
 * The server generates the password and emails it, with the sign-in email, to
 * the new member; the password itself never comes back to the browser.
 */
export const createMember = (input: NewMemberInput): Promise<CreatedMember> =>
  apiFetch<CreatedMember>('/user', { method: 'POST', body: input, auth: true });

/** Only the keys sent are changed. `password` sets a new one (an admin reset). */
export type MemberUpdate = Partial<Omit<NewMemberInput, 'orgId'>> & { password?: string };

export const updateMember = (id: string, input: MemberUpdate): Promise<TeamMember> =>
  apiFetch<TeamMember>(`/user/${id}`, { method: 'PATCH', body: input, auth: true });

export const deleteMember = (id: string): Promise<TeamMember> =>
  apiFetch<TeamMember>(`/user/${id}`, { method: 'DELETE', auth: true });

/** Every role of the organization, for pickers and filters (Owner first). */
export const listRoles = async (): Promise<Role[]> =>
  (await apiFetch<Paginated<Role>>('/roles?limit=100', { auth: true })).data;

/** One module of GET /roles/permissions, e.g. "Users" with its four permissions. */
export interface PermissionGroup {
  module: string;
  label: string;
  permissions: { key: string; label: string }[];
}

/** The catalog the role editor offers, grouped by module. */
export const listPermissionGroups = (): Promise<PermissionGroup[]> =>
  apiFetch<PermissionGroup[]>('/roles/permissions', { auth: true });

export interface RoleInput {
  name: string;
  description?: string;
  permissions: string[];
}

export const createRole = (input: RoleInput): Promise<Role> =>
  apiFetch<Role>('/roles', { method: 'POST', body: input, auth: true });

/** Only the keys sent are changed. The Owner role is refused server-side. */
export const updateRole = (id: string, input: Partial<RoleInput>): Promise<Role> =>
  apiFetch<Role>(`/roles/${id}`, { method: 'PATCH', body: input, auth: true });

/** Refused while any user still has the role. */
export const deleteRole = (id: string): Promise<Role> =>
  apiFetch<Role>(`/roles/${id}`, { method: 'DELETE', auth: true });
