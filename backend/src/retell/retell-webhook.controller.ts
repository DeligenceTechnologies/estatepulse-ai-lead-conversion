import { Body, Controller, HttpCode, HttpStatus, Logger, Post, Req, UseGuards, type RawBodyRequest } from '@nestjs/common';
import { LeadStatus, Prisma, type Call } from '@prisma/client';
import type { Request } from 'express';
import { Public } from '@/auth/decorators/public.decorator';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { verifyRetellSignature } from '@/common/utils/crypto';
import { LeadStateService } from '@/lead/lead-state.service';
import { ActivityService } from '@/telnyx/activity.service';
import { EngineService } from '@/telnyx/engine.service';
import { LeadScoringService } from '@/telnyx/lead-scoring.service';
import { normalizePhone } from '@/telnyx/phone';
import { CallbackService } from '@/telnyx/tools/callback.service';
import { extractionFromRetell, inVoicemail, voicemailExtraction } from './retell-analysis';
import { retell } from './retell-api';
import { chatMetadata, RetellChatSyncService, type RetellChat } from './retell-chat-sync.service';
import { RetellCredentialsService, type RetellCreds } from './retell-credentials.service';
import { RetellEnabledGuard } from './retell-enabled.guard';
import { OPENING_VARIABLE } from './retell-sms.service';

interface RetellCall {
  call_id?: string;
  disconnection_reason?: string;
  recording_url?: string;
  transcript?: string;
  call_analysis?: unknown;
}

/** Retell ended the dial, or the call, on its own or its carrier's account: not the lead's doing. */
const FAILED_REASONS = new Set([
  'dial_failed',
  'telephony_provider_unavailable',
  'telephony_provider_permission_denied',
  'sip_routing_error',
  'network_blocked',
  'marked_as_spam',
  'concurrency_limit_reached',
  'no_concurrency_fallback',
  'no_valid_payment',
  'credit_exhausted',
  'budget_reached',
  'registered_call_timeout',
  'scam_detected',
]);

/**
 * Retell's disconnection reason in the words the activity service reads
 * (Telnyx's hangup causes), with Retell's own verdict on who answered: a call
 * its voicemail or IVR detection ended was picked up by a machine or a phone
 * menu, not by the lead.
 */
export function hangupOf(reason: string): { hangup_cause: string; sip_hangup_cause?: string; machine?: boolean } {
  if (reason === 'voicemail_reached' || reason === 'machine_detected' || reason === 'ivr_reached') return { hangup_cause: reason, machine: true };
  if (reason === 'invalid_destination') return { hangup_cause: 'not_found' };
  if (reason === 'dial_busy') return { hangup_cause: 'user_busy' };
  if (reason === 'user_declined') return { hangup_cause: 'call_rejected' };
  if (FAILED_REASONS.has(reason) || reason.startsWith('error')) return { hangup_cause: 'unspecified', sip_hangup_cause: '503' };
  return { hangup_cause: reason };
}

/** What the call's extractedIntel says about analysis that did not come: read by the UI, cleared when it does. */
interface AnalysisNote {
  status: 'unavailable';
  reason: string;
  at: string;
  rerunRequested?: boolean;
}

/**
 * Events from the organization's Retell agents. Every delivery must carry a
 * valid signature from the workspace's webhook key. A call event for a call
 * we did not place yet answers 404 so Retell retries it (it retries up to
 * three times); a retried event that already landed changes nothing. Chat
 * events (the SMS agent) carry the whole chat and are filed by the chat sync;
 * the inbound-SMS webhook is asked before Retell answers a lead's text.
 */
@Public()
@UseGuards(RetellEnabledGuard)
@Controller('webhooks/retell')
export class RetellWebhookController {
  private readonly logger = new Logger('RetellWebhook');

