import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
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
import {
  CredStoreService,
  type Creds,
  type TelnyxAccount,
  type TelnyxPublicStatus,
} from './cred-store.service';
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

  /**
   * Validate a set of credentials and fill in what the account can tell us.
   *
   * Shared by "edit the account in use" and "add another account" so the two
   * cannot drift: a missing From Number or a Telnyx account with no Call
   * Control Application both produce a connect that looks successful and an
   * outbound call that never happens. The Call Control app and the messaging
   * profile are detected from the key, so the user is not asked for ids they
   * would have to go and find.
   */
  private async validated(
    body: any,
    current: Creds | null,
  ): Promise<{ patch: Partial<Creds>; apiKey: string }> {
    const { apiKey, publicKey, connectionId, messagingProfileId, fromNumber, label } = body ?? {};
    if (apiKey !== undefined && (typeof apiKey !== 'string' || !/^KEY/.test(apiKey))) {
      throw new AppError('VALIDATION_ERROR', 'A valid Telnyx API key (starts with "KEY") is required.');
    }

    const effectiveApiKey = (apiKey as string) || current?.apiKey || '';
    if (!effectiveApiKey) {
      throw new AppError('VALIDATION_ERROR', 'A Telnyx API key is required.');
    }

    // Required: a From Number to place calls from.
    const effectiveFrom = fromNumber !== undefined ? String(fromNumber) : current?.fromNumber || '';
    if (!/^\+?[0-9]{7,15}$/.test(effectiveFrom.replace(/[\s()-]/g, ''))) {
      throw new AppError(
        'VALIDATION_ERROR',
        'A From Number in E.164 format (e.g. +12025550123) is required to place calls.',
      );
    }

    // Required: the Call Control Application outbound calls dial through.
    const ccApp =
      (typeof connectionId === 'string' && connectionId) ||
      (await this.creds.findCallControlApp(effectiveApiKey));
    if (!ccApp) {
      throw new AppError(
        'VALIDATION_ERROR',
        'No Call Control Application found on your Telnyx account. Create one in ' +
          'Telnyx \u2192 Voice \u2192 Call Control \u2192 Applications (with a webhook URL), then connect again.',
      );
    }

    // Not required: an org can be voice-only, so a missing messaging profile is
    // recorded rather than refused.
    const msgProfile =
      (typeof messagingProfileId === 'string' && messagingProfileId) ||
      (await this.creds.findMessagingProfile(effectiveApiKey, effectiveFrom));

    const patch: Partial<Creds> = {
      connectionId: ccApp,
      fromNumber: effectiveFrom,
      messagingProfileId: msgProfile,
    };
    if (apiKey) patch.apiKey = apiKey;
    if (publicKey !== undefined) patch.publicKey = publicKey;
    if (typeof label === 'string') patch.label = label.trim();

    return { patch, apiKey: effectiveApiKey };
  }

  /** Connect, or update the account currently in use. */
  @Put('credentials')
  async saveCredentials(@OrgId() orgId: string, @Body() body: any): Promise<TelnyxPublicStatus> {
    const current = await this.creds.getCreds(orgId); // null when connecting fresh
    const { patch } = await this.validated(body, current);
    await this.creds.saveCreds(orgId, patch);
    return this.creds.publicStatus(orgId);
  }

  // ---- Multiple accounts -------------------------------------------------
  //
  // An org can keep several Telnyx accounts on file and switch between them,
  // but only one is ever active, and the active one is what places every call.
  // These routes manage the shelf; everything else in the app reads whichever
  // account is active and never learns the others exist.

  @Get('accounts')
  async listAccounts(@OrgId() orgId: string): Promise<{ accounts: TelnyxAccount[] }> {
    return { accounts: await this.creds.listAccounts(orgId) };
  }

  /**
   * Add another account and switch to it. A fresh API key is mandatory here —
   * unlike PUT /credentials there is no existing account to inherit one from,
   * and falling back would silently clone the account already on file.
   */
  @Post('accounts')
  @HttpCode(HttpStatus.CREATED)
  async addAccount(@OrgId() orgId: string, @Body() body: any): Promise<TelnyxPublicStatus> {
    if (!body?.apiKey) {
      throw new AppError('VALIDATION_ERROR', 'A Telnyx API key is required to add an account.');
    }
    const { patch } = await this.validated(body, null);
    await this.creds.createAccount(orgId, patch);
    return this.creds.publicStatus(orgId);
  }

  @Post('accounts/:id/activate')
  @HttpCode(HttpStatus.OK)
  async activateAccount(
    @OrgId() orgId: string,
    @Param('id') id: string,
  ): Promise<TelnyxPublicStatus> {
    await this.creds.activateAccount(orgId, id);
    return this.creds.publicStatus(orgId);
  }

  @Patch('accounts/:id')
  async renameAccount(
    @OrgId() orgId: string,
    @Param('id') id: string,
    @Body() body: any,
  ): Promise<{ accounts: TelnyxAccount[] }> {
    const label = typeof body?.label === 'string' ? body.label.trim() : '';
    if (!label) throw new AppError('VALIDATION_ERROR', 'A name is required.');
    await this.creds.renameAccount(orgId, id, label);
    return { accounts: await this.creds.listAccounts(orgId) };
  }

  @Delete('accounts/:id')
  async deleteAccount(
    @OrgId() orgId: string,
    @Param('id') id: string,
  ): Promise<TelnyxPublicStatus> {
    await this.creds.deleteAccount(orgId, id);
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
  async reconnect(@OrgId() orgId: string, @Body() body?: any): Promise<TelnyxPublicStatus> {
    await this.creds.reconnect(orgId, body?.accountId);
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
