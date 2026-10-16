import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { AppError } from '@/common/errors/app-error';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { AssistantService } from './assistant.service';
import { AttachAssistantDto, CreateAssistantDto, NumbersLookupDto, PhoneNumberDto, ReconnectDto, RenameAccountDto, TelnyxCredentialsDto } from './dto/telnyx.dto';
import { NumbersService } from './numbers.service';
import { TelnyxCredentialsService, type TelnyxCreds } from './telnyx-credentials.service';

/** The organization's Telnyx accounts, phone numbers and AI assistant. */
@Controller('telnyx')
export class TelnyxController {
  constructor(
    private readonly creds: TelnyxCredentialsService,
    private readonly assistant: AssistantService,
    private readonly numbers: NumbersService,
  ) {}

  @Get('status')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  status(@CurrentAuth() auth: AuthContext) {
    return this.creds.publicStatus(auth.organizationId);
  }

  @Put('credentials')
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  async saveCredentials(@CurrentAuth() auth: AuthContext, @Body() body: TelnyxCredentialsDto) {
    const current = await this.creds.getCreds(auth.organizationId);
    await this.creds.saveCreds(auth.organizationId, await this.validated(body, current));
    return this.creds.publicStatus(auth.organizationId);
  }

  @Get('accounts')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  async listAccounts(@CurrentAuth() auth: AuthContext) {
    return { accounts: await this.creds.listAccounts(auth.organizationId) };
  }

  @Post('accounts')
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  async addAccount(@CurrentAuth() auth: AuthContext, @Body() body: TelnyxCredentialsDto) {
    if (!body.apiKey) throw new AppError('VALIDATION_ERROR', 'A Telnyx API key is required to add an account.');
    await this.creds.createAccount(auth.organizationId, await this.validated(body, null));
    return this.creds.publicStatus(auth.organizationId);
  }

  @Post('accounts/:id/activate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  async activateAccount(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.creds.activateAccount(auth.organizationId, id);
    return this.creds.publicStatus(auth.organizationId);
  }

  @Patch('accounts/:id')
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  async renameAccount(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: RenameAccountDto) {
    await this.creds.renameAccount(auth.organizationId, id, body.label);
    return { accounts: await this.creds.listAccounts(auth.organizationId) };
  }

  @Delete('accounts/:id')
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  async deleteAccount(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.creds.deleteAccount(auth.organizationId, id);
    return this.creds.publicStatus(auth.organizationId);
  }

  @Delete('credentials')
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  async clearCredentials(@CurrentAuth() auth: AuthContext) {
    await this.creds.clearCreds(auth.organizationId);
    return this.creds.publicStatus(auth.organizationId);
  }

  @Post('reconnect')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  async reconnect(@CurrentAuth() auth: AuthContext, @Body() body: ReconnectDto) {
    await this.creds.reconnect(auth.organizationId, body.accountId);
    return this.creds.publicStatus(auth.organizationId);
  }

  @Post('assistant/create')
  @RequirePermissions(PERMISSIONS.AUTOMATION_UPDATE)
  async createAssistant(@CurrentAuth() auth: AuthContext, @Body() body: CreateAssistantDto) {
    const assistant = await this.assistant.createAssistant(auth.organizationId, body);
    return { assistant, status: await this.creds.publicStatus(auth.organizationId) };
  }

  @Get('assistants')
  @RequirePermissions(PERMISSIONS.AUTOMATION_READ)
  async listAssistants(@CurrentAuth() auth: AuthContext) {
    return { assistants: await this.assistant.listAssistants(auth.organizationId) };
  }

  @Post('assistant/attach')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.AUTOMATION_UPDATE)
  async attachAssistant(@CurrentAuth() auth: AuthContext, @Body() body: AttachAssistantDto) {
    const assistant = await this.assistant.setAssistantId(auth.organizationId, body.assistantId);
    return { assistant, status: await this.creds.publicStatus(auth.organizationId) };
  }

  @Get('numbers/available')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  async available(
    @CurrentAuth() auth: AuthContext,
    @Query('country') country?: string,
    @Query('area') area?: string,
    @Query('features') features?: string,
    @Query('type') type?: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    const numbers = await this.numbers.searchAvailable(auth.organizationId, {
      country: (country || 'US').slice(0, 2),
      areaCode: area?.slice(0, 10) || undefined,
      features: features ? features.split(',').slice(0, 5) : undefined,
      type: type?.slice(0, 20) || 'local',
      limit: Math.min(Math.max(limit ?? 10, 1), 50),
    });
    return { numbers };
  }

  @Get('numbers/owned')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  async owned(@CurrentAuth() auth: AuthContext) {
    return { numbers: await this.numbers.listOwned(auth.organizationId) };
  }

  /**
   * Verify a key and list the numbers it owns, so the From Number can be picked
   * rather than typed. With no key in the body the stored one is used.
   */
  @Post('numbers/lookup')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  async lookup(@CurrentAuth() auth: AuthContext, @Body() body: NumbersLookupDto) {
    const apiKey = body.apiKey?.trim();
    if (!apiKey) return { numbers: await this.numbers.listOwned(auth.organizationId) };
    return { numbers: await this.numbers.listOwnedForKey(apiKey) };
  }

  @Post('numbers/buy')
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  async buy(@CurrentAuth() auth: AuthContext, @Body() body: PhoneNumberDto) {
    return { order: await this.numbers.buyNumber(auth.organizationId, body.phone_number) };
  }

  @Post('numbers/assign')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  async assign(@CurrentAuth() auth: AuthContext, @Body() body: PhoneNumberDto) {
    const result = await this.numbers.assignNumber(auth.organizationId, body.phone_number);
    return { ...result, status: await this.creds.publicStatus(auth.organizationId) };
  }

  @Post('numbers/unassign')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  async unassign(@CurrentAuth() auth: AuthContext, @Body() body: PhoneNumberDto) {
    const result = await this.numbers.unassignNumber(auth.organizationId, body.phone_number);
    return { ...result, status: await this.creds.publicStatus(auth.organizationId) };
  }

  /** Checks what calls need before saving: a key, an E.164 from-number and a Call Control application. */
  private async validated(body: TelnyxCredentialsDto, current: TelnyxCreds | null): Promise<Partial<TelnyxCreds>> {
    const apiKey = body.apiKey || current?.apiKey || '';
    if (!apiKey) throw new AppError('VALIDATION_ERROR', 'A Telnyx API key is required.');
    const fromNumber = body.fromNumber !== undefined ? body.fromNumber : current?.fromNumber || '';
    if (!/^\+?[0-9]{7,15}$/.test(fromNumber.replace(/[\s()-]/g, ''))) {
      throw new AppError('VALIDATION_ERROR', 'A From Number in E.164 format (e.g. +12025550123) is required to place calls.');
    }
    const connectionId = body.connectionId || (await this.creds.findCallControlApp(apiKey));
    if (!connectionId) {
      throw new AppError(
        'VALIDATION_ERROR',
        'No Call Control Application found on your Telnyx account. Create one in Telnyx → Voice → Call Control → Applications (with a webhook URL), then connect again.',
      );
    }
    return {
      connectionId,
      fromNumber,
      messagingProfileId: body.messagingProfileId || (await this.creds.findMessagingProfile(apiKey, fromNumber)),
      ...(body.apiKey ? { apiKey: body.apiKey } : {}),
      ...(body.publicKey !== undefined ? { publicKey: body.publicKey } : {}),
      ...(body.label !== undefined ? { label: body.label } : {}),
    };
  }
}
