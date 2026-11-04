import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { DeliveryStatus, LeadStatus } from '@prisma/client';
import type { Queue } from 'bullmq';
import { PrismaService } from '@/common/prisma/prisma.service';
import { EventsBus } from '@/events/events.bus';
import { FollowupService } from '@/followup/followup.service';
import { isSuppressed } from '@/lead/contact-suppression';
import { LeadStateService } from '@/lead/lead-state.service';
import { SMS_REPLY_QUEUE, SmsReplyJob } from '@/queue/queue.constants';
import { PERSON_REPLY_REVIEW, personReason } from '@/sms-agent/sms-agent';
import type { SmsReplyJobData } from '@/sms-agent/sms-agent.service';
import { EngineService } from './engine.service';
import { LeadMemoryService } from './lead-memory.service';
import { OptOutService } from './opt-out.service';
import { normalizePhone } from './phone';
import { SmsService } from './sms.service';
import { SmsConversationService } from './sms/sms-conversation.service';
import { businessDetails } from './sms/sms-compliance';
import { SmsIntentService, type SmsIntentResult } from './sms/sms-intent.service';
import { helpReply, optOutConfirmation, saidInFrench, smsKeyword, type KeywordMatch } from './sms/sms-keywords';
import { TelnyxCredentialsService } from './telnyx-credentials.service';
import { CallToolsService } from './tools/call-tools.service';
import { TextBackService } from './tools/text-back.service';

/** How many earlier texts the intent check reads with the newest one. */
const INTENT_CONTEXT = 6;
/** The intent check is tried this many times before the text is left to a person. */
const INTENT_TRIES = 2;
export const INTENT_UNCHECKED_REVIEW = 'A text could not be checked for an opt-out: read it before contacting the lead again';
/**
 * How long a reply this server writes waits after the lead's text, so two or
 * three texts sent in a row get one answer that reads them all.
 */
export const REPLY_DEBOUNCE_MS = 2_000;

/** A webhook's timestamp, or null when it is missing or unreadable. */
const providerTime = (value: unknown): Date | null => {
  const at = typeof value === 'string' && value ? new Date(value) : null;
  return at && !Number.isNaN(at.getTime()) ? at : null;
};

