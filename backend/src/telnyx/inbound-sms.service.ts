import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { ConsentStatus, DeliveryStatus, FollowUpReason, LeadStatus } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';
import { FollowupService } from '@/followup/followup.service';
import { LeadStateService } from '@/lead/lead-state.service';
import { EngineService } from './engine.service';
import { LeadMemoryService } from './lead-memory.service';
import { normalizePhone } from './phone';
import { SmsConversationService } from './sms/sms-conversation.service';
import { SmsIntentService, type SmsIntentResult } from './sms/sms-intent.service';
import { TelnyxCredentialsService } from './telnyx-credentials.service';

const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke', 'optout', 'opt-out']);
/** The words Telnyx itself lifts its own STOP block on; anything else, "yes" included, is an ordinary reply. */
const START_WORDS = new Set(['start', 'unstop']);
const keyword = (text: string) => text.trim().toLowerCase().replace(/[.!?,]+$/, '');

/** How many earlier texts the intent check reads with the newest one. */
const INTENT_CONTEXT = 6;

/**
 * Texts a lead sends back. STOP is honoured at once (do-not-contact, every
 * sequence stopped), START from an opted-out lead lifts it. Any other reply
 * either goes to the AI assistant, which answers it on Telnyx while this side
 * records it and checks whether it ends the conversation, or, when the org has
 * not turned that on, pauses automation so a person takes over.
 */
@Injectable()
export class InboundSmsService {
  private readonly logger = new Logger(InboundSmsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly creds: TelnyxCredentialsService,
    @Inject(forwardRef(() => FollowupService)) private readonly followup: FollowupService,
    private readonly state: LeadStateService,
    private readonly engine: EngineService,
    private readonly conversations: SmsConversationService,
    private readonly intents: SmsIntentService,
    private readonly memory: LeadMemoryService,
  ) {}

  async onMessageReceived(payload: any): Promise<void> {
    const from = normalizePhone(payload?.from?.phone_number);
    const to = normalizePhone(payload?.to?.[0]?.phone_number ?? payload?.to?.phone_number);
    const text = String(payload?.text ?? '');
    const providerId: string | null = payload?.id ?? null;
    if (!from || !to) return;

    const orgId = await this.creds.orgForNumber(to);
    if (!orgId) {
      this.logger.warn(`message.received for ${to}, which no organization owns`);
      return;
    }
    if (providerId) {
      const seen = await this.prisma.message.findFirst({ where: { providerMessageId: providerId, direction: 'inbound' }, select: { id: true } });
      if (seen) return;
    }
    const lead = await this.prisma.lead.findFirst({
      where: { orgId, normalizedPhone: from },
      orderBy: { createdAt: 'desc' },
      select: { id: true, firstResponseAt: true, dncStatus: true },
    });
    if (!lead) {
      this.logger.warn(`Inbound SMS matches no lead in org ${orgId}`);
      return;
    }

    await this.prisma.message
      .create({
        data: {
          orgId,
          leadId: lead.id,
          senderType: 'lead',
          direction: 'inbound',
          channel: 'sms',
          body: text,
          providerMessageId: providerId,
          deliveryStatus: 'delivered',
          sentAt: new Date(),
          deliveredAt: new Date(),
        },
      })
      .catch((error) => this.logger.error(`storeInbound: ${(error as Error).message}`));

    const word = keyword(text);
    if (STOP_WORDS.has(word)) return this.onOptOut(orgId, lead.id);
    if (START_WORDS.has(word) && lead.dncStatus) return this.onOptIn(orgId, lead.id);
    // Whoever answers, the AI or a person, what the lead says is remembered once the chat goes quiet.
    this.memory.onLeadText(orgId, lead.id);
    if (await this.conversations.isEnabled(orgId)) return this.onChatReply(orgId, lead.id, text, !lead.firstResponseAt);
    return this.onHumanReply(orgId, lead.id, !lead.firstResponseAt);
  }

