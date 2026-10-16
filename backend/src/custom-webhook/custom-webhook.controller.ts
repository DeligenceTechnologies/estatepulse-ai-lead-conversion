import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, UseGuards } from '@nestjs/common';
import type { ZodType } from 'zod';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { AppError } from '@/common/errors/app-error';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { CustomWebhookEnabledGuard } from './custom-webhook-enabled.guard';
import { CustomWebhookService, type Identity } from './custom-webhook.service';
import { createSchema, saveMappingSchema, testSchema, updateAuthSchema } from './schemas';

/**
 * Custom webhooks: `/v1/custom-webhooks/...`. The organization always comes
 * from the session, never from the request: a source id from another
 * organization is simply not found. Listing, deliveries, pause and secret
 * rotation are the ordinary lead-source routes.
 */
@Controller('v1/custom-webhooks')
@UseGuards(CustomWebhookEnabledGuard)
export class CustomWebhookController {
  constructor(private readonly service: CustomWebhookService) {}

  /** Exists only while the flag is on: the UI probes it to show or hide the card. */
  @Get('config')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  config() {
    return { enabled: true };
  }

  @Post()
  @HttpCode(201)
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  create(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.create(who(auth), parse(createSchema, body, 'Invalid webhook'));
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(auth.organizationId, id);
  }

  @Get(':id/sample')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  sample(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.sample(auth.organizationId, id);
  }

  @Put(':id/mapping')
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  saveMapping(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.service.saveMapping(who(auth), id, parse(saveMappingSchema, body, 'Invalid mapping'));
  }

  @Post(':id/test')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  test(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.service.test(auth.organizationId, id, parse(testSchema, body ?? {}, 'Invalid mapping'));
  }

  @Post(':id/activate')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  activate(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.activate(who(auth), id);
  }

  @Patch(':id/auth')
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  updateAuth(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.service.updateAuth(who(auth), id, parse(updateAuthSchema, body, 'Invalid auth settings'));
  }
}

const who = (auth: AuthContext): Identity => ({ organizationId: auth.organizationId, userId: auth.userId });

/** Validates a body against its schema, answering 400 with the field errors the UI points at. */
function parse<T>(schema: ZodType<T>, body: unknown, message: string): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  throw new AppError(
    'VALIDATION_ERROR',
    message,
    result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  );
}