/**
 * Texts a lead sends back. An opt-out in any clear words is honoured at once
 * for the phone (do-not-contact on every lead with it, every sequence
 * stopped), START from an opted-out number lifts it, and HELP gets who we are.
 * Any other reply either goes to the AI assistant, which answers it on Telnyx
 * while this side records it, or, when the org has not turned that on, pauses
 * automation so a person takes over; either way the intent check looks for an
 * opt-out in other words, and when it cannot tell, automation stops until a
 * person reads it. In a chat an agent has taken over, the agent answers.
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
    private readonly textBacks: TextBackService,
    private readonly callTools: CallToolsService,
    private readonly events: EventsBus,
    private readonly memory: LeadMemoryService,
    private readonly optOuts: OptOutService,
    private readonly sms: SmsService,
    @InjectQueue(SMS_REPLY_QUEUE) private readonly replies: Queue<SmsReplyJobData>,
  ) {}

  async onMessageReceived(payload: any): Promise<void> {
    const from = normalizePhone(payload?.from?.phone_number);
    const to = normalizePhone(payload?.to?.[0]?.phone_number ?? payload?.to?.phone_number);
    const text = String(payload?.text ?? '');
    const providerId: string | null = payload?.id ?? null;
    // When Telnyx got the text. With the AI answering, this webhook comes only after the AI's reply, so
    // the time it reaches us would put the reply above the text it answers: the text is dated by this.
    const receivedAt = providerTime(payload?.received_at) ?? new Date();
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
      select: { id: true, firstResponseAt: true, dncStatus: true, takenOverById: true, status: true, reviewReasons: true },
    });
    const word = smsKeyword(text, payload?.autoresponse_type);
    if (!lead) return this.onStranger(orgId, from, to, word);

    const stored = await this.prisma.message
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
          sentAt: receivedAt,
          deliveredAt: receivedAt,
          createdAt: receivedAt,
        },
        select: { id: true },
      })
      .catch((error) => {
        this.logger.error(`storeInbound: ${(error as Error).message}`);
        return null;
      });
    this.events.publish({ organizationId: orgId, type: 'conversation.updated', leadSourceId: null, leadId: lead.id });
    await this.textBacks.onLeadTexted(orgId, lead.id).catch((error) => this.logger.warn(`text back check: ${(error as Error).message}`));

    const isFirst = !lead.firstResponseAt;
    const aiOn = await this.conversations.isEnabled(orgId);
    if (word?.kind === 'opt_out') {
      // Telnyx confirmed its own keywords, and the AI has already answered a chat it holds.
      const confirm = !word.byTelnyx && !(await this.aiAnswers(orgId, from, aiOn));
      return this.onOptOut(orgId, lead.id, from, word.byTelnyx ? 'Opted out by SMS' : `Asked by SMS to stop: ${quote(text)}`, { isFirst, confirm, french: word.french, aiOn });
    }
    if (word?.kind === 'opt_in' && (lead.dncStatus || (await isSuppressed(this.prisma, orgId, from)))) {
      return this.onOptIn(orgId, lead.id, from, isFirst, await this.aiAnswers(orgId, from, aiOn));
    }
    if (word?.kind === 'help') await this.sendHelp(orgId, lead.id, from, to, word.french);
    // Whoever answers, the AI or a person, what the lead says is remembered once the chat goes quiet.
    this.memory.onLeadText(orgId, lead.id);
    if (lead.takenOverById) return this.onAgentChat(orgId, lead.id, from, text, isFirst, receivedAt);
    if (aiOn) return this.onChatReply(orgId, lead, from, text, isFirst, receivedAt, { inboundId: stored?.id ?? null, answered: word?.kind === 'help' });
    return this.onHumanReply(orgId, lead.id, from, text, isFirst, receivedAt);
  }

  /**
   * A text from a number no lead has. An opt-out still counts: the number is
   * suppressed, so a lead created with it later starts do-not-contact.
   */
  private async onStranger(orgId: string, from: string, to: string, word: KeywordMatch | null): Promise<void> {
    if (word?.kind === 'opt_out') {
      await this.optOuts.optOut(orgId, { phone: from }, { source: 'sms_reply', reason: 'Opted out by SMS before becoming a lead', channel: 'sms' });
      if (!word.byTelnyx && !(await this.conversations.isEnabled(orgId))) {
        await this.notify(orgId, null, from, optOutConfirmation(await this.brokerage(orgId), word.french));
      }
      return;
    }
    if (word?.kind === 'opt_in') {
      await this.optOuts.optIn(orgId, from, 'Opted back in by SMS (START)');
      return;
    }
    if (word?.kind === 'help') return this.sendHelp(orgId, null, from, to, word.french);
    this.logger.warn(`Inbound SMS matches no lead in org ${orgId}`);
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
    // On this server's replies Telnyx writes none: every text from our number is one we stored when we sent it.
    if (!to || !(await this.conversations.isEnabled(orgId)) || (await this.conversations.repliesHere(orgId))) return;
    const lead = await this.prisma.lead.findFirst({
      where: { orgId, normalizedPhone: to },
      orderBy: { createdAt: 'desc' },
      select: { id: true, takenOverById: true },
    });
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
        sentAt: providerTime(payload?.sent_at) ?? new Date(),
        ...outcome,
      },
    });
    await this.prisma.lead.update({ where: { id: lead.id }, data: { lastContactAt: new Date() } }).catch(() => undefined);
    this.events.publish({ organizationId: orgId, type: 'conversation.updated', leadSourceId: null, leadId: lead.id });
    // The AI answered in a chat an agent holds: a new conversation (inactivity), or a text that beat the pause. Pause it again.
    if (lead.takenOverById) {
      this.logger.warn(`lead ${lead.id}: the AI replied in a chat an agent has taken over; pausing it again`);
      await this.conversations.pauseAi(orgId, to, true).catch((error) => this.logger.error(`re-pausing the AI for lead ${lead.id}: ${(error as Error).message}`));
    }
  }

  /**
   * Do-not-contact for every lead with the phone, in one transaction (see
   * OptOutService). Then the one confirmation text, unless Telnyx or the AI
   * sent it, and the AI stops answering this number's texts.
   */
  private async onOptOut(
    orgId: string,
    leadId: string,
    phone: string,
    reason: string,
    o: { isFirst: boolean; confirm: boolean; french: boolean; aiOn: boolean },
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.lead.update({ where: { id: leadId }, data: { lastContactAt: new Date(), ...(o.isFirst ? { firstResponseAt: new Date() } : {}) } });
      await this.optOuts.optOut(orgId, { leadId, phone }, { source: 'sms_reply', reason, channel: 'sms' }, tx);
    });
    if (o.confirm) await this.notify(orgId, leadId, phone, optOutConfirmation(await this.brokerage(orgId), o.french));
    if (o.aiOn) await this.conversations.pauseAi(orgId, phone, true).catch((error) => this.logger.warn(`lead ${leadId}: pausing the AI after an opt-out: ${(error as Error).message}`));
  }

  /** Clears do-not-contact for the phone but leaves automation paused: a person decides what happens next. */
  private async onOptIn(orgId: string, leadId: string, phone: string, isFirst: boolean, resumeAi: boolean): Promise<void> {
    await this.optOuts.optIn(orgId, phone, 'Opted back in by SMS (START)');
    await this.prisma.lead.update({ where: { id: leadId }, data: { lastContactAt: new Date(), ...(isFirst ? { firstResponseAt: new Date() } : {}) } });
    if (resumeAi) await this.conversations.pauseAi(orgId, phone, false).catch((error) => this.logger.warn(`lead ${leadId}: letting the AI answer again: ${(error as Error).message}`));
  }

  /**
   * A reply the AI assistant answers: the lead is engaged and automation keeps
   * going (the strategy holds its call until the chat goes quiet). A reply that
   * ends the conversation in the lead's own words is recorded at once.
   */
  private async onChatReply(
    orgId: string,
    lead: { id: string; status: LeadStatus; dncStatus: boolean; takenOverById: string | null; reviewReasons: string[] },
    from: string,
    text: string,
    isFirst: boolean,
    receivedAt: Date,
    reply: { inboundId: string | null; answered: boolean },
  ): Promise<void> {
    const leadId = lead.id;
    // The AI may need a callback or a text later in this chat; a no-op when its tools are already on.
    void this.callTools.ensure(orgId);
    await this.prisma.lead.update({ where: { id: leadId }, data: { lastContactAt: new Date(), ...(isFirst ? { firstResponseAt: new Date() } : {}) } });
    await this.state.move(leadId, LeadStatus.engaged, { source: 'sms_reply', reason: 'Replied by SMS; the AI is answering', channel: 'sms' });
    // This server writes the AI's replies: the AI answers this text, or a person must (judged on the lead as the text found it).
    if (await this.conversations.repliesHere(orgId)) await this.routeReply(orgId, lead, receivedAt, reply);

    const result = await this.readIntent(orgId, leadId, text, receivedAt);
    if (!result) return this.unchecked(orgId, leadId);
    if (result.intent === 'continue') return;

    this.state.quietly({ orgId, leadId, type: 'sms_intent', source: 'sms_reply', channel: 'sms', reason: result.reason, payload: { intent: result.intent } });
    const quoted = quote(text);
    // The Telnyx assistant has already answered it with the confirmation, as its prompt asks; this server's AI does not answer an opted-out lead, so the confirmation is ours.
    if (result.intent === 'opt_out') {
      const confirm = !(await this.aiAnswers(orgId, from, true));
      return this.onOptOut(orgId, leadId, from, `Asked by SMS to stop: ${quoted}`, { isFirst: false, confirm, french: saidInFrench(text), aiOn: true });
    }
    if (result.intent === 'wrong_number') {
      await this.engine.setStatus(orgId, leadId, LeadStatus.invalid, `Wrong number, said by SMS: ${quoted}`, { source: 'sms_reply' });
      return;
    }
    await this.engine.setStatus(orgId, leadId, LeadStatus.not_interested, `Not interested, said by SMS: ${quoted}`, { source: 'sms_reply' });
  }

  /**
   * A text in a chat an agent has taken over: the agent answers it, so the
   * intent check does not run and nothing moves the lead (a STOP is still
   * honoured before this). It goes into the AI's copy of the chat, which
   * Telnyx does not keep while the AI is paused, for when it is handed back.
   */
  private async onAgentChat(orgId: string, leadId: string, from: string, text: string, isFirst: boolean, receivedAt: Date): Promise<void> {
    await this.prisma.lead.update({ where: { id: leadId }, data: { lastContactAt: new Date(), ...(isFirst ? { firstResponseAt: new Date() } : {}) } });
    await this.conversations
      .appendToChat(orgId, from, 'user', text, receivedAt)
      .catch((error) => this.logger.warn(`lead ${leadId}: adding a text to the paused AI chat failed: ${(error as Error).message}`));
  }

  /**
   * A reply a person answers: automation pauses for them. An opt-out in other
   * words cannot wait until they read it, so the intent check still runs; the
   * rest of what it finds is theirs to act on.
   */
  private async onHumanReply(orgId: string, leadId: string, from: string, text: string, isFirst: boolean, receivedAt: Date): Promise<void> {
    await this.prisma.lead.update({
      where: { id: leadId },
      data: { automationPaused: true, lastContactAt: new Date(), ...(isFirst ? { firstResponseAt: new Date() } : {}) },
    });
    await this.state.move(leadId, LeadStatus.engaged, { source: 'sms_reply', reason: 'Replied by SMS', channel: 'sms' });
    await this.followup.pauseForLead(orgId, leadId);

    const result = await this.readIntent(orgId, leadId, text, receivedAt);
    if (!result) return this.unchecked(orgId, leadId);
    if (result.intent !== 'opt_out') return;
    this.state.quietly({ orgId, leadId, type: 'sms_intent', source: 'sms_reply', channel: 'sms', reason: result.reason, payload: { intent: result.intent } });
    await this.onOptOut(orgId, leadId, from, `Asked by SMS to stop: ${quote(text)}`, { isFirst: false, confirm: true, french: saidInFrench(text), aiOn: false });
  }

  /** The intent of the newest text, read with the texts before it; null when the check failed every try. */
  private async readIntent(orgId: string, leadId: string, text: string, receivedAt: Date): Promise<SmsIntentResult | null> {
    // The texts before this one; the AI's answer to it may already be stored, and is not context for it.
    const recent = await this.prisma.message.findMany({
      where: { orgId, leadId, channel: 'sms', createdAt: { lt: receivedAt } },
      orderBy: { createdAt: 'desc' },
      take: INTENT_CONTEXT,
      select: { direction: true, body: true },
    });
    const earlier = recent.reverse().map((m) => ({ from: m.direction === 'inbound' ? ('lead' as const) : ('us' as const), text: m.body ?? '' }));
    for (let attempt = 1; attempt <= INTENT_TRIES; attempt += 1) {
      try {
        return await this.intents.classify(orgId, earlier, text);
      } catch (error) {
        this.logger.warn(`intent of a text from lead ${leadId}, try ${attempt} of ${INTENT_TRIES}: ${(error as Error).message}`);
      }
    }
    return null;
  }

  /**
   * Nobody could tell whether the text asked us to stop. Never fail open on a
   * possible opt-out: automation pauses and the lead is flagged until a person
   * reads it.
   */
  private async unchecked(orgId: string, leadId: string): Promise<void> {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId }, select: { reviewReasons: true } });
    const flag = Boolean(lead && !lead.reviewReasons.includes(INTENT_UNCHECKED_REVIEW));
    await this.prisma.lead.update({
      where: { id: leadId },
      data: { automationPaused: true, needsReview: true, ...(flag ? { reviewReasons: { push: INTENT_UNCHECKED_REVIEW } } : {}) },
    });
    await this.followup.pauseForLead(orgId, leadId);
    this.state.quietly({ orgId, leadId, type: 'sms_intent_failed', source: 'sms_reply', channel: 'sms', reason: 'The opt-out check failed; automation paused until a person reads the text' });
    this.events.publish({ organizationId: orgId, type: 'conversation.updated', leadSourceId: null, leadId });
  }

  /** HELP, AIDE or INFO: who is texting, how to reach a person, how to stop. Sent even to an opted-out number. */
  private async sendHelp(orgId: string, leadId: string | null, phone: string, ourNumber: string, french: boolean): Promise<void> {
    const row = await this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { businessDetails: true } });
    await this.notify(orgId, leadId, phone, helpReply(await this.brokerage(orgId), ourNumber, french, businessDetails(row?.businessDetails)));
  }

  /** A text the texting rules require (an opt-out confirmation, a HELP answer), stored with the lead's chat when there is a lead. */
  private async notify(orgId: string, leadId: string | null, phone: string, text: string): Promise<void> {
    try {
      const sent = await this.sms.sendSms(orgId, phone, text, { evenIfOptedOut: true });
      if (!leadId) return;
      await this.prisma.message.create({
        data: { orgId, leadId, senderType: 'ai', direction: 'outbound', channel: 'sms', body: text, providerMessageId: sent.id ?? null, deliveryStatus: 'sent', sentAt: new Date() },
      });
      this.events.publish({ organizationId: orgId, type: 'conversation.updated', leadSourceId: null, leadId });
    } catch (error) {
      this.logger.warn(`notice to ${leadId ? `lead ${leadId}` : 'a number no lead has'}: ${(error as Error).message}`);
    }
  }

  /**
   * Whether the AI answers this number's texts. Its pause is per number (the
   * Telnyx conversation), while a takeover is per lead: an agent holding the
   * chat of any lead with the number keeps the AI quiet for all of them.
   */
  private async aiAnswers(orgId: string, phone: string, aiOn: boolean): Promise<boolean> {
    // This server's AI writes its replies only after these checks, and never to an opted-out lead: the confirmation is ours then.
    if (!aiOn || (await this.conversations.replyEngine(orgId)) === 'estatepulse') return false;
    return (await this.prisma.lead.count({ where: { orgId, normalizedPhone: phone, takenOverById: { not: null } } })) === 0;
  }

  /**
   * On this server's AI replies: queues the AI's answer to the text, or flags
   * the lead for a person when the AI does not answer it (opted out, booked,
   * closed, not interested, wrong number). A text already answered (HELP) gets
   * nothing more. The reply waits a moment, so texts sent in a row get one
   * answer; only the newest text's job writes it (SmsAgentService).
   */
  private async routeReply(
    orgId: string,
    lead: { id: string; status: LeadStatus; dncStatus: boolean; takenOverById: string | null; reviewReasons: string[] },
    receivedAt: Date,
    reply: { inboundId: string | null; answered: boolean },
  ): Promise<void> {
    const reason = personReason(lead);
    if (reason) return this.forPerson(orgId, lead.id, lead.reviewReasons, reason);
    if (reply.answered) return;
    if (!reply.inboundId) return this.forPerson(orgId, lead.id, lead.reviewReasons, 'the text could not be stored');
    try {
      await this.replies.add(
        SmsReplyJob.Reply,
        { orgId, leadId: lead.id, inboundId: reply.inboundId, receivedAt: receivedAt.toISOString() },
        { jobId: `reply-${reply.inboundId}`, delay: REPLY_DEBOUNCE_MS },
      );
    } catch (error) {
      this.logger.error(`lead ${lead.id}: queueing the AI reply failed: ${(error as Error).message}`);
      await this.forPerson(orgId, lead.id, lead.reviewReasons, 'the AI reply could not be queued');
    }
  }

  /** The text waits for a person: the lead is flagged once, and its conversation is already lit up for the team. */
  private async forPerson(orgId: string, leadId: string, reasons: string[], why: string): Promise<void> {
    const flag = !reasons.includes(PERSON_REPLY_REVIEW);
    await this.prisma.lead.update({ where: { id: leadId }, data: { needsReview: true, ...(flag ? { reviewReasons: { push: PERSON_REPLY_REVIEW } } : {}) } });
    this.state.quietly({ orgId, leadId, type: 'needs_person', source: 'sms_reply', channel: 'sms', reason: `No AI reply: ${why}` });
  }

  private async brokerage(orgId: string): Promise<string> {
    const org = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } });
    return org?.name?.trim() || 'our team';
  }
}

const quote = (text: string) => `"${text.trim().slice(0, 160)}"`;
