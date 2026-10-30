import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, Req, UseGuards, type RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { Public } from '@/auth/decorators/public.decorator';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { RetellEnabledGuard } from '@/retell/retell-enabled.guard';
import { toolRequest } from '@/telnyx/tools/assistant-tool-auth.service';
import { EnableInCallBookingDto } from './dto/in-call-booking.dto';
import { InCallBookingSettingsService } from './in-call-booking-settings.service';
import { InCallBookingService } from './in-call-booking.service';
import { ToolAuthService, type RetellToolRequest } from './tool-auth.service';

const str = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : undefined);

/** What the organization's Telnyx assistant calls during a live call. Business outcomes are a 200 with `ok`. */
@Public()
@Controller('tools/telnyx/booking')
export class InCallBookingToolController {
  constructor(
    private readonly auth: ToolAuthService,
    private readonly booking: InCallBookingService,
  ) {}

  @Post('availability')
  @HttpCode(HttpStatus.OK)
  async availability(@Req() req: RawBodyRequest<Request>, @Body() body: any) {
    const ctx = await this.auth.verify(toolRequest(req, body));
    return this.booking.availability(ctx, { day: str(body?.day, 40), preferred_time: str(body?.preferred_time, 10) });
  }

  @Post('book')
  @HttpCode(HttpStatus.OK)
  async book(@Req() req: RawBodyRequest<Request>, @Body() body: any) {
    const ctx = await this.auth.verify(toolRequest(req, body));
    return this.booking.book(ctx, { start_time: str(body?.start_time, 40), email: str(body?.email, 254), name: str(body?.name, 120) });
  }
}

const retellToolRequest = (req: RawBodyRequest<Request>, body: any): RetellToolRequest => ({
  authorization: req.header('authorization'),
  signature: req.header('x-retell-signature'),
  rawBody: req.rawBody,
  callId: body?.call?.call_id,
  chatId: req.query?.chat_id ?? body?.chat?.chat_id,
});

/**
 * The provider-neutral booking tool URL, the same booking logic behind it.
 * The Retell agent's custom functions call it (body `{ name, call, args }`
 * on a call; in a text chat the chat id comes in the URL); Telnyx keeps
 * /tools/telnyx/booking, which its installed tools point at.
 */
@Public()
@UseGuards(RetellEnabledGuard)
@Controller('tools/booking')
export class BookingToolController {
  constructor(
    private readonly auth: ToolAuthService,
    private readonly booking: InCallBookingService,
  ) {}

  @Post('availability')
  @HttpCode(HttpStatus.OK)
  async availability(@Req() req: RawBodyRequest<Request>, @Body() body: any) {
    const ctx = await this.auth.verifyRetell(retellToolRequest(req, body));
    const args = body?.args ?? {};
    return this.booking.availability(ctx, { day: str(args.day, 40), preferred_time: str(args.preferred_time, 10) });
  }

  @Post('book')
  @HttpCode(HttpStatus.OK)
  async book(@Req() req: RawBodyRequest<Request>, @Body() body: any) {
    const ctx = await this.auth.verifyRetell(retellToolRequest(req, body));
    const args = body?.args ?? {};
    return this.booking.book(ctx, { start_time: str(args.start_time, 40), email: str(args.email, 254), name: str(args.name, 120) });
  }
}

@Controller('in-call-booking')
export class InCallBookingSettingsController {
  constructor(private readonly settings: InCallBookingSettingsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.AUTOMATION_READ)
  status(@CurrentAuth() auth: AuthContext) {
    return this.settings.status(auth.organizationId);
  }

  @Put()
  @RequirePermissions(PERMISSIONS.AUTOMATION_UPDATE)
  enable(@CurrentAuth() auth: AuthContext, @Body() body: EnableInCallBookingDto) {
    return this.settings.enable(auth.organizationId, body.eventTypeUri);
  }

  @Post('disable')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.AUTOMATION_UPDATE)
  disable(@CurrentAuth() auth: AuthContext) {
    return this.settings.disable(auth.organizationId);
  }
}
