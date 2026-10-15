import type { Prisma } from '@prisma/client';
import type { AuthContext } from '@/auth/auth.types';
import { DEFAULT_ROLES, PERMISSIONS } from '@/role/permissions';

/** The role that makes a user someone leads are handed to. */
export const AGENT_ROLE_WHERE = {
  isSystem: false,
  name: { equals: DEFAULT_ROLES.AGENT.name, mode: 'insensitive' },
} satisfies Prisma.RoleWhereInput;

export const canReadAllLeads = (auth: AuthContext) => auth.permissions.includes(PERMISSIONS.LEAD_READ);

/** Everyone with lead.read sees every lead; anyone else only the leads assigned to them. */
export const visibleLeads = (auth: AuthContext) =>
  ({
    orgId: auth.organizationId,
    ...(canReadAllLeads(auth) ? {} : { assignedToId: auth.userId }),
  }) satisfies Prisma.LeadWhereInput;

/** Leads still waiting in import review stay out of every lead list. */
export const OUTSIDE_IMPORT_REVIEW = {
  sheetImportRows: { none: { reviewState: { in: ['pending', 'rejected'] } } },
} satisfies Prisma.LeadWhereInput;

export const fullName = (first: string | null | undefined, last: string | null | undefined, fallback = '') =>
  [first, last].filter(Boolean).join(' ').trim() || fallback;
