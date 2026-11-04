import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { Prisma, type Message } from '@prisma/client';
import { AuditService } from '@/audit/audit.service';
import type { AuthContext } from '@/auth/auth.types';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { EventsBus } from '@/events/events.bus';
import { FollowupService } from '@/followup/followup.service';
import { toMessageRow } from '@/history/history.service';
import { AGENT_ROLE_WHERE, fullName } from '@/lead/lead-scope';
import { LeadStateService, type Actor } from '@/lead/lead-state.service';
import { ActivityService } from '../activity.service';
import { EngineService } from '../engine.service';
import { REPLY_NEEDED_REVIEWS } from '@/sms-agent/sms-agent';
import { SmsService } from '../sms.service';
import { fillTemplate } from '../template';
import { SmsConversationService } from './sms-conversation.service';
import { agentMessageForAi } from './sms-prompt';

/** A second request for the same lead waits on its row lock; the AI is paused on Telnyx inside it. */
const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 };

export interface TakeoverState {
  leadId: string;
  takenOverById: string | null;
  takenOverAt: string | null;
}

type LockedLead = { phone: string | null; dnc_status: boolean; taken_over_by_id: string | null; taken_over_at: Date | null };

/** What is texted to the lead when an agent takes their chat over, so they know a person is answering now. */
export interface TakeoverGreeting {
  enabled: boolean;
  message: string;
}

export const DEFAULT_TAKEOVER_GREETING =
  "Hi {{firstName}}, this is {{agentFirstName}} from {{brokerage}}. I'm taking over from our assistant and will reply to you personally from here.";

/** The stored setting with its defaults: on, with the default text. */
export function takeoverGreeting(raw: unknown): TakeoverGreeting {
  const v = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Partial<TakeoverGreeting>) : {};
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : true,
    message: typeof v.message === 'string' && v.message.trim() ? v.message.trim() : DEFAULT_TAKEOVER_GREETING,
  };
}

type Agent = { firstName: string | null; lastName: string | null; email: string };

/**
 * An agent texting their own lead in place of the AI. Taking over pauses the
 * lead for good (the agent decides what comes next), stops its sequences and
 * strategy, drops any callback or text the AI promised, and stops the AI
 * answering this one lead on Telnyx (the conversation's `ai_disabled`), while
 * it goes on answering every other lead, and texts the lead the organization's
 * greeting from the agent. Handing back lets the AI answer again; outreach
 * stays stopped.
 *
 * Only the agent the lead is assigned to may do any of it, so a takeover is
 * only ever held by the lead's assignee: one held by anyone else is left from
 * before a reassignment and is released.
 */
@Injectable()
export class ChatTakeoverService {
  private readonly logger = new Logger(ChatTakeoverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly state: LeadStateService,
    private readonly audit: AuditService,
    @Inject(forwardRef(() => FollowupService)) private readonly followup: FollowupService,
    private readonly engine: EngineService,
    private readonly sms: SmsService,
    private readonly conversations: SmsConversationService,
    private readonly events: EventsBus,
    private readonly activity: ActivityService,
  ) {}

  /**
   * The AI is paused last in the transaction, so a refusal from Telnyx undoes
   * it all; the greeting goes after the commit. Taking over again changes
   * nothing and sends nothing.
   */
  async takeOver(auth: AuthContext, leadId: string): Promise<TakeoverState> {
    const { organizationId: orgId, userId } = auth;
    const result = await this.prisma.$transaction(async (tx) => {
      const lead = await this.lockMine(tx, orgId, leadId, userId);
      if (lead.taken_over_by_id === userId && lead.taken_over_at) return { at: lead.taken_over_at, changed: false as const };
      const agent = await tx.user.findFirst({
        where: { id: userId, orgId, status: 'active', roles: { some: { role: AGENT_ROLE_WHERE } } },
        select: { firstName: true, lastName: true, email: true },
      });
      if (!agent) throw new AppError('FORBIDDEN', 'Only an active agent can take over a chat.');

      const at = new Date();
      await tx.lead.update({
        where: { id: leadId },
        data: { takenOverById: userId, takenOverAt: at, automationPaused: true, callbackAt: null, textBackAt: null },
      });
      await this.followup.stopForLead(orgId, leadId, 'agent_takeover', tx);
      await this.log(tx, orgId, leadId, { type: 'user', id: userId }, 'chat_taken_over', 'The agent took over the text chat; the AI and automated outreach stopped');
      await this.setAi(orgId, lead.phone, true);
      return { at, changed: true as const, agent, lead };
    }, TX_OPTIONS);

    if (result.changed) {
      this.engine.stopStrategy(orgId, leadId, 'agent', 'An agent took over the text chat');
      this.changed(orgId, leadId);
      await this.greet(orgId, leadId, userId, result.agent, result.lead);
    }
    return { leadId, takenOverById: userId, takenOverAt: result.at.toISOString() };
  }

