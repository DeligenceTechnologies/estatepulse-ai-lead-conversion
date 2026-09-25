import { ConfigService } from '@nestjs/config';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../common/errors';
import { AuthService, IDLE_TIMEOUT_MS } from './auth.service';

/**
 * Token and session-rule unit suite. The database paths are covered for real by
 * src/auth/auth.test.ts; here signToken/verifyToken touch nothing but the
 * secret, and assertSessionLive reads one row, which a stub stands in for.
 */
const SECRET = 'test-secret-not-a-real-one';
const USER_ID = '11111111-2222-3333-4444-555555555555';
const SESSION_ID = '99999999-8888-7777-6666-555555555555';

interface SessionRow {
  user_id: string;
  last_seen_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

const makeService = (session?: SessionRow | null): AuthService =>
  new AuthService(
    { user_sessions: { findUnique: async () => session ?? null } } as never,
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
    const { iat, exp } = decode(makeService().signToken(USER_ID, SESSION_ID));

    expect(exp - iat).toBe(24 * 60 * 60);
  });

  it('accepts a token inside the 24-hour window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T00:00:00Z'));
    const token = makeService().signToken(USER_ID, SESSION_ID);

    // Freshly issued, and again one minute before the deadline.
    expect(makeService().verifyToken(token)).toEqual({ userId: USER_ID, sessionId: SESSION_ID });
    vi.setSystemTime(new Date('2026-09-22T23:59:00Z'));
    expect(makeService().verifyToken(token)).toEqual({ userId: USER_ID, sessionId: SESSION_ID });
  });

  it('rejects a token past 24 hours as TOKEN_EXPIRED', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T00:00:00Z'));
    const token = makeService().signToken(USER_ID, SESSION_ID);

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

  it('rejects a validly signed token with no session id as UNAUTHENTICATED', () => {
    // What every token issued before server-side sessions looks like. Nothing
    // could revoke or idle it out, so it must not be accepted.
    const legacy = jwt.sign({}, SECRET, { subject: USER_ID, issuer: 'estatepulse', expiresIn: '24h', algorithm: 'HS256' });

    expect(() => makeService().verifyToken(legacy)).toThrowError(expect.objectContaining({ code: 'UNAUTHENTICATED' }));
  });
});

describe('server-side session rules', () => {
  const NOW = new Date('2026-09-25T12:00:00Z').getTime();
  const MIN = 60 * 1000;
  const live = (over: Partial<SessionRow> = {}): SessionRow => ({
    user_id: USER_ID,
    last_seen_at: new Date(NOW - MIN),
    expires_at: new Date(NOW + HOUR),
    revoked_at: null,
    ...over,
  });
  const check = (row: SessionRow | null) => makeService(row).assertSessionLive(SESSION_ID, USER_ID);
  const code = (c: string) => expect.objectContaining({ code: c });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('admits a session seen inside the idle window', async () => {
    await expect(check(live({ last_seen_at: new Date(NOW - IDLE_TIMEOUT_MS + MIN) }))).resolves.toBeUndefined();
  });

  it('rejects a session idle for 30 minutes as TOKEN_EXPIRED', async () => {
    // The bug this exists for: the browser closed, reopened hours later, with a
    // JWT that still has most of its 24 hours left.
    await expect(check(live({ last_seen_at: new Date(NOW - IDLE_TIMEOUT_MS) }))).rejects.toThrowError(code('TOKEN_EXPIRED'));
  });

  it('rejects a session past its absolute expiry however active it was', async () => {
    await expect(check(live({ last_seen_at: new Date(NOW), expires_at: new Date(NOW) }))).rejects.toThrowError(code('TOKEN_EXPIRED'));
  });

  it('rejects a revoked (logged-out) session as UNAUTHENTICATED', async () => {
    await expect(check(live({ revoked_at: new Date(NOW - MIN) }))).rejects.toThrowError(code('UNAUTHENTICATED'));
  });

  it('rejects an unknown session, and one belonging to another user', async () => {
    await expect(check(null)).rejects.toThrowError(code('UNAUTHENTICATED'));
    await expect(check(live({ user_id: '00000000-0000-0000-0000-000000000000' }))).rejects.toThrowError(code('UNAUTHENTICATED'));
  });
});
