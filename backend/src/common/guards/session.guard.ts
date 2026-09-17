import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from '../../auth/auth.service';
import { AppError } from '../errors';
import type { AuthContext } from '../../auth/types';

export interface SessionRequest extends Request {
  auth: AuthContext;
}

const BEARER = 'Bearer ';

/**
 * Requires a signed-in user and attaches the full AuthContext.
 *
 * The token is trusted for identity and nothing else: `sub` is the only claim
 * read from it. Organization and role come from organization_members on every
 * request, so a demotion, a removal or a suspension takes effect on the next
 * call rather than whenever the token happens to expire.
 *
 * Use this for portal routes, which are about a *user*. Routes that only need
 * to know which tenant is calling should use TenantGuard, which also accepts a
 * machine API key.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<SessionRequest>();
    const header = req.header('authorization');

    if (!header?.startsWith(BEARER)) {
      throw new AppError('UNAUTHENTICATED', 'Missing or malformed Authorization header');
    }

    const token = header.slice(BEARER.length).trim();
    if (token.length === 0) {
      throw new AppError('UNAUTHENTICATED', 'Missing or malformed Authorization header');
    }

    // verifyToken distinguishes expired from invalid, and the client shows a
    // different message for each, so the AppError is allowed through as thrown.
    const userId = this.auth.verifyToken(token);
    req.auth = await this.auth.loadAuthContext(userId);
    return true;
  }
}
