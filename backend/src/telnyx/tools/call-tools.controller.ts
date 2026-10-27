import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, Req, type RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { Public } from '@/auth/decorators/public.decorator';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { UpdateCallToolsDto } from '../dto/telnyx.dto';
import { AssistantToolAuth, toolRequest } from './assistant-tool-auth.service';
import { CallToolsService } from './call-tools.service';
import { CallbackService } from './callback.service';
import { OutcomeService } from './outcome.service';

const str = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : undefined);
/** A whole number of minutes, as a number or a numeric string; anything else is no delay. */
const minutes = (value: unknown): number | undefined => {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
};

/** What the organization's Telnyx assistant calls on a live call or in a text chat. Business outcomes are a 200 with `ok`. */
@Public()
@Controller('tools/telnyx/outcome')
export class CallOutcomeToolController {
  constructor(
    private readonly auth: AssistantToolAuth,
    private readonly tools: CallToolsService,
    private readonly callbacks: CallbackService,
    private readonly outcomes: OutcomeService,
  ) {}

  @Post('callback')
  @HttpCode(HttpStatus.OK)
  async callback(@Req() req: RawBodyRequest<Request>, @Body() body: any) {
    const caller = await this.verify(req, body);
    return this.callbacks.schedule(caller, {
      day: str(body?.day, 40),
      time: str(body?.time, 10),
      inMinutes: minutes(body?.in_minutes),
      note: str(body?.note, 200),
    });
  }

  @Post('record')
  @HttpCode(HttpStatus.OK)
  async record(@Req() req: RawBodyRequest<Request>, @Body() body: any) {
    const caller = await this.verify(req, body);
    return this.outcomes.record(caller, { outcome: str(body?.outcome, 40), note: str(body?.note, 300) });
  }

  private verify(req: RawBodyRequest<Request>, body: any) {
    return this.auth.verify(toolRequest(req, body), 'call outcome', (orgId) => this.tools.tokenHash(orgId));
  }
}

/** Whether the AI may schedule callbacks and record outcomes, and the callback confirmation text. */
@Controller('call-tools')
export class CallToolsSettingsController {
  constructor(private readonly tools: CallToolsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.AUTOMATION_READ)
  status(@CurrentAuth() auth: AuthContext) {
    return this.tools.status(auth.organizationId);
  }

  @Put()
  @RequirePermissions(PERMISSIONS.AUTOMATION_UPDATE)
  update(@CurrentAuth() auth: AuthContext, @Body() body: UpdateCallToolsDto) {
    return this.tools.update(auth.organizationId, body);
  }
}
