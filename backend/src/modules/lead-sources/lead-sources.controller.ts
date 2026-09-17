import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { TenantGuard, type TenantRequest } from '../../common/guards/tenant.guard';
import { ConnectService } from './connect.service';
import { LeadSourcesService } from './lead-sources.service';

@Controller('api/v1/lead-sources')
@UseGuards(TenantGuard)
export class LeadSourcesController {
  constructor(
    private readonly service: LeadSourcesService,
    private readonly connect: ConnectService,
  ) {}

  /**
   * Connect a form through the provider's API: we create the source AND install
   * the webhook AND map the form from its schema.
   *
   * Deliberately returns no signing secret — we installed it, so there is
   * nothing for the customer to paste anywhere.
   */
  @Post('connect')
  async connectForm(
    @Req() req: TenantRequest,
    @Body()
    body: {
      credentialId?: string;
      externalFormId?: string;
      name?: string;
      requireSignature?: boolean;
      prebuildMapping?: boolean;
    },
  ) {
    if (!body?.credentialId || !body?.externalFormId) {
      throw new BadRequestException({
        error: { code: 'VALIDATION_FAILED', message: 'credentialId and externalFormId are required' },
      });
    }
    return this.connect.connectForm(req.tenant.organizationId, {
      credentialId: body.credentialId,
      externalFormId: body.externalFormId,
      name: body.name,
      requireSignature: body.requireSignature,
      prebuildMapping: body.prebuildMapping,
    });
  }

  /** Reconcile what we believe against what the provider actually has. */
  @Post(':id/resync')
  resync(@Req() req: TenantRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.connect.resync(req.tenant.organizationId, id);
  }

  /** Re-install a webhook that was deleted on the provider's side. */
  @Post(':id/reinstall')
  reinstall(@Req() req: TenantRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.connect.reinstall(req.tenant.organizationId, id);
  }

  @Delete(':id')
  disconnect(
    @Req() req: TenantRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('removeRemote') removeRemote?: string,
    @Query('force') force?: string,
  ) {
    return this.connect.disconnect(
      req.tenant.organizationId,
      id,
      removeRemote !== 'false',
      force === 'true',
    );
  }

  /** The signing secret is present in THIS response only. */
  @Post()
  async create(@Req() req: TenantRequest, @Body() body: { name?: string; requireSignature?: boolean }) {
    const name = (body?.name ?? '').trim();
    if (!name) {
      throw new BadRequestException({
        error: { code: 'VALIDATION_FAILED', message: 'name is required' },
      });
    }
    return this.service.create(req.tenant.organizationId, {
      name,
      requireSignature: body.requireSignature,
    });
  }

  @Get()
  list(@Req() req: TenantRequest) {
    return this.service.list(req.tenant.organizationId);
  }

  @Get(':id')
  get(@Req() req: TenantRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(req.tenant.organizationId, id);
  }

  @Get(':id/deliveries')
  deliveries(
    @Req() req: TenantRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.deliveries(req.tenant.organizationId, id, limit ? Number(limit) : 25);
  }

  @Post(':id/rotate-secret')
  rotate(
    @Req() req: TenantRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { graceMinutes?: number },
  ) {
    return this.service.rotateSecret(req.tenant.organizationId, id, body?.graceMinutes ?? 60);
  }

  @Post(':id/pause')
  pause(@Req() req: TenantRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: { paused?: boolean }) {
    return this.service.setPaused(req.tenant.organizationId, id, body?.paused ?? true);
  }
}
