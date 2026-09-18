import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  EMAIL_CONSTRAINTS,
  SLUG_CONSTRAINTS,
  isDuplicateEmail,
  matchesConstraint,
  uniqueViolationTargets,
} from './prisma-errors';

/**
 * These helpers are the single place that knows how Postgres spells our unique
 * constraints. Two services depend on them to turn a P2002 into a clean 409, so
 * a change here is a behaviour change in both.
 */
const p2002 = (target: unknown): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: target === undefined ? {} : { target },
  });

describe('uniqueViolationTargets', () => {
  it('reads the three shapes Prisma reports a target in', () => {
    expect(uniqueViolationTargets(p2002(['email']))).toEqual(['email']);
    expect(uniqueViolationTargets(p2002('idx_users_email_unique'))).toEqual(['idx_users_email_unique']);
    // An expression index Prisma cannot model reports no target at all.
    expect(uniqueViolationTargets(p2002(undefined))).toEqual([]);
  });

  it('ignores anything that is not a P2002', () => {
    const notUnique = new Prisma.PrismaClientKnownRequestError('nope', {
      code: 'P2025',
      clientVersion: 'test',
    });
    expect(uniqueViolationTargets(notUnique)).toEqual([]);
    expect(uniqueViolationTargets(new Error('plain'))).toEqual([]);
    expect(uniqueViolationTargets(null)).toEqual([]);
  });
});

describe('matchesConstraint', () => {
  it('matches a bare column, an index name, and a prefixed name', () => {
    expect(matchesConstraint(['email'], EMAIL_CONSTRAINTS)).toBe(true);
    expect(matchesConstraint(['users_email_key'], EMAIL_CONSTRAINTS)).toBe(true);
    expect(matchesConstraint(['public.idx_users_email_unique'], EMAIL_CONSTRAINTS)).toBe(true);
  });

  it('does not match an unrelated constraint', () => {
    expect(matchesConstraint(['organizations_slug_key'], EMAIL_CONSTRAINTS)).toBe(false);
    expect(matchesConstraint([], EMAIL_CONSTRAINTS)).toBe(false);
  });

  it('keeps the email and slug constraints distinguishable', () => {
    // The retry loop in signup depends on these two never colliding: a slug
    // clash retries with a suffix, an email clash is a 409.
    expect(matchesConstraint(['organizations_slug_key'], SLUG_CONSTRAINTS)).toBe(true);
    expect(matchesConstraint(['users_email_key'], SLUG_CONSTRAINTS)).toBe(false);
  });
});

describe('isDuplicateEmail', () => {
  it('recognises every spelling of the users-email violation', () => {
    for (const target of ['email', 'users_email_key', 'idx_users_email_unique']) {
      expect(isDuplicateEmail(p2002(target))).toBe(true);
      expect(isDuplicateEmail(p2002([target]))).toBe(true);
    }
  });

  it('is false for a slug clash and for non-Prisma errors', () => {
    expect(isDuplicateEmail(p2002('organizations_slug_key'))).toBe(false);
    expect(isDuplicateEmail(new Error('boom'))).toBe(false);
  });
});
