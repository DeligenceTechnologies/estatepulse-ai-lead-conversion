import { Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, type RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '@/auth/decorators/public.decorator';
import { CalendarSyncService } from './calendar-sync.service';

@Controller('calendar-webhooks')
export class CalendarWebhookController {
  constructor(private readonly sync: CalendarSyncService) {}

  @Public()
  @Post(':connectionId')
  @HttpCode(HttpStatus.OK)
  receive(@Param('connectionId', ParseUUIDPipe) connectionId: string, @Req() req: RawBodyRequest<Request>) {
    return this.sync.receiveWebhook(connectionId, req.headers, req.rawBody);
  }
}
