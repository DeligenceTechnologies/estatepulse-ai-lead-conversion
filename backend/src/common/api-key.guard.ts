import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { verifyToken } from '../auth/jwt';
import { loadAuthContext } from '../auth/service';
import { PrismaService } from '../prisma/prisma.service';
import { hashCredential } from './tokens';

/** Attached to the request once a caller resolves to an organization. */
export interface TenantContext {
  organizationId: string;
  /** Null when the caller authenticated with a session rather than an API key. */
  apiKeyId: string | null;
  scopes: string[];
  /** Null for API-key callers — there is no user behind a machine credential. */
  userId: string | null;
}

export interface AuthedRequest extends Request {
  tenant: TenantContext;
}

const BEARER = 'Bearer ';

/**
 * Resolves a caller to an organization by either credential the product issues:
 *
 *   X-Api-Key            machine callers — form providers' own integrations,
 *                        scripts, and anything server-to-server
 *   Authorization: Bearer  the dashboard, carrying the portal's session token
 *
 * Both paths end at an organization id and nothing else is trusted for tenancy.
 * The org is ALWAYS derived from the presented credential, never from the
 * request body. The demo's fake contract put `organization_key` in the payload
 * (see frontend/src/components/modals/WebhookSimulatorModal.tsx) — that field is
 * attacker-controlled and would let any caller write into any tenant.
 *
 * Accepting the session token is what lets the browser call these routes
 * directly. Before the two backends merged, the dashboard reached them through
 * a proxy that swapped its JWT for a per-org API key; that hop existed only to
 * bridge two processes and is gone with them.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();

    const presented = req.header('x-api-key');
    if (presented) {
      req.tenant = await this.fromApiKey(presented);
      return true;
    }

    const authorization = req.header('authorization');
    if (authorization?.startsWith(BEARER)) {
      req.tenant = await this.fromSession(authorization.slice(BEARER.length).trim());
      return true;
    }

    throw new UnauthorizedException({ error: { code: 'API_KEY_MISSING' } });
  }

  private async fromApiKey(presented: string): Promise<TenantContext> {
    // Hash lookup: one indexed equality probe, and the stored value is useless
    // to anyone who reads the table.
    const key = await this.prisma.api_keys.findUnique({
      where: { key_hash: hashCredential(presented) },
      select: {
        id: true,
        organization_id: true,
        scopes: true,
        revoked_at: true,
        expires_at: true,
      },
    });

    if (!key || key.revoked_at || (key.expires_at && key.expires_at < new Date())) {
      throw new UnauthorizedException({ error: { code: 'API_KEY_INVALID' } });
    }

    // Fire-and-forget: last_used_at is for support triage, and awaiting a write
    // on every request would add a round trip to the hot path for no benefit.
    void this.prisma.api_keys
      .update({ where: { id: key.id }, data: { last_used_at: new Date() } })
      .catch(() => undefined);

    return {
      organizationId: key.organization_id,
      apiKeyId: key.id,
      scopes: key.scopes,
      userId: null,
    };
  }

  private async fromSession(token: string): Promise<TenantContext> {
    if (token.length === 0) {
      throw new UnauthorizedException({ error: { code: 'UNAUTHENTICATED' } });
    }

    let userId: string;
    try {
      userId = verifyToken(token);
    } catch {
      // Deliberately not reflecting the portal's TOKEN_EXPIRED / malformed
      // distinction: these routes answer one question, which org is asking.
      throw new UnauthorizedException({ error: { code: 'UNAUTHENTICATED' } });
    }

    // Membership is read per request, not carried in the token, so a removed
    // or suspended member loses access on the next call rather than whenever
    // the token happens to expire.
    let auth;
    try {
      auth = await loadAuthContext(userId);
    } catch {
      throw new UnauthorizedException({ error: { code: 'NO_ORGANIZATION' } });
    }

    return {
      organizationId: auth.organizationId,
      apiKeyId: null,
      scopes: [],
      userId: auth.userId,
    };
  }
}
