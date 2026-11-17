import { Body, Controller, Get, HttpCode, HttpStatus, ParseUUIDPipe, Post, Put, Query, Req, type RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { Public } from '@/auth/decorators/public.decorator';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { AssistantToolAuth, toolRequest } from '@/telnyx/tools/assistant-tool-auth.service';
import { CallToolsService } from '@/telnyx/tools/call-tools.service';
import { CallTransferService } from './call-transfer.service';
import { UpdateLiveTransferDto } from './dto/live-transfer.dto';
import { LiveTransferSettingsService } from './live-transfer-settings.service';
import { TRANSFER_REASONS, type TransferFacts, type TransferReason } from './live-transfer';

const str = (value: unknown, max: number): string | undefined => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined);
const yes = (value: unknown): boolean | undefined => (value === true || value === 'true' ? true : value === false || value === 'false' ? false : undefined);

/** The assistant's transfer_to_agent tool, on a live call. Business outcomes are a 200 with `ok` and what to say. */
@Public()
@Controller('tools/telnyx/outcome')
export class TransferToolController {
  constructor(
    private readonly auth: AssistantToolAuth,
    private readonly tools: CallToolsService,
    private readonly transfers: CallTransferService,
  ) {}

  @Post('transfer')
  @HttpCode(HttpStatus.OK)
  async transfer(@Req() req: RawBodyRequest<Request>, @Body() body: any) {
    const caller = await this.auth.verify(toolRequest(req, body), 'transfer', (orgId) => this.tools.tokenHash(orgId));
    const reason: TransferReason = TRANSFER_REASONS.find((r) => r === body?.reason) ?? 'requested_agent';
    const facts: TransferFacts = {
      budget: str(body?.budget, 60),
      location: str(body?.location, 120),
      preApproved: yes(body?.pre_approved),
      showing: str(body?.showing, 80),
      summary: str(body?.summary, 240),
    };
    return this.transfers.start(caller, reason, JSON.parse(JSON.stringify(facts)) as TransferFacts);
  }
}

/** Live transfer settings, and the transfers made, for the settings page and reports. */
@Controller('live-transfer')
export class LiveTransferController {
  constructor(
    private readonly settings: LiveTransferSettingsService,
    private readonly transfers: CallTransferService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.AUTOMATION_READ)
  status(@CurrentAuth() auth: AuthContext) {
    return this.settings.status(auth.organizationId);
  }

  @Put()
  @RequirePermissions(PERMISSIONS.AUTOMATION_UPDATE)
  update(@CurrentAuth() auth: AuthContext, @Body() body: UpdateLiveTransferDto) {
    return this.settings.update(auth.organizationId, body);
  }

  /** The latest transfers, newest first, with every agent rung; `leadId` narrows to one lead. */
  @Get('transfers')
  @RequirePermissions(PERMISSIONS.AUTOMATION_READ)
  recent(@CurrentAuth() auth: AuthContext, @Query('leadId', new ParseUUIDPipe({ optional: true })) leadId?: string) {
    return this.transfers.recent(auth.organizationId, leadId);
  }
}
