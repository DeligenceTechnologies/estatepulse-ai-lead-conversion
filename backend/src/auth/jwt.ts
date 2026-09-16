import jwt from 'jsonwebtoken';
import { env } from '../env';
import { AppError } from '../errors';

const EXPIRES_IN = '7d';

/**
 * Payload is {sub, iss, iat, exp} and nothing else. No email, no role, no org:
 * role and organization are resolved from organization_members on every
 * request, so a demotion or removal takes effect immediately instead of
 * whenever the token happens to expire.
 */
export const signToken = (userId: string): string =>
  jwt.sign({}, env.JWT_SECRET, { subject: userId, issuer: env.JWT_ISSUER, expiresIn: EXPIRES_IN, algorithm: 'HS256' });

/** Returns the subject (user id). Throws AppError on any verification failure. */
export function verifyToken(token: string): string {
  try {
    // The algorithm allowlist is what prevents 'alg: none' and RS/HS confusion.
    const payload = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: env.JWT_ISSUER,
    });

    if (typeof payload === 'string' || typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new AppError('UNAUTHENTICATED', 'Invalid token');
    }
    return payload.sub;
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof jwt.TokenExpiredError) {
      throw new AppError('TOKEN_EXPIRED', 'Session expired');
    }
    throw new AppError('UNAUTHENTICATED', 'Invalid token');
  }
}
