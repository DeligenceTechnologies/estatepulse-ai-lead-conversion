import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Patch, Post, Put, UseGuards } from '@nestjs/common';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { CallCapacityDto } from '@/telnyx/dto/telnyx.dto';
import { BuyRetellNumberDto, CreateRetellAgentDto, ImportRetellNumberDto, RetellCredentialsDto, RetellPhoneNumberDto, UpdateRetellAgentDto } from './dto/retell.dto';
import { RetellAccountService } from './retell-account.service';
import { RetellCredentialsService } from './retell-credentials.service';
import { RetellEnabledGuard } from './retell-enabled.guard';

/**
 * Setting up the organization's Retell account: keys, agent, voices, numbers.
 * None of it changes which provider the organization calls through; that is
 * the switch (PUT /calling-provider). Outbound calling on Retell needs the
 * workspace's KYC done in the Retell dashboard first.
 */
@UseGuards(RetellEnabledGuard)
@Controller('retell')
export class RetellController {
  constructor(
    private readonly creds: RetellCredentialsService,
    private readonly account: RetellAccountService,
  ) {}

  @Get('status')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  status(@CurrentAuth() auth: AuthContext) {
    return this.creds.publicStatus(auth.organizationId);
  }

  @Put('credentials')
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  async connect(@CurrentAuth() auth: AuthContext, @Body() body: RetellCredentialsDto) {
    const { workspace } = await this.account.verifyKeys(body.apiKey, body.webhookKey);
    await this.creds.save(auth.organizationId, { apiKey: body.apiKey, webhookKey: body.webhookKey });
    return { ...(await this.creds.publicStatus(auth.organizationId)), workspace };
  }

  @Delete('credentials')
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  async disconnect(@CurrentAuth() auth: AuthContext) {
    await this.creds.remove(auth.organizationId);
    return this.creds.publicStatus(auth.organizationId);
  }

  @Get('voices')
  @RequirePermissions(PERMISSIONS.AUTOMATION_READ)
  async voices(@CurrentAuth() auth: AuthContext) {
    return { voices: await this.account.listVoices(auth.organizationId) };
  }

  @Get('agent')
  @RequirePermissions(PERMISSIONS.AUTOMATION_READ)
  async agent(@CurrentAuth() auth: AuthContext) {
    return { agent: await this.account.getAgent(auth.organizationId) };
  }

  @Post('agent')
  @RequirePermissions(PERMISSIONS.AUTOMATION_UPDATE)
  async createAgent(@CurrentAuth() auth: AuthContext, @Body() body: CreateRetellAgentDto) {
    return { agent: await this.account.createAgent(auth.organizationId, body) };
  }

  @Patch('agent')
  @RequirePermissions(PERMISSIONS.AUTOMATION_UPDATE)
  async updateAgent(@CurrentAuth() auth: AuthContext, @Body() body: UpdateRetellAgentDto) {
    return { agent: await this.account.updateAgent(auth.organizationId, body) };
  }

  @Get('numbers')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  async numbers(@CurrentAuth() auth: AuthContext) {
    return { numbers: await this.account.listNumbers(auth.organizationId) };
  }

  @Post('numbers/buy')
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  async buy(@CurrentAuth() auth: AuthContext, @Body() body: BuyRetellNumberDto) {
    return this.account.buyNumber(auth.organizationId, body);
  }

  @Post('numbers/import')
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  async import(@CurrentAuth() auth: AuthContext, @Body() body: ImportRetellNumberDto) {
    return this.account.importNumber(auth.organizationId, body);
  }

  @Post('numbers/assign')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  async assign(@CurrentAuth() auth: AuthContext, @Body() body: RetellPhoneNumberDto) {
    await this.account.assignNumber(auth.organizationId, body.phoneNumber);
    return this.creds.publicStatus(auth.organizationId);
  }

  @Get('concurrency')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  concurrency(@CurrentAuth() auth: AuthContext) {
    return this.account.concurrency(auth.organizationId);
  }

  @Get('call-capacity')
  @RequirePermissions(PERMISSIONS.AUTOMATION_READ)
  callCapacity(@CurrentAuth() auth: AuthContext) {
    return this.account.callCapacity(auth.organizationId);
  }

  @Put('call-capacity')
  @RequirePermissions(PERMISSIONS.AUTOMATION_UPDATE)
  setCallCapacity(@CurrentAuth() auth: AuthContext, @Body() body: CallCapacityDto) {
    return this.account.setCallCapacity(auth.organizationId, body.maxConcurrentCalls);
  }
}
