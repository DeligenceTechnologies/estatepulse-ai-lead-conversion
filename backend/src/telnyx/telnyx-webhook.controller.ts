import { Body, Controller, HttpCode, HttpStatus, Logger, Post } from '@nestjs/common';
import { ActivityService } from './activity.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Telnyx Call Control webhook. Unauthenticated — Telnyx posts here — and drives
 * lead/call outcome updates:
 *   call.answered -> in_progress + lead 'contacted' + attach the AI assistant
 *   call.hangup   -> completed (if answered) or no_answer
 *
 * Always answers 200 immediately and does the work after: Telnyx retries on any
 * non-2xx, so a slow database write would turn into duplicate deliveries.
 *
 * NOTE: signature verification is still a TODO — resolve the org via
 * client_state, then verify against that org's stored public key before
 * trusting the payload.
 */
@Controller('api/webhooks/telnyx')
export class TelnyxWebhookController {
  private readonly logger = new Logger('TelnyxWebhook');

  constructor(private readonly activity: ActivityService) {}

  @Post('voice')
  @HttpCode(HttpStatus.OK)
  voice(@Body() body: any): { received: true } {
    const data = body?.data;
    const type: string | undefined = data?.event_type;
    const ccid: string | undefined = data?.payload?.call_control_id;

    if (ccid && type) {
      void (async () => {
        if (type === 'call.answered') await this.activity.onCallAnswered(ccid);
        else if (type === 'call.hangup') await this.activity.onCallHangup(ccid);
      })().catch((e) => this.logger.error(`voice: ${(e as Error).message}`));
    }

    return { received: true };
  }
}
