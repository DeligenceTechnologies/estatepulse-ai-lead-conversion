import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from '../../auth/auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AppError } from '../errors';
import { hashCredential } from '../tokens';

/** Attached to the request once a caller resolves to an organization. */
export interface TenantContext {
  organizationId: string;
  /** Null when the caller authenticated with a session rather than an API key. */
  apiKeyId: string | null;
  scopes: string[];
  /** Null for API-key callers — there is no user behind a machine credential. */
  userId: string | null;
  /** Null for API-key callers. Long-lived routes (the live stream) re-check it. */
  sessionId: string | null;
}

export interface TenantRequest extends Request {
  tenant: TenantContext;
}

const BEARER = 'Bearer ';

/**
 * Resolves a caller to an organization by either credential the product issues:
 *
 *   X-Api-Key             machine callers — server-to-server, scripts
 *   Authorization: Bearer the dashboard, carrying the user's session token
 *
 * Both paths end at an organization id, and tenancy is NEVER read from the
 * request body. The demo's fake contract put `organization_key` in the payload
 * (see frontend/src/components/modals/WebhookSimulatorModal.tsx) — that field is
 * attacker-controlled and would let any caller write into any tenant.
 *
 * Accepting the session token is what lets the browser call the ingestion routes
 * directly. An ingestion key can read a whole tenant, so it must never be shipped
 * to a browser; deriving the org from the session instead also means two
 * logged-in organizations can never share one credential.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    // Unguarded by necessity: api_keys is looked up by key_hash to discover
    // WHICH tenant is calling. There is no organization id to scope by yet —
    // that is the question this query answers. key_hash is globally unique.
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<TenantRequest>();

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

    throw new AppError('UNAUTHENTICATED', 'An API key or a signed-in session is required');
  }

  private async fromApiKey(presented: string): Promise<TenantContext> {
    // Hash lookup: one indexed equality probe, and the stored value is useless
    // to anyone who reads the table.
    const key = await this.prisma.api_keys.findUnique({
      where: { key_hash: hashCredential(presented) },
      select: { id: true, organization_id: true, scopes: true, revoked_at: true, expires_at: true },
    });

    if (!key || key.revoked_at || (key.expires_at && key.expires_at < new Date())) {
      throw new AppError('UNAUTHENTICATED', 'API key is invalid, revoked or expired');
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
      sessionId: null,
    };
  }

  private async fromSession(token: string): Promise<TenantContext> {
    if (token.length === 0) {
      throw new AppError('UNAUTHENTICATED', 'Missing or malformed Authorization header');
    }

    const { sessionId, auth } = await this.auth.authenticate(token);

    return {
      organizationId: auth.organizationId,
      apiKeyId: null,
      scopes: [],
      userId: auth.userId,
      sessionId,
    };
  }
}