  /**
   * A text sent from our number reached its end state. One we sent is marked
   * delivered or failed; one we did not send is the AI assistant's reply in a
   * chat, stored so the conversation shows both sides.
   */
  async onMessageFinalized(orgId: string, payload: any): Promise<void> {
    const providerId: string | null = payload?.id ?? null;
    if (!providerId) return;
    const recipient = payload?.to?.[0] ?? {};
    const state = String(recipient.status ?? '');
    const delivered = state === 'delivered';
    const failed = state === 'delivery_failed' || state === 'sending_failed';
    const outcome = {
      deliveryStatus: delivered ? DeliveryStatus.delivered : failed ? DeliveryStatus.failed : DeliveryStatus.sent,
      ...(delivered ? { deliveredAt: new Date() } : {}),
      ...(failed ? { failedAt: new Date() } : {}),
    };
    const known = await this.prisma.message.findFirst({ where: { providerMessageId: providerId, direction: 'outbound' }, select: { id: true } });
    if (known) {
      await this.prisma.message.update({ where: { id: known.id }, data: outcome });
      return;
    }
    const to = normalizePhone(recipient.phone_number);
    if (!to || !(await this.conversations.isEnabled(orgId))) return;
    const lead = await this.prisma.lead.findFirst({ where: { orgId, normalizedPhone: to }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    if (!lead) return;
    await this.prisma.message.create({
      data: {
        orgId,
        leadId: lead.id,
        senderType: 'ai',
        direction: 'outbound',
        channel: 'sms',
        body: String(payload?.text ?? ''),
        providerMessageId: providerId,
        sentAt: payload?.sent_at ? new Date(payload.sent_at) : new Date(),
        ...outcome,
      },
    });
    await this.prisma.lead.update({ where: { id: lead.id }, data: { lastContactAt: new Date() } }).catch(() => undefined);
  }

  /**
   * DNC and stopping the sequences land together: never one without the other.
   * The lead becomes not_interested, unless it is booked or closed: an opt-out
   * from texts does not cancel a meeting, so that status stays.
   */
  private async onOptOut(orgId: string, leadId: string, reason = 'Opted out by SMS'): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.lead.update({
        where: { id: leadId },
        data: { dncStatus: true, automationPaused: true, consentStatus: ConsentStatus.revoked, firstResponseAt: new Date(), lastContactAt: new Date() },
      });
      await this.state.move(leadId, LeadStatus.not_interested, { source: 'sms_reply', reason, channel: 'sms', data: { lostReason: reason } }, tx);
      await this.state.record({ orgId, leadId, type: 'opted_out', source: 'sms_reply', reason, channel: 'sms' }, tx);
      await this.followup.stopForLead(orgId, leadId, 'opted_out', tx);
    });
    this.logger.log(`lead ${leadId} opted out — DNC set, sequences stopped`);
  }

  /** Clears do-not-contact but leaves automation paused: a person decides what happens next. */
  private async onOptIn(orgId: string, leadId: string): Promise<void> {
    const reason = 'Opted back in by SMS (START)';
    await this.prisma.$transaction(async (tx) => {
      await this.state.move(
        leadId,
        LeadStatus.follow_up,
        { source: 'sms_reply', reason, channel: 'sms', alsoFrom: [LeadStatus.not_interested], onlyFrom: [LeadStatus.not_interested], data: { followUpReason: FollowUpReason.other } },
        tx,
      );
      await tx.lead.update({
        where: { id: leadId },
        data: {
          dncStatus: false,
          consentStatus: ConsentStatus.granted,
          consentAt: new Date(),
          consentSource: 'sms_start',
          firstResponseAt: new Date(),
          lastContactAt: new Date(),
        },
      });
      await this.state.record({ orgId, leadId, type: 'opted_in', source: 'sms_reply', reason, channel: 'sms' }, tx);
    });
  }

  /**
   * A reply the AI assistant answers: the lead is engaged and automation keeps
   * going (the strategy holds its call until the chat goes quiet). A reply that
   * ends the conversation in the lead's own words is recorded at once.
   */
  private async onChatReply(orgId: string, leadId: string, text: string, isFirst: boolean): Promise<void> {
    await this.prisma.lead.update({ where: { id: leadId }, data: { lastContactAt: new Date(), ...(isFirst ? { firstResponseAt: new Date() } : {}) } });
    await this.state.move(leadId, LeadStatus.engaged, { source: 'sms_reply', reason: 'Replied by SMS; the AI is answering', channel: 'sms' });

    const recent = await this.prisma.message.findMany({
      where: { orgId, leadId, channel: 'sms' },
      orderBy: { createdAt: 'desc' },
      take: INTENT_CONTEXT + 1,
      select: { direction: true, body: true },
    });
    // The newest is the reply itself, stored just before this.
    const earlier = recent.slice(1).reverse().map((m) => ({ from: m.direction === 'inbound' ? ('lead' as const) : ('us' as const), text: m.body ?? '' }));
    let result: SmsIntentResult;
    try {
      result = await this.intents.classify(orgId, earlier, text);
    } catch (error) {
      this.logger.warn(`intent of a text from lead ${leadId}: ${(error as Error).message}`);
      return;
    }
    if (result.intent === 'continue') return;

    this.state.quietly({ orgId, leadId, type: 'sms_intent', source: 'sms_reply', channel: 'sms', reason: result.reason, payload: { intent: result.intent } });
    const quoted = `"${text.trim().slice(0, 160)}"`;
    if (result.intent === 'opt_out') return this.onOptOut(orgId, leadId, `Asked by SMS to stop: ${quoted}`);
    if (result.intent === 'wrong_number') {
      await this.engine.setStatus(orgId, leadId, LeadStatus.invalid, `Wrong number, said by SMS: ${quoted}`, { source: 'sms_reply' });
      return;
    }
    await this.engine.setStatus(orgId, leadId, LeadStatus.not_interested, `Not interested, said by SMS: ${quoted}`, { source: 'sms_reply' });
  }

  private async onHumanReply(orgId: string, leadId: string, isFirst: boolean): Promise<void> {
    await this.prisma.lead.update({
      where: { id: leadId },
      data: { automationPaused: true, lastContactAt: new Date(), ...(isFirst ? { firstResponseAt: new Date() } : {}) },
    });
    await this.state.move(leadId, LeadStatus.engaged, { source: 'sms_reply', reason: 'Replied by SMS', channel: 'sms' });
    await this.followup.pauseForLead(orgId, leadId);
  }
}
