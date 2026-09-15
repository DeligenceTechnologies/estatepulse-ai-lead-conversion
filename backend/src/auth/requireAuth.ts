import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../errors.js';
import { verifyToken } from './jwt.js';
import { loadAuthContext } from './service.js';

const BEARER = 'Bearer ';

/**
 * The token is trusted for identity and nothing else: sub is the only claim
 * read from it. Organization and role are loaded from organization_members on
 * every request, so a demotion or a suspension takes effect on the next call
 * rather than whenever the token expires.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.get('authorization');

  if (!header || !header.startsWith(BEARER)) {
    next(new AppError('UNAUTHENTICATED', 'Missing or malformed Authorization header'));
    return;
  }

  const token = header.slice(BEARER.length).trim();
  if (token.length === 0) {
    next(new AppError('UNAUTHENTICATED', 'Missing or malformed Authorization header'));
    return;
  }

  let userId: string;
  try {
    userId = verifyToken(token);
  } catch (err) {
    next(err);
    return;
  }

  loadAuthContext(userId)
    .then((auth) => {
      req.auth = auth;
      next();
    })
    .catch(next);
}
