import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard, type AuthedRequest } from '../../common/api-key.guard';
import { LeadSourcesService } from './lead-sources.service';

@Controller('v1/lead-sources')
@UseGuards(ApiKeyGuard)
export class LeadSourcesController {
  constructor(private readonly service: LeadSourcesService) {}

  /** The signing secret is present in THIS response only. */
  @Post()
  async create(@Req() req: AuthedRequest, @Body() body: { name?: string; requireSignature?: boolean }) {
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
  list(@Req() req: AuthedRequest) {
    return this.service.list(req.tenant.organizationId);
  }

  @Get(':id')
  get(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(req.tenant.organizationId, id);
  }

  @Get(':id/deliveries')
  deliveries(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.deliveries(req.tenant.organizationId, id, limit ? Number(limit) : 25);
  }

  @Post(':id/rotate-secret')
  rotate(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { graceMinutes?: number },
  ) {
    return this.service.rotateSecret(req.tenant.organizationId, id, body?.graceMinutes ?? 60);
  }

  @Post(':id/pause')
  pause(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: { paused?: boolean }) {
    return this.service.setPaused(req.tenant.organizationId, id, body?.paused ?? true);
  }
}
