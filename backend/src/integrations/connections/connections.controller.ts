import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import type { SetupResource } from '../adapters/adapter.interface';
import {
  ConfirmConnectionDto,
  ListConnectionsQueryDto,
  ListResourcesQueryDto,
  PROVIDER_ID,
  UpdateSettingsDto,
  UpdateWriteBackDto,
} from '../dto/integrations.dto';
import { INTEGRATIONS_ROUTE } from '../integrations.constants';
import type { ConnectSessionView, ConnectionView } from '../integrations.types';
import { WriteBackService } from '../sync/write-back.service';
import { ConnectionsService } from './connections.service';

/**
 * Connected accounts. Reading needs integration.read; connecting, changing
 * and disconnecting need integration.update. The organization always comes
 * from the session, never from the request.
 */
@Controller(INTEGRATIONS_ROUTE)
export class ConnectionsController {
  constructor(
    private readonly connections: ConnectionsService,
    private readonly writeBack: WriteBackService,
  ) {}

  /** A Nango Connect session for one more account of this provider. */
  @Post(':providerId/connect')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  connect(@CurrentAuth() auth: AuthContext, @Param('providerId') providerId: string): Promise<ConnectSessionView> {
    if (!PROVIDER_ID.test(providerId)) throw new BadRequestException('Unknown integration.');
    return this.connections.startConnect(auth, providerId);
  }

  /** Links what Connect UI reported, after checking with Nango that it belongs to this organization. */
  @Post('connections/confirm')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  confirm(@CurrentAuth() auth: AuthContext, @Body() body: ConfirmConnectionDto): Promise<ConnectionView> {
    return this.connections.confirm(auth, body.providerConfigKey, body.connectionId);
  }

  @Get('connections')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  list(@CurrentAuth() auth: AuthContext, @Query() query: ListConnectionsQueryDto): Promise<ConnectionView[]> {
    return this.connections.list(auth.organizationId, query);
  }

  @Get('connections/:id')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<ConnectionView> {
    return this.connections.get(auth.organizationId, id);
  }

  /** A Connect session that repairs this account in place (expired or revoked grant). */
  @Post('connections/:id/reconnect')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  reconnect(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<ConnectSessionView> {
    return this.connections.startReconnect(auth, id);
  }

  @Post('connections/:id/disconnect')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  disconnect(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<ConnectionView> {
    return this.connections.disconnect(auth, id);
  }

  /** Provider-specific choices for setup, e.g. Airtable bases (kind=bases) or a base's tables (kind=tables&parentId=app…). */
  @Get('connections/:id/resources')
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  resources(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListResourcesQueryDto,
  ): Promise<SetupResource[]> {
    return this.connections.listResources(auth.organizationId, id, query.kind, query.parentId ?? null);
  }

  @Patch('connections/:id/settings')
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  updateSettings(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateSettingsDto,
  ): Promise<ConnectionView> {
    return this.connections.updateSettings(auth, id, body.settings);
  }

  /** Two-way sync on or off for one account. */
  @Patch('connections/:id/write-back')
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  async updateWriteBack(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateWriteBackDto,
  ): Promise<ConnectionView> {
    await this.writeBack.setEnabled(auth, id, body.enabled);
    return this.connections.get(auth.organizationId, id);
  }
}
