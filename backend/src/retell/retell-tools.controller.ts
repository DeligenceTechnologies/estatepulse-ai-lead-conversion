import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards, type RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '@/auth/decorators/public.decorator';
import { CallbackService } from '@/telnyx/tools/callback.service';
import { OutcomeService } from '@/telnyx/tools/outcome.service';
import { RetellEnabledGuard } from './retell-enabled.guard';
import { RetellToolAuthService, retellToolArgs, retellToolRequest } from './retell-tool-auth.service';
import { RetellToolsService } from './retell-tools.service';

const str = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : undefined);
/** A whole number of minutes, as a number or a numeric string; anything else is no delay. */
const minutes = (value: unknown): number | undefined => {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
};

/**
 * The provider-neutral call-outcome tool URL, the same callback and outcome
 * logic behind it as /tools/telnyx/outcome. The organization's Retell agents
 * call it as custom functions: on a call Retell names the call in the body;
 * in a text chat the chat id comes in the URL. Business outcomes are a 200
 * with `ok`, which Retell reads back to the agent.
 */
@Public()
@UseGuards(RetellEnabledGuard)
@Controller('tools/outcome')
export class RetellOutcomeToolController {
  constructor(
    private readonly auth: RetellToolAuthService,
    private readonly tools: RetellToolsService,
    private readonly callbacks: CallbackService,
    private readonly outcomes: OutcomeService,
  ) {}

  @Post('callback')
  @HttpCode(HttpStatus.OK)
  async callback(@Req() req: RawBodyRequest<Request>, @Body() body: any) {
    const caller = await this.verify(req, body);
    const args = retellToolArgs(body);
    return this.callbacks.schedule(caller, { day: str(args.day, 40), time: str(args.time, 10), inMinutes: minutes(args.in_minutes), note: str(args.note, 200) });
  }

  @Post('record')
  @HttpCode(HttpStatus.OK)
  async record(@Req() req: RawBodyRequest<Request>, @Body() body: any) {
    const caller = await this.verify(req, body);
    const args = retellToolArgs(body);
    return this.outcomes.record(caller, { outcome: str(args.outcome, 40), note: str(args.note, 300) });
  }

  private verify(req: RawBodyRequest<Request>, body: any) {
    return this.auth.verify(retellToolRequest(req, body), 'call outcome', (orgId) => this.tools.tokenHash(orgId));
  }
}
