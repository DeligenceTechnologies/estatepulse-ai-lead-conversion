import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { OrgId } from '../common/decorators/auth.decorators';
import { AppError } from '../common/errors';
import { SessionGuard } from '../common/guards/session.guard';
import { UpstreamErrorInterceptor } from '../common/interceptors/upstream-error.interceptor';
import { TENANT_PRISMA, type GuardedPrisma } from '../prisma/prisma.service';
import { AssistantService } from './assistant.service';
import { CredStoreService, type Creds, type TelnyxPublicStatus } from './cred-store.service';
import { NumbersService } from './numbers.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Bring-Your-Own-Telnyx: the tenant's own provider account, its assistant, and
 * its phone numbers. Every route is session-authed and scoped to the caller's
 * organization — the org id is never read from the body.
 */
@Controller('api/telnyx')
@UseGuards(SessionGuard)
@UseInterceptors(UpstreamErrorInterceptor)
export class TelnyxController {
  constructor(
    private readonly creds: CredStoreService,
    private readonly assistant: AssistantService,
    private readonly numbers: NumbersService,
  ) {}

  @Get('status')
  status(@OrgId() orgId: string): Promise<TelnyxPublicStatus> {
    return this.creds.publicStatus(orgId);
  }

  @Put('credentials')
  async saveCredentials(@OrgId() orgId: string, @Body() body: any): Promise<TelnyxPublicStatus> {
    const { apiKey, publicKey, connectionId, messagingProfileId, fromNumber } = body ?? {};
    if (apiKey !== undefined && (typeof apiKey !== 'string' || !/^KEY/.test(apiKey))) {
      throw new AppError('VALIDATION_ERROR', 'A valid Telnyx API key (starts with "KEY") is required.');
    }

    const patch: Partial<Creds> = {};
    if (apiKey) patch.apiKey = apiKey;
    if (publicKey !== undefined) patch.publicKey = publicKey;
    if (connectionId !== undefined) patch.connectionId = connectionId;
    if (messagingProfileId !== undefined) patch.messagingProfileId = messagingProfileId;
    if (fromNumber !== undefined) patch.fromNumber = fromNumber;

    await this.creds.saveCreds(orgId, patch);
    return this.creds.publicStatus(orgId);
  }

  /** Soft disconnect: the row and its encrypted key are kept, status goes inactive. */
  @Delete('credentials')
  async clearCredentials(@OrgId() orgId: string): Promise<TelnyxPublicStatus> {
    await this.creds.clearCreds(orgId);
    return this.creds.publicStatus(orgId);
  }

  /** Re-activate the stored integration without re-entering the key. */
  @Post('reconnect')
  @HttpCode(HttpStatus.OK)
  async reconnect(@OrgId() orgId: string): Promise<TelnyxPublicStatus> {
    await this.creds.reconnect(orgId);
    return this.creds.publicStatus(orgId);
  }

  // ---- Assistant provisioning ----

  @Post('assistant/create')
  @HttpCode(HttpStatus.CREATED)
  async createAssistant(@OrgId() orgId: string, @Body() body: any) {
    const assistant = await this.assistant.createAssistant(orgId, body ?? {});
    return { assistant, status: await this.creds.publicStatus(orgId) };
  }

  @Get('assistants')
  async listAssistants(@OrgId() orgId: string) {
    return { assistants: await this.assistant.listAssistants(orgId) };
  }

  @Post('assistant/attach')
  @HttpCode(HttpStatus.OK)
  async attachAssistant(@OrgId() orgId: string, @Body() body: any) {
    const assistantId = body?.assistantId;
    if (!assistantId) throw new AppError('VALIDATION_ERROR', 'assistantId is required');
    const assistant = await this.assistant.setAssistantId(orgId, assistantId);
    return { assistant, status: await this.creds.publicStatus(orgId) };
  }

  // ---- Phone numbers ----

  @Get('numbers/available')
  async available(
    @OrgId() orgId: string,
    @Query('country') country?: string,
    @Query('area') area?: string,
    @Query('features') features?: string,
    @Query('type') type?: string,
    @Query('limit') limit?: string,
  ) {
    const numbers = await this.numbers.searchAvailable(orgId, {
      country: country || 'US',
      areaCode: area || undefined,
      features: features ? String(features).split(',') : undefined,
      type: type || 'local',
      limit: limit ? Number(limit) : 10,
    });
    return { numbers };
  }

  @Get('numbers/owned')
  async owned(@OrgId() orgId: string) {
    return { numbers: await this.numbers.listOwned(orgId) };
  }

  @Post('numbers/buy')
  @HttpCode(HttpStatus.CREATED)
  async buy(@OrgId() orgId: string, @Body() body: any) {
    const phone = body?.phone_number;
    if (!phone) throw new AppError('VALIDATION_ERROR', 'phone_number is required');
    return { order: await this.numbers.buyNumber(orgId, phone) };
  }

  @Post('numbers/assign')
  @HttpCode(HttpStatus.OK)
  async assign(@OrgId() orgId: string, @Body() body: any) {
    const phone = body?.phone_number;
    if (!phone) throw new AppError('VALIDATION_ERROR', 'phone_number is required');
    const r = await this.numbers.assignNumber(orgId, phone);
    return { ...r, status: await this.creds.publicStatus(orgId) };
  }

  @Post('numbers/unassign')
  @HttpCode(HttpStatus.OK)
  async unassign(@OrgId() orgId: string, @Body() body: any) {
    const phone = body?.phone_number;
    if (!phone) throw new AppError('VALIDATION_ERROR', 'phone_number is required');
    const r = await this.numbers.unassignNumber(orgId, phone);
    return { ...r, status: await this.creds.publicStatus(orgId) };
  }
}

/**
 * The org's integration rows, for the Integrations & Webhooks view.
 *
 * Distinct from /api/v1/integrations, which is the form-provider credential
 * store. This one is a read-only listing of whatever the org has connected.
 */
@Controller('api/integrations')
@UseGuards(SessionGuard)
@UseInterceptors(UpstreamErrorInterceptor)
export class OrgIntegrationsController {
  constructor(@Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma) {}

  @Get()
  async list(@OrgId() orgId: string) {
    const rows = await this.prisma.integrations.findMany({
      where: { organization_id: orgId },
      orderBy: { created_at: 'asc' },
    });
    return {
      integrations: rows.map((r: any) => ({
        id: r.id,
        provider: r.provider,
        type: r.integration_type,
        status: r.status,
        externalAccountId: r.external_account_id ?? null,
        metadata: r.metadata ?? {},
        connectedAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
      })),
    };
  }
}
