import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { ConnectionsService } from '../connections/connections.service';
import { ListProvidersQueryDto, PROVIDER_ID } from '../dto/integrations.dto';
import { INTEGRATIONS_ROUTE } from '../integrations.constants';
import type { MarketplaceList, MarketplaceProviderDetail } from '../integrations.types';
import { ProvidersService } from './providers.service';

/** The marketplace catalog. Reading it needs "View lead sources and connected accounts". */
@Controller(`${INTEGRATIONS_ROUTE}/providers`)
export class ProvidersController {
  constructor(
    private readonly providers: ProvidersService,
    private readonly connections: ConnectionsService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  list(@CurrentAuth() auth: AuthContext, @Query() query: ListProvidersQueryDto): Promise<MarketplaceList> {
    return this.providers.list(auth.organizationId, query);
  }

  @Get(':providerId')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  async detail(@CurrentAuth() auth: AuthContext, @Param('providerId') providerId: string): Promise<MarketplaceProviderDetail> {
    if (!PROVIDER_ID.test(providerId)) throw new BadRequestException('Unknown integration.');
    const detail = await this.providers.detail(auth.organizationId, providerId);
    const connections = detail.supported ? await this.connections.list(auth.organizationId, { provider: providerId }) : [];
    return { ...detail, connections };
  }
}
