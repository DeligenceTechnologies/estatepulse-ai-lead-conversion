import { Prisma } from '@prisma/client';

/**
 * Decoding Postgres unique-violation errors, in one place.
 *
 * Both AuthService.signup (a person creating their own account) and
 * AgentsService.create (an owner creating someone else's) insert into `users`
 * and both have to turn the same P2002 into the same clean 409. They had a copy
 * of this each, which is two copies of one fact about the database schema: the
 * moment an index is renamed, one of them silently stops recognising it and
 * starts surfacing a raw Prisma error instead.
 */

/**
 * Prisma reports a unique violation's target as a string[], a string, or
 * nothing at all depending on whether the index is modelled. The email
 * constraint is an EXPRESSION index on lower(email) which Prisma cannot model,
 * so it arrives as a raw constraint name rather than a field list. Match on
 * every spelling.
 */
export function uniqueViolationTargets(err: unknown): string[] {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return [];
  const target = err.meta?.['target'];
  if (Array.isArray(target)) return target.map(String);
  if (typeof target === 'string') return [target];
  return [];
}

/**
 * Substring rather than equality: Postgres may report the bare column, the
 * index name, or a name with a table prefix, and all three mean the same
 * violation.
 */
export const matchesConstraint = (targets: string[], names: string[]): boolean =>
  targets.some((t) => names.some((n) => t.includes(n)));

/** Every spelling Postgres uses for the users-email uniqueness violation. */
export const EMAIL_CONSTRAINTS = ['idx_users_email_unique', 'users_email_key', 'email'];

/** Likewise for organizations.slug. */
export const SLUG_CONSTRAINTS = ['organizations_slug_key', 'slug'];

/** The common case: did this error come from the users-email index? */
export const isDuplicateEmail = (err: unknown): boolean =>
  matchesConstraint(uniqueViolationTargets(err), EMAIL_CONSTRAINTS);
