import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, Req, UseGuards, type RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import type { AuthContext } from '../../../auth/types';
import { CurrentUser } from '../../../common/decorators/auth.decorators';
import { OwnerGuard } from '../../../common/guards/owner.guard';
import { SessionGuard } from '../../../common/guards/session.guard';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { InCallBookingSettingsService, type InCallBookingStatusDTO } from './in-call-booking-settings.service';
import { InCallBookingService, type AvailabilityResult, type BookingResult } from './in-call-booking.service';
import { ToolAuthService, type ToolRequest } from './tool-auth.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

const toolRequest = (req: RawBodyRequest<Request>, body: any): ToolRequest => ({
  authorization: req.header('authorization'),
  signature: req.header('telnyx-signature-ed25519'),
  timestamp: req.header('telnyx-timestamp'),
  rawBody: req.rawBody,
  callControlId: body?.call_control_id,
  leadId: body?.lead_id,
});

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : undefined);

/**
 * What the office's Telnyx assistant calls during a live call. No session —
 * ToolAuthService proves the request is this office's assistant, on a live
 * call, about that call's lead. Business outcomes are always 200 with `ok`;
 * only an unauthorized request is an error.
 */
@Controller('api/tools/telnyx/booking')
export class InCallBookingToolController {
  constructor(
    private readonly auth: ToolAuthService,
    private readonly booking: InCallBookingService,
  ) {}

  @Post('availability')
  @HttpCode(HttpStatus.OK)
  async availability(@Req() req: RawBodyRequest<Request>, @Body() body: any): Promise<AvailabilityResult> {
    const ctx = await this.auth.verify(toolRequest(req, body));
    return this.booking.availability(ctx, { day: str(body?.day, 40), preferred_time: str(body?.preferred_time, 10) });
  }

  @Post('book')
  @HttpCode(HttpStatus.OK)
  async book(@Req() req: RawBodyRequest<Request>, @Body() body: any): Promise<BookingResult> {
    const ctx = await this.auth.verify(toolRequest(req, body));
    return this.booking.book(ctx, {
      start_time: str(body?.start_time, 40),
      email: str(body?.email, 254),
      name: str(body?.name, 120),
    });
  }
}

const enableSchema = z.object({ eventTypeUri: z.string().url().max(500) }).strict();

/** The owner's switch. Organization from the session, never the body. */
@Controller('api/in-call-booking')
@UseGuards(SessionGuard, OwnerGuard)
export class InCallBookingSettingsController {
  constructor(private readonly settings: InCallBookingSettingsService) {}

  @Get()
  status(@CurrentUser() auth: AuthContext): Promise<InCallBookingStatusDTO> {
    return this.settings.status(auth.organizationId);
  }

  @Put()
  enable(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(enableSchema, 'Choose an event type')) body: z.infer<typeof enableSchema>,
  ): Promise<InCallBookingStatusDTO> {
    return this.settings.enable(auth.organizationId, body.eventTypeUri);
  }

  @Post('disable')
  @HttpCode(HttpStatus.OK)
  disable(@CurrentUser() auth: AuthContext): Promise<InCallBookingStatusDTO> {
    return this.settings.disable(auth.organizationId);
  }
}
