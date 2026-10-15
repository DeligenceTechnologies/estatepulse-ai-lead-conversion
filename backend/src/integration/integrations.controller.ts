import { Body, Controller, Delete, Get, Param, ParseBoolPipe, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { PrismaService } from '@/common/prisma/prisma.service';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { ConnectIntegrationDto } from './dto/connect-integration.dto';
import { IntegrationsService } from './integrations.service';
import { ProviderRegistry } from './providers/provider.registry';
import { ProviderApiError } from './providers/types';

@Controller('v1/integrations')
export class IntegrationsController {
  constructor(
    private readonly service: IntegrationsService,
    private readonly registry: ProviderRegistry,
  ) {}

  @Get('providers')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  providers() {
    return this.registry.list();
  }

  @Post()
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  connect(@CurrentAuth() auth: AuthContext, @Body() body: ConnectIntegrationDto) {
    return this.service.connect(auth.organizationId, body.provider ?? 'TALLY', body.apiKey, body.label);
  }

  @Get()
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  list(@CurrentAuth() auth: AuthContext, @Query('provider') provider?: string) {
    return this.service.list(auth.organizationId, provider);
  }

  @Post(':id/verify')
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  verify(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.verify(auth.organizationId, id);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  revoke(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('force', new ParseBoolPipe({ optional: true })) force?: boolean,
  ) {
    return this.service.revoke(auth.organizationId, id, force ?? false);
  }

  @Get(':id/forms')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  async forms(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('cursor') cursor?: string,
  ) {
    const orgId = auth.organizationId;
    const cred = await this.service.credentialFor(orgId, id);
    const adapter = this.registry.get(cred.provider);
    let page;
    try {
      page = await adapter.listForms({ apiKey: cred.apiKey }, cursor ?? null);
    } catch (error) {
      if (error instanceof ProviderApiError && error.kind === 'INVALID_CREDENTIAL') {
        await this.service.markInvalid(id, error.kind);
      }
      throw this.service.toHttp(error);
    }
    const connected = await this.service.connectedFormIds(orgId);
    return {
      items: page.items.map((f) => ({
        externalFormId: f.externalFormId,
        name: f.name,
        status: f.status,
        submissionCount: f.submissionCount,
        isClosed: f.isClosed,
        updatedAt: f.updatedAt,
        connectedLeadSourceId: connected.get(f.externalFormId) ?? null,
      })),
      nextCursor: page.nextCursor,
    };
  }
}

/** Every account the organization has connected, of any provider. Never includes credentials. */
@Controller('integrations')
export class OrgIntegrationsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  async list(@CurrentAuth() auth: AuthContext) {
    const rows = await this.prisma.integration.findMany({
      where: { orgId: auth.organizationId, revokedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, provider: true, status: true, externalAccountId: true, label: true, createdAt: true, updatedAt: true },
    });
    return {
      integrations: rows.map((r) => ({
        id: r.id,
        provider: r.provider,
        type: r.provider === 'telnyx' ? 'voice' : r.provider === 'google' ? 'other' : 'crm',
        status: r.status,
        externalAccountId: r.externalAccountId,
        metadata: { label: r.label ?? '' },
        connectedAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
    };
  }
}
