import { Body, Controller, Delete, Get, Param, ParseBoolPipe, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { LeadSourceProvider } from '@prisma/client';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { ConnectService } from './connect.service';
import {
  ConnectFormDto,
  CreateLeadSourceDto,
  CreateWebhookSourceDto,
  PauseSourceDto,
  RotateSecretDto,
  SetSourceActiveDto,
} from './dto/lead-source.dto';
import { LeadSourcesService } from './lead-sources.service';

@Controller('v1/lead-sources')
export class LeadSourcesController {
  constructor(
    private readonly service: LeadSourcesService,
    private readonly connect: ConnectService,
  ) {}

  @Post('connect')
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  connectForm(@CurrentAuth() auth: AuthContext, @Body() body: ConnectFormDto) {
    return this.connect.connectForm(auth.organizationId, body, auth.userId);
  }

  @Post(':id/resync')
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  resync(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.connect.resync(auth.organizationId, id);
  }

  @Post(':id/reinstall')
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  reinstall(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.connect.reinstall(auth.organizationId, id);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  disconnect(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('removeRemote', new ParseBoolPipe({ optional: true })) removeRemote?: boolean,
    @Query('force', new ParseBoolPipe({ optional: true })) force?: boolean,
  ) {
    return this.connect.disconnect(auth.organizationId, id, auth.userId, removeRemote ?? true, force ?? false);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  create(@CurrentAuth() auth: AuthContext, @Body() body: CreateLeadSourceDto) {
    return this.service.create(auth.organizationId, body);
  }

  @Get()
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  list(@CurrentAuth() auth: AuthContext) {
    return this.service.list(auth.organizationId);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(auth.organizationId, id);
  }

  @Get(':id/deliveries')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  deliveries(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return this.service.deliveries(auth.organizationId, id, limit ?? 25);
  }

  @Post(':id/rotate-secret')
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  rotate(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: RotateSecretDto) {
    return this.service.rotateSecret(auth.organizationId, id, body.graceMinutes ?? 60);
  }

  @Post(':id/pause')
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  pause(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: PauseSourceDto) {
    return this.service.setPaused(auth.organizationId, id, body.paused ?? true);
  }
}

/** The simple webhook sources on the Lead Sources page: a URL any form or Zap can post JSON to. */
@Controller('ingest/sources')
export class WebhookSourcesController {
  constructor(private readonly service: LeadSourcesService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  async list(@CurrentAuth() auth: AuthContext) {
    const sources = await this.service.list(auth.organizationId);
    return {
      sources: sources
        .filter((s) => s.provider === LeadSourceProvider.WEBHOOK)
        .map((s) => ({
          id: s.id,
          label: s.name,
          code: s.code,
          prefix: s.webhookUrl ? s.webhookUrl.split('/').pop()!.slice(0, 13) : null,
          active: s.isActive,
          sourceType: 'webhook',
          hasToken: Boolean(s.webhookUrl),
          createdAt: s.createdAt,
        })),
    };
  }

  @Post()
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  async create(@CurrentAuth() auth: AuthContext, @Body() body: CreateWebhookSourceDto) {
    const created = await this.service.create(auth.organizationId, { name: body.label, provider: LeadSourceProvider.WEBHOOK });
    const token = created.webhookUrl!.split('/').pop()!;
    return {
      id: created.id,
      label: created.name,
      token,
      prefix: token.slice(0, 13),
      webhookUrl: created.webhookUrl,
      tallyUrl: this.service.ingestUrl(token, LeadSourceProvider.TALLY),
    };
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  async setActive(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: SetSourceActiveDto) {
    await this.service.setPaused(auth.organizationId, id, !body.active);
    return { ok: true, active: body.active };
  }
}