  constructor(
    private readonly prisma: PrismaService,
    private readonly creds: RetellCredentialsService,
    private readonly activity: ActivityService,
    private readonly scoring: LeadScoringService,
    private readonly engine: EngineService,
    private readonly callbacks: CallbackService,
    private readonly chats: RetellChatSyncService,
    private readonly state: LeadStateService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  async receive(@Body() body: any, @Req() req: RawBodyRequest<Request>): Promise<void> {
    const event: unknown = body?.event;
    if (typeof event !== 'string') return;
    if (event.startsWith('chat_')) return this.chatEvent(event, (body?.chat ?? {}) as RetellChat, req);

    const payload = (body?.call ?? {}) as RetellCall;
    if (typeof payload.call_id !== 'string') return;
    const call = await this.prisma.call.findFirst({ where: { providerCallId: payload.call_id, provider: 'retell' }, orderBy: { createdAt: 'desc' } });
    if (!call) throw new AppError('NOT_FOUND', 'Unknown call');
    const c = await this.creds.getCreds(call.orgId);
    if (!verifyRetellSignature({ key: c?.webhookKey ?? '', header: req.header('x-retell-signature'), rawBody: req.rawBody })) {
      this.logger.warn(`Retell event for org ${call.orgId} failed signature verification — ignored`);
      throw new AppError('UNAUTHENTICATED', 'Bad signature');
    }

    if (event === 'call_started') await this.started(call);
    else if (event === 'call_ended') await this.ended(call, payload);
    else if (event === 'call_analyzed') await this.analyzed(call, payload, c);
  }

  /**
   * Retell asks before its SMS agent answers a text to one of the
   * organization's numbers. The organization is the one whose Retell account
   * texts from that number, the lead the newest with the sender's number in
   * it, never anything the payload names. A lead on do-not-contact gets no
   * reply; anyone else is answered with their details, and the chat is
   * registered so its messages are filed under that lead.
   */
  @Post('sms-inbound')
  @HttpCode(HttpStatus.OK)
  async smsInbound(@Body() body: any, @Req() req: RawBodyRequest<Request>): Promise<Record<string, unknown>> {
    if (body?.event !== 'chat_inbound') return {};
    const p = body.chat_inbound ?? {};
    const chatId = typeof p.chat_id === 'string' ? p.chat_id : '';
    const from = normalizePhone(p.from_number);
    const to = normalizePhone(p.to_number);
    if (!chatId || !from || !to) return {};

    const orgId = await this.creds.orgForNumber(to);
    const c = orgId ? await this.creds.getCreds(orgId) : null;
    if (!orgId || !c?.apiKey) {
      this.logger.warn(`inbound Retell SMS to ${to}, which no organization texts from — left to Retell`);
      return {};
    }
    if (!this.signedBy(c, req)) {
      this.logger.warn(`inbound Retell SMS for org ${orgId} failed signature verification — ignored`);
      throw new AppError('UNAUTHENTICATED', 'Bad signature');
    }
    const reject = { chat_inbound: { reject: true } };
    if (!c.active) {
      this.logger.warn(`inbound Retell SMS for org ${orgId}, which does not call through Retell now — rejected`);
      return reject;
    }
    const lead = await this.prisma.lead.findFirst({ where: { orgId, normalizedPhone: from }, orderBy: { createdAt: 'desc' }, select: { id: true, dncStatus: true } });
    if (!lead) {
      this.logger.warn(`inbound Retell SMS matches no lead in org ${orgId} — left to Retell, not tracked`);
      return {};
    }
    if (lead.dncStatus) {
      this.state.quietly({ orgId, leadId: lead.id, type: 'sms_rejected', source: 'sms_reply', channel: 'sms', reason: 'The lead is on do-not-contact; the AI did not reply' });
      return reject;
    }
    await this.chats.register({ orgId, leadId: lead.id, chatId, agentId: typeof p.agent_id === 'string' ? p.agent_id : null, direction: 'inbound' });
    const variables = await this.activity.leadVariables(orgId, lead.id).catch(() => ({}) as Record<string, string>);
    return { chat_inbound: { metadata: { orgId, leadId: lead.id, source: 'inbound' }, dynamic_variables: { ...variables, [OPENING_VARIABLE]: '' } } };
  }

  /**
   * chat_started, chat_ended and chat_analyzed carry the whole chat. A chat
   * we registered is filed under its lead; one we did not (its inbound
   * webhook never reached us) is accepted only when its metadata names an
   * organization whose SMS agent it ran on and whose key signed it.
   */
  private async chatEvent(event: string, chat: RetellChat, req: RawBodyRequest<Request>): Promise<void> {
    if (typeof chat.chat_id !== 'string') return;
    let row = await this.chats.byChatId(chat.chat_id);
    let c: RetellCreds | null = null;
    if (!row) {
      const meta = chatMetadata(chat);
      c = meta ? await this.creds.getCreds(meta.orgId) : null;
      if (!meta || !c?.apiKey || !c.smsAgentId || chat.agent_id !== c.smsAgentId) {
        this.logger.warn(`Retell ${event} for chat ${chat.chat_id}, which is not one of ours — ignored`);
        return;
      }
      if (!this.signedBy(c, req)) throw new AppError('UNAUTHENTICATED', 'Bad signature');
      const lead = await this.prisma.lead.findFirst({ where: { id: meta.leadId, orgId: meta.orgId }, select: { id: true } });
      if (!lead) return;
      row = await this.chats.register({ orgId: meta.orgId, leadId: lead.id, chatId: chat.chat_id, agentId: chat.agent_id, direction: meta.source === 'inbound' ? 'inbound' : 'outbound' });
    } else {
      c = await this.creds.getCreds(row.orgId);
      if (!c || !this.signedBy(c, req)) {
        this.logger.warn(`Retell ${event} for org ${row.orgId} failed signature verification — ignored`);
        throw new AppError('UNAUTHENTICATED', 'Bad signature');
      }
    }
    await this.chats.onChatEvent(row, chat);
  }

  private signedBy(c: RetellCreds, req: RawBodyRequest<Request>): boolean {
    const header = req.header('x-retell-signature');
    return [c.webhookKey, c.apiKey].some((key) => !!key && verifyRetellSignature({ key, header, rawBody: req.rawBody }));
  }

  private async started(call: Call): Promise<void> {
    if (call.endedAt || call.status !== 'ringing') return;
    await this.activity.onCallAnswered(call.providerCallId!);
  }

  private async ended(call: Call, payload: RetellCall): Promise<void> {
    if (call.endedAt) return;
    const reason = String(payload.disconnection_reason ?? '');
    await this.activity.onCallHangup(call.providerCallId!, hangupOf(reason));
    // The call that set a callback confirms it by text; the callback call itself is checked off or retried.
    await this.callbacks.onCallEnded(call.providerCallId!).catch((error) => this.logger.error(`callback after call ${call.id}: ${(error as Error).message}`));
    if (reason === 'user_requested_dnc') {
      await this.engine
        .setStatus(call.orgId, call.leadId, LeadStatus.not_interested, 'Asked on the call not to be contacted again', { optOut: true })
        .catch((error) => this.logger.error(`DNC for lead ${call.leadId}: ${(error as Error).message}`));
    }
  }

  /**
   * Recording and transcript only when the organization records calls; the
   * qualification either way. Retell's own voicemail verdict counts a call
   * our hang-up took for a conversation as one that reached no one. A
   * connected call whose analysis came without our fields is asked for once
   * more (Retell re-runs it on what it kept); if nothing comes of that, the
   * call is marked as not scorable rather than scored on a guess.
   */
  private async analyzed(call: Call, payload: RetellCall, c: RetellCreds | null): Promise<void> {
    const settings = await this.prisma.organizationSetting.findUnique({ where: { orgId: call.orgId }, select: { callRecordingEnabled: true } });
    if (settings?.callRecordingEnabled ?? true) {
      const data = { ...(payload.recording_url ? { recordingUrl: payload.recording_url } : {}), ...(payload.transcript ? { transcript: payload.transcript } : {}) };
      if (Object.keys(data).length) await this.prisma.call.update({ where: { id: call.id }, data });
    }
    // Only a call that connected is scored; in_progress covers call_analyzed overtaking call_ended. A detected voicemail is not.
    const connected = call.status === 'completed' || call.status === 'in_progress';
    if (!connected || call.disposition === 'voicemail') return;
    if ((call.extractedIntel as { qualification?: unknown } | null)?.qualification) return;

    if (inVoicemail(payload.call_analysis)) {
      await this.scoring.onProviderAnalysis(call.id, voicemailExtraction(payload.call_analysis), 'retell_analysis');
      return;
    }
    const extraction = extractionFromRetell(payload.call_analysis);
    if (extraction) {
      await this.scoring.onProviderAnalysis(call.id, extraction, 'retell_analysis');
      return;
    }
    const intel = call.extractedIntel && typeof call.extractedIntel === 'object' && !Array.isArray(call.extractedIntel) ? (call.extractedIntel as Record<string, unknown>) : {};
    const previous = intel.analysis as AnalysisNote | undefined;
    const note: AnalysisNote = {
      status: 'unavailable',
      reason: payload.call_analysis ? 'Retell’s analysis came without the qualification fields' : 'Retell sent no call analysis',
      at: new Date().toISOString(),
      rerunRequested: previous?.rerunRequested ?? false,
    };
    if (!note.rerunRequested && c?.apiKey && call.providerCallId) {
      note.rerunRequested = true;
      await retell(c.apiKey, `/rerun-call-analysis/${encodeURIComponent(call.providerCallId)}`, { method: 'PUT' }).catch((error) => {
        note.reason += `; a re-run could not be requested: ${(error as Error).message}`;
      });
    }
    await this.prisma.call.update({ where: { id: call.id }, data: { extractedIntel: { ...intel, analysis: note } as unknown as Prisma.InputJsonObject } });
    this.logger.warn(`call ${call.id}: analysis unavailable (${note.reason})`);
  }
}
