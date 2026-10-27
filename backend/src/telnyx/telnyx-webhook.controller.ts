import { Body, Controller, HttpCode, HttpStatus, Logger, Post, Req, type RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '@/auth/decorators/public.decorator';
import { verifyTelnyxSignature } from '@/common/utils/crypto';
import { ActivityService } from './activity.service';
import { InboundSmsService } from './inbound-sms.service';
import { LeadScoringService } from './lead-scoring.service';
import { normalizePhone } from './phone';
import { TelnyxCredentialsService } from './telnyx-credentials.service';

/**
 * Call and messaging events from Telnyx. Always answered 200 at once so
 * Telnyx never retries into a pile-up; the work runs after the response.
 * An event for an account with a saved public key must carry a valid
 * signature, or it is ignored.
 */
@Public()
@Controller('webhooks/telnyx')
export class TelnyxWebhookController {
  private readonly logger = new Logger('TelnyxWebhook');

  constructor(
    private readonly activity: ActivityService,
    private readonly inbound: InboundSmsService,
    private readonly scoring: LeadScoringService,
    private readonly creds: TelnyxCredentialsService,
  ) {}

  @Post('voice')
  @HttpCode(HttpStatus.OK)
  voice(@Body() body: any, @Req() req: RawBodyRequest<Request>): { received: true } {
    const type: string | undefined = body?.data?.event_type;
    const payload = body?.data?.payload;
    const ccid: string | undefined = payload?.call_control_id;
    if (ccid && type) {
      const delivery = this.delivery(req);
      void (async () => {
        const call = await this.activity.callByProvider(ccid);
        if (!call || !(await this.signedFor(call.orgId, delivery))) return;
        if (type === 'call.answered') await this.activity.onCallAnswered(ccid);
        else if (type === 'call.transcription') await this.activity.onCallSpeech(ccid, payload);
        else if (type === 'call.hangup') await this.activity.onCallHangup(ccid, payload);
        else if (type === 'call.machine.premium.detection.ended' || type === 'call.machine.detection.ended') {
          await this.activity.onMachineDetection(ccid, payload);
        } else if (type === 'call.machine.premium.greeting.ended' || type === 'call.machine.greeting.ended') {
          await this.activity.onMachineGreetingEnded(ccid, payload);
        } else if (type === 'call.speak.ended') await this.activity.onSpeakEnded(ccid);
        else if (type === 'call.recording.saved') await this.activity.onRecordingSaved(ccid, payload);
        else if (type === 'call.recording.transcription.saved') {
          await this.activity.onTranscriptionSaved(ccid, payload);
          this.scoring.onTranscriptSaved(ccid);
        } else if (type === 'call.conversation_insights.generated') {
          await this.scoring.onInsightsGenerated(ccid, payload, delivery);
        }
      })().catch((error) => this.logger.error(`voice ${type}: ${(error as Error).message}`));
    }
    return { received: true };
  }

  @Post('messaging')
  @HttpCode(HttpStatus.OK)
  messaging(@Body() body: any, @Req() req: RawBodyRequest<Request>): { received: true } {
    const payload = body?.data?.payload;
    if (body?.data?.event_type === 'message.received' && payload) {
      const delivery = this.delivery(req);
      void (async () => {
        const orgId = await this.creds.orgForNumber(normalizePhone(payload?.to?.[0]?.phone_number ?? payload?.to?.phone_number));
        if (orgId && !(await this.signedFor(orgId, delivery))) return;
        await this.inbound.onMessageReceived(payload);
      })().catch((error) => this.logger.error(`messaging: ${(error as Error).message}`));
    }
    return { received: true };
  }

  private delivery(req: RawBodyRequest<Request>) {
    return {
      signature: req.header('telnyx-signature-ed25519'),
      timestamp: req.header('telnyx-timestamp'),
      rawBody: req.rawBody,
    };
  }

  private async signedFor(orgId: string, delivery: ReturnType<TelnyxWebhookController['delivery']>): Promise<boolean> {
    const c = await this.creds.getCreds(orgId).catch(() => null);
    if (!c?.publicKey) return true;
    const ok = verifyTelnyxSignature({ publicKey: c.publicKey, ...delivery });
    if (!ok) this.logger.warn(`Telnyx event for org ${orgId} failed signature verification — ignored`);
    return ok;
  }
}
