import { Prisma } from '@prisma/client';
import type { AuthContext } from '@/auth/auth.types';
import { DEFAULT_ROLES, PERMISSIONS } from '@/role/permissions';
import { AWAITING_CONSENT_REVIEW } from './consent';

/** The role that makes a user someone leads are handed to. */
export const AGENT_ROLE_WHERE = {
  isSystem: false,
  name: { equals: DEFAULT_ROLES.AGENT.name, mode: 'insensitive' },
} satisfies Prisma.RoleWhereInput;

export const canReadAllLeads = (auth: AuthContext) => auth.permissions.includes(PERMISSIONS.LEAD_READ);

/** Everyone with lead.read sees every lead (merged-away ones aside); anyone else only the leads assigned to them. */
export const visibleLeads = (auth: AuthContext) =>
  ({
    orgId: auth.organizationId,
    // A lead merged into another is kept only for undo and history; the person lives on the survivor.
    mergedIntoId: null,
    ...(canReadAllLeads(auth) ? {} : { assignedToId: auth.userId }),
  }) satisfies Prisma.LeadWhereInput;

/** A lead awaiting consent review stays out of every lead list. */
export const OUTSIDE_CONSENT_REVIEW = {
  NOT: AWAITING_CONSENT_REVIEW,
} satisfies Prisma.LeadWhereInput;

/** Whether a lead (aliased `l`) may start outreach; the outreach runner re-checks it at release. Never while an agent holds its chat. */
export const RELEASABLE_LEAD = Prisma.sql`l.automation_paused AND NOT l.dnc_status AND l.status = 'new' AND l.normalized_phone IS NOT NULL AND l.taken_over_by_id IS NULL`;

export const fullName = (first: string | null | undefined, last: string | null | undefined, fallback = '') =>
  [first, last].filter(Boolean).join(' ').trim() || fallback;
