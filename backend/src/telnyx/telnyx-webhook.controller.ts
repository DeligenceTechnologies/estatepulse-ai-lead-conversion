import { Body, Controller, HttpCode, HttpStatus, Logger, Post, Req, type RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { ActivityService } from './activity.service';
import { InboundSmsService } from './inbound-sms.service';
import { LeadScoringService } from './lead-scoring.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Telnyx Call Control webhook. Unauthenticated — Telnyx posts here — and drives
 * lead/call outcome updates:
 *   call.answered -> in_progress + lead 'contacted' + record + attach the AI
 *   call.hangup   -> completed (if answered) or no_answer
 *   call.recording.saved                 -> the audio URL
 *   call.recording.transcription.saved   -> what was said
 *   call.conversation_insights.generated -> lead score + temperature
 *
 * The two recording events arrive well after hangup — Telnyx transcribes once
 * the file is closed — so they are matched back by call_control_id rather than
 * by anything held in memory.
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

  constructor(
    private readonly activity: ActivityService,
    private readonly inbound: InboundSmsService,
    private readonly scoring: LeadScoringService,
  ) {}

  @Post('voice')
  @HttpCode(HttpStatus.OK)
  voice(@Body() body: any, @Req() req: RawBodyRequest<Request>): { received: true } {
    const data = body?.data;
    const type: string | undefined = data?.event_type;
    const payload = data?.payload;
    const ccid: string | undefined = payload?.call_control_id;

    if (ccid && type) {
      void (async () => {
        if (type === 'call.answered') await this.activity.onCallAnswered(ccid);
        else if (type === 'call.hangup') await this.activity.onCallHangup(ccid);
        else if (type === 'call.recording.saved')
          await this.activity.onRecordingSaved(ccid, payload);
        else if (type === 'call.recording.transcription.saved')
          await this.activity.onTranscriptionSaved(ccid, payload);
        else if (type === 'call.conversation_insights.generated')
          await this.scoring.onInsightsGenerated(ccid, payload, {
            signature: req.header('telnyx-signature-ed25519'),
            timestamp: req.header('telnyx-timestamp'),
            rawBody: req.rawBody,
          });
      })().catch((e) => this.logger.error(`voice: ${(e as Error).message}`));
    }

    return { received: true };
  }

  /**
   * Telnyx Messaging webhook — the inbound SMS route, which did not exist
   * before. Set it as the messaging profile's webhook URL.
   *
   * Only `message.received` is acted on. Delivery receipts
   * (`message.sent` / `message.finalized`) also arrive here and are ignored for
   * now: outbound status is written at send time in ActivityService.recordSms,
   * and reconciling the two is its own piece of work.
   */
  @Post('messaging')
  @HttpCode(HttpStatus.OK)
  messaging(@Body() body: any): { received: true } {
    const data = body?.data;
    const type: string | undefined = data?.event_type;
    const payload = data?.payload;

    if (type === 'message.received' && payload) {
      void this.inbound
        .onMessageReceived(payload)
        .catch((e) => this.logger.error(`messaging: ${(e as Error).message}`));
    }

    return { received: true };
  }
}
