import { ConfigService } from '@nestjs/config';
import jwt from 'jsonwebtoken';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../common/errors';
import { AuthService } from './auth.service';

/**
 * Token-only unit suite. AuthService's other methods talk to the database and
 * are covered by src/auth/auth.test.ts; signToken/verifyToken touch nothing but
 * the secret, so the prisma dependency is never reached and is left unstubbed.
 */
const SECRET = 'test-secret-not-a-real-one';
const USER_ID = '11111111-2222-3333-4444-555555555555';

const makeService = (): AuthService =>
  new AuthService(
    undefined as never,
    new ConfigService({ JWT_SECRET: SECRET, JWT_ISSUER: 'estatepulse' }),
  );

const decode = (token: string): { iat: number; exp: number; sub: string; iss: string } =>
  jwt.decode(token) as never;

const HOUR = 60 * 60 * 1000;

afterEach(() => {
  vi.useRealTimers();
});

describe('session lifetime', () => {
  it('signs a token that expires exactly 24 hours after issue', () => {
    const { iat, exp } = decode(makeService().signToken(USER_ID));

    expect(exp - iat).toBe(24 * 60 * 60);
  });

  it('accepts a token inside the 24-hour window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T00:00:00Z'));
    const token = makeService().signToken(USER_ID);

    // Freshly issued, and again one minute before the deadline.
    expect(makeService().verifyToken(token)).toBe(USER_ID);
    vi.setSystemTime(new Date('2026-09-22T23:59:00Z'));
    expect(makeService().verifyToken(token)).toBe(USER_ID);
  });

  it('rejects a token past 24 hours as TOKEN_EXPIRED', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T00:00:00Z'));
    const token = makeService().signToken(USER_ID);

    // One second past the deadline. jsonwebtoken allows no clock tolerance
    // unless asked, and it is not asked.
    vi.setSystemTime(new Date('2026-09-22T00:00:00Z').getTime() + 24 * HOUR + 1_000);

    expect(() => makeService().verifyToken(token)).toThrowError(
      expect.objectContaining({ code: 'TOKEN_EXPIRED' }),
    );
  });

  it('rejects a token signed with another secret as UNAUTHENTICATED', () => {
    // An expired token and a forged one must not be confused: only the former
    // tells the client its session simply ended.
    const forged = jwt.sign({}, 'some-other-secret', {
      subject: USER_ID,
      issuer: 'estatepulse',
      expiresIn: '24h',
      algorithm: 'HS256',
    });

    expect(() => makeService().verifyToken(forged)).toThrowError(
      expect.objectContaining({ code: 'UNAUTHENTICATED' }),
    );
  });

  it('throws AppError, never a raw jsonwebtoken error', () => {
    // The exception filter maps AppError to a 401 envelope; a leaked
    // JsonWebTokenError would surface as a 500.
    expect(() => makeService().verifyToken('not-a-token')).toThrowError(AppError);
  });
});
