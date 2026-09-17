import { apiFetch, type Role } from '../lib/api';

/**
 * Agent management. Same shape as strategiesApi: a thin wrapper over apiFetch,
 * which is where the token is attached and the {error:{code}} envelope is
 * decoded, so nothing here does its own error handling.
 *
 * Every call is owner-only server-side. The UI hides the controls from an agent
 * as a courtesy; the 403 is the actual boundary.
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
  /** False for an owner: signup deliberately creates no agent_profiles row. */
  hasProfile: boolean;
  /** Real count from lead_assignments. 0 until lead assignment is built. */
  activeLeads: number;
  /** Real check against calendar_connections. False until calendars are built. */
  calendarConnected: boolean;
}

export interface NewAgentInput {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  /** The initial password the owner sets. Never stored or echoed anywhere. */
  password: string;
}

export const listMembers = (): Promise<OrganizationMember[]> =>
  apiFetch<OrganizationMember[]>('/agents', { auth: true });

/**
 * No role and no organization id in the body: the server hardcodes role=agent
 * and takes the organization from the session, and rejects either field with a
 * 400 if it is sent.
 */
export const createAgent = (input: NewAgentInput): Promise<OrganizationMember> =>
  apiFetch<OrganizationMember>('/agents', { method: 'POST', body: input, auth: true });

export const suspendAgent = (userId: string): Promise<OrganizationMember> =>
  apiFetch<OrganizationMember>(`/agents/${userId}`, {
    method: 'PATCH',
    body: { status: 'suspended' },
    auth: true,
  });

/** "Ada Lovelace", or the email when both name columns are null. */
export const memberName = (m: OrganizationMember): string => {
  const name = [m.firstName, m.lastName].filter(Boolean).join(' ').trim();
  return name.length > 0 ? name : m.email;
};

/** "AL", or the first two characters of the email. */
export const memberInitials = (m: OrganizationMember): string => {
  const initials = ((m.firstName?.trim()[0] ?? '') + (m.lastName?.trim()[0] ?? '')).toUpperCase();
  return initials.length > 0 ? initials : m.email.slice(0, 2).toUpperCase();
};
