import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, Req, type RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { Public } from '@/auth/decorators/public.decorator';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { toolRequest } from '@/telnyx/tools/assistant-tool-auth.service';
import { EnableInCallBookingDto } from './dto/in-call-booking.dto';
import { InCallBookingSettingsService } from './in-call-booking-settings.service';
import { InCallBookingService } from './in-call-booking.service';
import { ToolAuthService } from './tool-auth.service';

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
