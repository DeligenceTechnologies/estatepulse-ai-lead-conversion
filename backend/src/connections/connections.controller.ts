import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseBoolPipe, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { ConnectionsService } from './connections.service';
import { CompleteConnectionDto, ConnectionSessionDto } from './dto/connections.dto';

/**
 * Connecting any outside account, the same way for every provider:
 *
 *   POST /connections/:provider/session   → a short-lived Nango Connect token
 *   (the browser runs Nango Connect: sign in, or enter the API key)
 *   POST /connections/:provider/complete  → { connectionId } from Nango
 *
 * Setting up what an account is used for (which sheet, which number, which
 * team) stays with each feature's own routes.
 */
@Controller('connections')
export class ConnectionsController {
  constructor(private readonly connections: ConnectionsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  catalog(@CurrentAuth() auth: AuthContext) {
    return this.connections.catalog(auth.organizationId);
  }

  @Post(':provider/session')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  session(@CurrentAuth() auth: AuthContext, @Param('provider') provider: string, @Body() body: ConnectionSessionDto) {
    return this.connections.session(auth.organizationId, auth.userId, provider, body.reconnectId);
  }

  @Post(':provider/complete')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  complete(@CurrentAuth() auth: AuthContext, @Param('provider') provider: string, @Body() body: CompleteConnectionDto) {
    return this.connections.complete(auth.organizationId, auth.userId, provider, body.connectionId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  async disconnect(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('force', new ParseBoolPipe({ optional: true })) force?: boolean,
  ) {
    await this.connections.disconnect(auth.organizationId, auth.userId, id, force ?? false);
  }
}
