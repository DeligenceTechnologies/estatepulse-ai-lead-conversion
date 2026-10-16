import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import { OwnerGuard } from '../../common/guards/owner.guard';
import { SessionGuard, type SessionRequest } from '../../common/guards/session.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { CustomWebhookEnabledGuard } from './custom-webhook-enabled.guard';
import { CustomWebhookService, type Identity } from './custom-webhook.service';
import {
  createSchema,
  saveMappingSchema,
  testSchema,
  updateAuthSchema,
  type CreateBody,
  type SaveMappingBody,
  type TestBody,
  type UpdateAuthBody,
} from './schemas';

/**
 * Owner-only. The organization always comes from the session, never from the
 * request: a source id from another organization is simply not found. Listing,
 * deliveries, pause and secret rotation are the ordinary lead-source routes.
 */
@Controller('api/v1/custom-webhooks')
@UseGuards(SessionGuard, OwnerGuard, CustomWebhookEnabledGuard)
export class CustomWebhookController {
  constructor(private readonly service: CustomWebhookService) {}

  /** Exists only while the flag is on: the UI probes it to show or hide the card. */
  @Get('config')
  config() {
    return { enabled: true };
  }

  @Post()
  @HttpCode(201)
  create(@Req() req: SessionRequest, @Body(new ZodValidationPipe(createSchema, 'Invalid webhook')) body: CreateBody) {
    return this.service.create(who(req), body);
  }

  @Get(':id')
  get(@Req() req: SessionRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(req.auth.organizationId, id);
  }

  @Get(':id/sample')
  sample(@Req() req: SessionRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.sample(req.auth.organizationId, id);
  }

  @Put(':id/mapping')
  saveMapping(
    @Req() req: SessionRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(saveMappingSchema, 'Invalid mapping')) body: SaveMappingBody,
  ) {
    return this.service.saveMapping(who(req), id, body);
  }

  @Post(':id/test')
  @HttpCode(200)
  test(
    @Req() req: SessionRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(testSchema, 'Invalid mapping')) body: TestBody,
  ) {
    return this.service.test(req.auth.organizationId, id, body);
  }

  @Post(':id/activate')
  @HttpCode(200)
  activate(@Req() req: SessionRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.activate(who(req), id);
  }

  @Patch(':id/auth')
  updateAuth(
    @Req() req: SessionRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateAuthSchema, 'Invalid auth settings')) body: UpdateAuthBody,
  ) {
    return this.service.updateAuth(who(req), id, body);
  }
}

const who = (req: SessionRequest): Identity => ({ organizationId: req.auth.organizationId, userId: req.auth.userId });
