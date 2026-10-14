import type { CalendarConnectionStatus, Prisma } from '@prisma/client';

/**
 * A connection's `status` says both whether it is in use and whether it works:
 *
 * - `active`   in use and working
 * - `error`    in use, but the provider stopped accepting it (reconnect needed)
 * - `inactive` saved but not in use, so the organization can switch back
 *              without signing in again
 *
 * An organization has at most one connection in use. Every change to which
 * one is in use happens under `lockOrganization`.
 */
export const IN_USE_STATUSES = ['active', 'error'] as const satisfies readonly CalendarConnectionStatus[];

/** `where` filter for the organization's connection in use (working or not). */
export const inUse = (orgId: string) =>
  ({ orgId, status: { in: [...IN_USE_STATUSES] } }) satisfies Prisma.CalendarConnectionWhereInput;

export type ConnectionHealth = 'active' | 'error';

/**
 * Whether a connection works, in use or not. A saved connection keeps the
 * error it was switched off with, so it is offered for reconnecting rather
 * than switching back to.
 */
export function connectionHealth(connection: {
  status: CalendarConnectionStatus;
  lastError: string | null;
}): ConnectionHealth {
  if (connection.status === 'error') return 'error';
  if (connection.status === 'inactive' && connection.lastError) return 'error';
  return 'active';
}
