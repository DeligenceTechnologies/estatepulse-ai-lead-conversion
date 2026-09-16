import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { hashCredential } from './tokens';

/** Attached to the request once a key resolves. */
export interface TenantContext {
  organizationId: string;
  apiKeyId: string;
  scopes: string[];
}

export interface AuthedRequest extends Request {
  tenant: TenantContext;
}

/**
 * Resolves `X-Api-Key` to an organization.
 *
 * The org is ALWAYS derived from the presented credential, never from the
 * request body. The demo's fake contract put `organization_key` in the payload
 * (see src/components/modals/WebhookSimulatorModal.tsx) — that field is
 * attacker-controlled and would let any caller write into any tenant.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const presented = req.header('x-api-key');

    if (!presented) {
      throw new UnauthorizedException({ error: { code: 'API_KEY_MISSING' } });
    }

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

    req.tenant = {
      organizationId: key.organization_id,
      apiKeyId: key.id,
      scopes: key.scopes,
    };

    // Fire-and-forget: last_used_at is for support triage, and awaiting a write
    // on every request would add a round trip to the hot path for no benefit.
    void this.prisma.api_keys
      .update({ where: { id: key.id }, data: { last_used_at: new Date() } })
      .catch(() => undefined);

    return true;
  }
}
