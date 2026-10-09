import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PrismaService } from '@/common/prisma/prisma.service';
import { effectivePermissions } from '@/role/permissions';
import { AuthErrorCode, IS_PUBLIC_KEY, authError } from '../auth.constants';
import { AuthTokenService } from '../auth-token.service';
import type { AuthContext } from '../auth.types';

/** lastSeenAt is written at most this often per session. */
const LAST_SEEN_THROTTLE_MS = 60_000;

/**
 * Global guard: every route needs a valid access token unless marked @Public().
 *
 * The session row is checked on every request, so logout, logout-all and a
 * password change take effect immediately instead of when the access token
 * expires.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: AuthTokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic || context.getType() !== 'http') {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request & { auth?: AuthContext }>();
    const token = extractBearerToken(request);
    if (!token) {
      throw authError(HttpStatus.UNAUTHORIZED, 'Authentication required.', AuthErrorCode.UNAUTHENTICATED);
    }

    const payload = this.tokens.verifyAccessToken(token);

    const session = await this.prisma.userSession.findUnique({
      where: { id: payload.sid },
      select: {
        userId: true,
        expiresAt: true,
        revokedAt: true,
        lastSeenAt: true,
        user: {
          select: {
            status: true,
            organization: { select: { status: true } },
            roles: { select: { role: { select: { id: true, isSystem: true, permissions: true } } } },
          },
        },
      },
    });

    if (!session || session.userId !== payload.sub || session.revokedAt) {
      throw authError(
        HttpStatus.UNAUTHORIZED,
        'This session is no longer active. Please log in again.',
        AuthErrorCode.SESSION_REVOKED,
      );
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      throw authError(
        HttpStatus.UNAUTHORIZED,
        'Your session has expired. Please log in again.',
        AuthErrorCode.SESSION_EXPIRED,
      );
    }
    if (session.user.status !== 'active' || session.user.organization.status !== 'active') {
      throw authError(HttpStatus.FORBIDDEN, 'This account is inactive.', AuthErrorCode.ACCOUNT_INACTIVE);
    }

    if (Date.now() - session.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS) {
      // Best effort: a failed bookkeeping write must not fail the request.
      this.prisma.userSession
        .update({ where: { id: payload.sid }, data: { lastSeenAt: new Date() } })
        .catch(() => undefined);
    }

    request.auth = {
      userId: payload.sub,
      organizationId: payload.orgId,
      sessionId: payload.sid,
      roleIds: session.user.roles.map(({ role }) => role.id),
      permissions: effectivePermissions(session.user.roles.map(({ role }) => role)),
    };
    return true;
  }
}

function extractBearerToken(request: Request): string | undefined {
  const [scheme, token] = request.headers.authorization?.split(' ') ?? [];
  return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
}