  async greeting(orgId: string): Promise<TakeoverGreeting & { defaultMessage: string }> {
    const row = await this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { chatTakeover: true } });
    return { ...takeoverGreeting(row?.chatTakeover), defaultMessage: DEFAULT_TAKEOVER_GREETING };
  }

  /** An empty message restores the default; the default is not stored, so a later release's wording reaches it. */
  async updateGreeting(orgId: string, patch: Partial<TakeoverGreeting>) {
    const current = await this.greeting(orgId);
    const message = patch.message === undefined ? current.message : patch.message.trim() || DEFAULT_TAKEOVER_GREETING;
    const chatTakeover = { enabled: patch.enabled ?? current.enabled, ...(message === DEFAULT_TAKEOVER_GREETING ? {} : { message }) };
    await this.prisma.organizationSetting.upsert({ where: { orgId }, create: { orgId, chatTakeover }, update: { chatTakeover } });
    return this.greeting(orgId);
  }

  /** Lets the AI answer the lead's texts again. Outreach stays stopped. Handing back again changes nothing. */
  async handBack(auth: AuthContext, leadId: string): Promise<TakeoverState> {
    const { organizationId: orgId, userId } = auth;
    const changed = await this.prisma.$transaction(async (tx) => {
      const lead = await this.lockMine(tx, orgId, leadId, userId);
      if (!lead.taken_over_by_id) return false;
      await tx.lead.update({ where: { id: leadId }, data: { takenOverById: null, takenOverAt: null } });
      await this.log(tx, orgId, leadId, { type: 'user', id: userId }, 'chat_handed_back', 'The agent handed the text chat back to the AI');
      await this.setAi(orgId, lead.phone, false);
      return true;
    }, TX_OPTIONS);

    if (changed) this.changed(orgId, leadId);
    return { leadId, takenOverById: null, takenOverAt: null };
  }

  /**
   * After a reassignment: the previous agent's takeover ends and the AI answers
   * the lead again. Logged, never thrown; the reassignment stands either way.
   */
  async releaseIfReassigned(orgId: string, leadId: string): Promise<void> {
    try {
      const released = await this.prisma.$transaction(async (tx) => {
        const [lead] = await tx.$queryRaw<(LockedLead & { assigned_to_id: string | null })[]>`
          SELECT phone, taken_over_by_id, taken_over_at, assigned_to_id FROM leads
           WHERE id = ${leadId}::uuid AND organization_id = ${orgId}::uuid
           FOR UPDATE`;
        if (!lead?.taken_over_by_id || lead.taken_over_by_id === lead.assigned_to_id) return null;
        await tx.lead.update({ where: { id: leadId }, data: { takenOverById: null, takenOverAt: null } });
        await this.log(tx, orgId, leadId, { type: 'system' }, 'chat_handed_back', 'The lead was reassigned; the AI answers its texts again', {
          agentId: lead.taken_over_by_id,
        });
        return lead;
      }, TX_OPTIONS);
      if (!released) return;
      this.changed(orgId, leadId);
      await this.conversations.pauseAi(orgId, released.phone, false);
    } catch (error) {
      this.logger.error(`lead ${leadId}: ending the takeover after a reassignment: ${(error as Error).message}`);
    }
  }

  /**
   * The agent's text to the lead, only while they hold the chat. `id` comes
   * from the browser, so a retried or double-clicked send returns the first one
   * instead of texting twice. It also goes into the AI's copy of the chat,
   * marked as the agent's, for when the chat is handed back.
   */
  async send(auth: AuthContext, leadId: string, input: { id: string; body: string }) {
    const { organizationId: orgId, userId } = auth;
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, orgId, assignedToId: userId },
      select: { phone: true, dncStatus: true, takenOverById: true, assignedTo: { select: { firstName: true, lastName: true, email: true } } },
    });
    if (!lead) throw new AppError('NOT_FOUND', 'No such lead assigned to you');
    if (lead.takenOverById !== userId) throw new AppError('CONFLICT', 'Take over the chat before texting the lead.');
    if (lead.dncStatus) throw new AppError('CONFLICT', 'This lead asked us to stop texting them.');
    if (!lead.phone) throw new AppError('CONFLICT', 'This lead has no phone number to text.');

    return this.deliver(orgId, leadId, userId, lead.assignedTo, lead.phone, input.id, input.body.trim());
  }

  /** The organization's greeting, from the agent, once the takeover is in. A failure is kept on the thread and never undoes the takeover. */
  private async greet(orgId: string, leadId: string, userId: string, agent: Agent, lead: LockedLead): Promise<void> {
    try {
      const { enabled, message } = await this.greeting(orgId);
      if (!enabled || lead.dnc_status || !lead.phone) return;
      const vars = await this.activity.leadVariables(orgId, leadId);
      const text = fillTemplate(message, { ...vars, agentName: agentName(agent), agentFirstName: agent.firstName?.trim() || agentName(agent) });
      await this.deliver(orgId, leadId, userId, agent, lead.phone, randomUUID(), text);
    } catch (error) {
      this.logger.warn(`lead ${leadId}: takeover greeting not sent: ${(error as Error).message}`);
    }
  }

  /** Stores the agent's text, sends it, and gives the AI a marked copy. The id is the idempotency key. */
  private async deliver(orgId: string, leadId: string, userId: string, agent: Agent | null, phone: string, id: string, body: string) {
    let row: Message;
    try {
      row = await this.prisma.message.create({
        data: { id, orgId, leadId, direction: 'outbound', channel: 'sms', senderType: 'user', senderUserId: userId, body, deliveryStatus: 'pending' },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
      const first = await this.prisma.message.findFirst({ where: { id, orgId, leadId, senderUserId: userId } });
      if (!first) throw new AppError('CONFLICT', 'That message id is already in use.');
      return toMessageRow(first);
    }

    let providerId: string | null;
    try {
      providerId = (await this.sms.sendSms(orgId, phone, body)).id ?? null;
    } catch (error) {
      this.logger.warn(`lead ${leadId}: agent text not sent: ${(error as Error).message}`);
      row = await this.prisma.message.update({ where: { id: row.id }, data: { deliveryStatus: 'failed', failedAt: new Date() } });
      this.changed(orgId, leadId);
      return toMessageRow(row);
    }
    const sentAt = new Date();
    row = await this.prisma.message.update({ where: { id: row.id }, data: { providerMessageId: providerId, deliveryStatus: 'sent', sentAt } });
    await this.prisma.lead.update({ where: { id: leadId }, data: { lastContactAt: sentAt } });
    await this.answered(leadId).catch((error) => this.logger.warn(`lead ${leadId}: clearing its reply flags failed: ${(error as Error).message}`));
    this.conversations
      .appendToChat(orgId, phone, 'assistant', agentMessageForAi(agent ? agentName(agent) : 'Agent', body), sentAt)
      .catch((error) => this.logger.warn(`lead ${leadId}: adding the agent's text to the AI chat failed: ${(error as Error).message}`));
    this.changed(orgId, leadId);
    return toMessageRow(row);
  }

  /**
   * A person answered the lead: the flags asking for one come off (a text that
   * waited for a person, a reply the AI could not write, an unknown number),
   * and the review flag with them unless another reason keeps it.
   */
  private async answered(leadId: string): Promise<void> {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId }, select: { reviewReasons: true } });
    if (!lead) return;
    const left = lead.reviewReasons.filter((r) => !REPLY_NEEDED_REVIEWS.includes(r));
    if (left.length === lead.reviewReasons.length) return;
    await this.prisma.lead.update({ where: { id: leadId }, data: { reviewReasons: left, needsReview: left.length > 0 } });
  }

  /** The lead row, locked, when it is in the organization and assigned to this agent; any other lead is not found. */
  private async lockMine(tx: Prisma.TransactionClient, orgId: string, leadId: string, userId: string): Promise<LockedLead> {
    const [lead] = await tx.$queryRaw<LockedLead[]>`
      SELECT phone, dnc_status, taken_over_by_id, taken_over_at FROM leads
       WHERE id = ${leadId}::uuid AND organization_id = ${orgId}::uuid AND assigned_to_id = ${userId}::uuid
       FOR UPDATE`;
    if (!lead) throw new AppError('NOT_FOUND', 'No such lead assigned to you');
    return lead;
  }

  private async setAi(orgId: string, phone: string | null, paused: boolean): Promise<void> {
    try {
      await this.conversations.pauseAi(orgId, phone, paused);
    } catch (error) {
      this.logger.error(`org ${orgId}: ${paused ? 'pausing' : 'resuming'} the AI for a chat: ${(error as Error).message}`);
      throw new AppError('UPSTREAM_ERROR', `Could not ${paused ? 'stop' : 'restart'} the AI for this chat, so nothing changed. Try again.`);
    }
  }

  private async log(tx: Prisma.TransactionClient, orgId: string, leadId: string, actor: Actor, type: string, reason: string, payload?: Prisma.InputJsonObject) {
    await this.state.record({ orgId, leadId, type, source: actor.type === 'user' ? 'agent' : 'system', actor, channel: 'sms', reason, payload }, tx);
    await this.audit.record({ orgId, actorType: actor.type, actorId: actor.id ?? null, action: `lead.${type}`, entityType: 'lead', entityId: leadId, payload }, tx);
  }

  private changed(orgId: string, leadId: string): void {
    this.events.publish({ organizationId: orgId, type: 'conversation.updated', leadSourceId: null, leadId });
  }
}

const agentName = (a: Agent) => fullName(a.firstName, a.lastName, a.email);
