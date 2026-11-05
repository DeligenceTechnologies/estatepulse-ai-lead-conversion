import { Body, Controller, HttpCode, HttpStatus, Logger, Post, Req, type RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '@/auth/decorators/public.decorator';
import { PrismaService } from '@/common/prisma/prisma.service';
import { verifyTelnyxSignature } from '@/common/utils/crypto';
import { ActivityService } from './activity.service';
import { callIntent } from './calls/call.types';
import { InboundSmsService } from './inbound-sms.service';
import { LeadScoringService } from './lead-scoring.service';
import { normalizePhone } from './phone';
import { TelnyxCredentialsService } from './telnyx-credentials.service';
import { CallbackService } from './tools/callback.service';

/**
 * Call and messaging events from Telnyx. Always answered 200 at once so
 * Telnyx never retries into a pile-up; the work runs after the response.
 * Every event must carry a valid Telnyx signature for the account's saved
 * public key, or it is ignored.
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
    private readonly prisma: PrismaService,
    private readonly callbacks: CallbackService,
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
        if (!call || !(await this.signedFor(call.orgId, delivery, true))) return;
        const intent = callIntent(payload?.client_state);
        if (type === 'call.answered') await this.activity.onCallAnswered(ccid, intent);
        else if (type === 'call.machine.premium.detection.ended') await this.activity.onMachineDetection(ccid, payload?.result, intent);
        else if (type === 'call.machine.premium.greeting.ended') await this.activity.onGreetingEnded(ccid, intent);
        else if (type === 'call.speak.ended') await this.activity.onSpeakEnded(ccid, payload?.status);
        else if (type === 'call.conversation.created') await this.activity.onConversationStarted(ccid);
        else if (type === 'call.hangup') {
          await this.activity.onCallHangup(ccid, payload);
          await this.callbacks.onCallEnded(ccid);
        }
        else if (type === 'call.recording.saved') await this.activity.onRecordingSaved(ccid, payload);
        else if (type === 'call.recording.transcription.saved') {
          await this.activity.onTranscriptionSaved(ccid, payload);
          this.scoring.onTranscriptSaved(ccid);
        } else if (type === 'call.conversation.ended') {
          this.scoring.onConversationEnded(ccid, payload);
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
    const type: string | undefined = body?.data?.event_type;
    const payload = body?.data?.payload;
    if (payload && (type === 'message.received' || type === 'message.finalized')) {
      const delivery = this.delivery(req);
      void (async () => {
        // A received text is addressed to our number; a finalized one was sent from it.
        const ours = type === 'message.received' ? (payload?.to?.[0]?.phone_number ?? payload?.to?.phone_number) : payload?.from?.phone_number;
        const orgId = await this.creds.orgForNumber(normalizePhone(ours));
        // A receipt for a text we sent can be placed without a signature. An inbound text never
        // can: it is the lead speaking, and a forged one would set DNC, pause the outreach or
        // put words in front of the AI classifier.
        const receipt = type === 'message.finalized' ? () => this.weSent(payload?.id) : false;
        if (!orgId || !(await this.signedFor(orgId, delivery, receipt))) return;
        if (type === 'message.received') await this.inbound.onMessageReceived(payload);
        else await this.inbound.onMessageFinalized(orgId, payload);
      })().catch((error) => this.logger.error(`messaging ${type}: ${(error as Error).message}`));
    }
    return { received: true };
  }

  /**
   * Telnyx asks for a conversation's variables when it starts (a call, or a
   * text chat): the lead's details. Answered within the assistant's timeout;
   * an unknown lead gets none, and the assistant goes on without them. A text
   * chat an agent has taken over is also marked AI-paused, which covers a
   * conversation Telnyx starts after the takeover (the lead's first text, or
   * one after the inactivity limit). Only the chat context the channel's own
   * prompt reads is sent, so a text chat is never handed the raw chat log.
   */
  @Post('assistant-variables')
  @HttpCode(HttpStatus.OK)
  async assistantVariables(
    @Body() body: any,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<{ dynamic_variables?: Record<string, string>; conversation?: { metadata: { ai_disabled: true } } }> {
    const p = body?.data?.payload ?? {};
    try {
      let orgId: string | null = null;
      let leadId: string | null = null;
      let takenOver = false;
      let fromOurCall = false;
      const ccid = typeof p.call_control_id === 'string' ? p.call_control_id : '';
      if (ccid) {
        const call = await this.activity.callByProvider(ccid);
        if (call) {
          ({ orgId, leadId } = call);
          fromOurCall = true;
        }
      }
      if (!leadId) {
        orgId = await this.creds.orgForNumber(normalizePhone(p.telnyx_agent_target));
        const lead = orgId
          ? await this.prisma.lead.findFirst({
              where: { orgId, normalizedPhone: normalizePhone(p.telnyx_end_user_target) },
              orderBy: { createdAt: 'desc' },
              select: { id: true, takenOverById: true },
            })
          : null;
        leadId = lead?.id ?? null;
        // Never on a call: a paused phone_call conversation would leave the lead in silence.
        takenOver = Boolean(lead?.takenOverById) && p.telnyx_conversation_channel === 'sms_chat';
      }
      const channel = String(p.telnyx_conversation_channel ?? 'unknown');
      if (!orgId || !leadId) {
        this.logger.warn(`assistant variables (${channel}): no lead for ${JSON.stringify({ keys: Object.keys(body?.data ?? body ?? {}), to: p.telnyx_end_user_target, from: p.telnyx_agent_target })}`);
        return {};
      }
      if (!(await this.signedFor(orgId, this.delivery(req), fromOurCall))) return {};
      this.logger.log(`assistant variables (${channel}) for lead ${leadId}`);
      const variables = await this.activity.leadVariables(orgId, leadId);
      // On a call, the call's own context was given when the assistant started; an empty one here must not replace it.
      if (ccid) delete variables.call_context;
      // The prompt reads the chat log only on a call that follows texting, and the text being
      // replied to only in a chat; each is blanked where its own channel never reads it, so the
      // answer carries no conversation the asker could not already see.
      if (!(ccid || channel === 'phone_call')) variables.recent_sms = '';
      if (channel !== 'sms_chat') variables.last_outbound_sms = '';
      return { dynamic_variables: variables, ...(takenOver ? { conversation: { metadata: { ai_disabled: true as const } } } : {}) };
    } catch (error) {
      this.logger.error(`assistant variables (${p.telnyx_conversation_channel}): ${(error as Error).message}`);
      return {};
    }
  }

  private delivery(req: RawBodyRequest<Request>) {
    return {
      signature: req.header('telnyx-signature-ed25519'),
      timestamp: req.header('telnyx-timestamp'),
      rawBody: req.rawBody,
    };
  }

  /**
   * An event is acted on only when it carries a valid signature for the
   * account's saved public key. A key is required to connect, so this is the
   * normal path; `ours` covers an account connected before the key was asked
   * for, where an event that names something we created — a call we placed, a
   * text we sent — is still taken and everything else is dropped, so nobody
   * can post invented leads or texts at an unkeyed account.
   */
  private async signedFor(
    orgId: string,
    delivery: ReturnType<TelnyxWebhookController['delivery']>,
    ours: boolean | (() => Promise<boolean>) = false,
  ): Promise<boolean> {
    const c = await this.creds.getCreds(orgId).catch(() => null);
    if (c?.publicKey) {
      const ok = verifyTelnyxSignature({ publicKey: c.publicKey, ...delivery });
      if (!ok) this.logger.warn(`Telnyx event for org ${orgId} failed signature verification — ignored`);
      return ok;
    }
    if (typeof ours === 'function' ? await ours() : ours) return true;
    this.logger.warn(`Unsigned Telnyx event for org ${orgId} ignored — save that account's Telnyx public key`);
    return false;
  }

  /** A delivery receipt for a text we sent: the one messaging event we can place without a signature. */
  private async weSent(providerMessageId: unknown): Promise<boolean> {
    if (typeof providerMessageId !== 'string' || !providerMessageId) return false;
    const sent = await this.prisma.message.findFirst({ where: { providerMessageId, direction: 'outbound' }, select: { id: true } });
    return sent !== null;
  }
}
