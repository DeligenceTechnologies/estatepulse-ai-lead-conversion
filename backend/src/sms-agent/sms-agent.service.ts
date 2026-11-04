import { Injectable, Logger } from '@nestjs/common';
import { DeliveryStatus, type LeadStatus } from '@prisma/client';
import { InCallBookingSettingsService } from '@/calendar/booking/in-call-booking-settings.service';
import { InCallBookingService } from '@/calendar/booking/in-call-booking.service';
import { PrismaService } from '@/common/prisma/prisma.service';
import { EventsBus } from '@/events/events.bus';
import { LeadStateService } from '@/lead/lead-state.service';
import { ActivityService } from '@/telnyx/activity.service';
import { OptedOutError, SmsService, isTransientSmsError } from '@/telnyx/sms.service';
import { SmsConversationService } from '@/telnyx/sms/sms-conversation.service';
import { TelnyxCredentialsService } from '@/telnyx/telnyx-credentials.service';
import { telnyx } from '@/telnyx/telnyx-api';
import type { AssistantToolCaller } from '@/telnyx/tools/assistant-tool-auth.service';
import { CallbackService } from '@/telnyx/tools/callback.service';
import { OutcomeService } from '@/telnyx/tools/outcome.service';
import { TextBackService } from '@/telnyx/tools/text-back.service';
import {
  ACTING_TOOLS,
  AI_REPLY_CAPPED_REVIEW,
  AI_REPLY_FAILED_REVIEW,
  STRANGER_REVIEW,
  chatHistory,
  fillVariables,
  guardReply,
  linksFrom,
  standingNote,
  toolFunctions,
  type AgentTool,
  type ChatMessage,
  type FunctionTool,
  type ToolCall,
} from './sms-agent';

/** A reply to write: queued by InboundSmsService when a lead texts and the organization's AI replies come from this server. */
export interface SmsReplyJobData {
  orgId: string;
  leadId: string;
  /** The text this reply answers (messages.id). */
  inboundId: string;
  /** When Telnyx got it. A newer text from the number means a newer job answers both. */
  receivedAt: string;
  /** The lead's status as the text found it; read from the lead when a job queued before it was added has none. */
  status?: LeadStatus;
  /** The lead was made from a number that was not a lead. */
  stranger?: boolean;
}

/** What became of a reply, for the log and the tests. */
export type ReplyOutcome = 'sent' | 'engine_off' | 'no_lead' | 'answered' | 'newer_text' | 'taken_over' | 'opted_out' | 'capped' | 'failed';

/** The assistant's instructions, model and tools are read again after this long, so an edit in AI Settings reaches the chats. */
const ASSISTANT_CACHE_MS = 60_000;
const HISTORY_TEXTS = 40;
const HISTORY_MAX_CHARS = 12_000;
/** Tool calls in one reply before the AI must answer in words. */
const TOOL_ROUNDS = 4;
const MODEL_TIMEOUT_MS = 30_000;
const MAX_REPLY_TOKENS = 600;
/** Waits before the second and third try of a send that failed for a passing reason. */
const SEND_RETRY_MS = [2_000, 5_000];
/** More AI replies than this to one number in an hour is another bot or a loop: the AI stops and a person takes over. */
export const AI_REPLIES_PER_HOUR = 30;

interface Setup {
  apiKey: string;
  fromNumber: string;
  model: string;
  instructions: string;
  tools: FunctionTool[];
  timeZone: string;
}

type ToolResult = { ok?: boolean; say?: string; [key: string]: unknown };

const str = (value: unknown, max: number) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined);
const minutes = (value: unknown): number | undefined => {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The AI's text replies, written by this server instead of the assistant
 * linked on Telnyx (SmsConversationService engine 'estatepulse'). Each reply
 * reads the assistant's own instructions, model and tools, the lead's details
 * (leadVariables) and the chat from our messages, so it says what the
 * assistant would, and runs the tools in process with the same services their
 * webhooks call: a booking, a callback, a text later or an outcome works as on
 * a call. A reply is sent only while the lead is still the AI's: an agent who
 * took the chat over or an opt-out that came in meanwhile stops it, and a
 * newer text from the lead is answered by its own job, with this one in view.
 */
@Injectable()
export class SmsAgentService {
  private readonly logger = new Logger(SmsAgentService.name);
  private readonly assistants = new Map<string, { at: number; value: Omit<Setup, 'apiKey' | 'fromNumber' | 'timeZone'> }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly creds: TelnyxCredentialsService,
    private readonly conversations: SmsConversationService,
    private readonly activity: ActivityService,
    private readonly sms: SmsService,
    private readonly state: LeadStateService,
    private readonly events: EventsBus,
    private readonly outcomes: OutcomeService,
    private readonly callbacks: CallbackService,
    private readonly textBacks: TextBackService,
    private readonly booking: InCallBookingService,
    private readonly bookingSettings: InCallBookingSettingsService,
  ) {}

  async answer(job: SmsReplyJobData): Promise<ReplyOutcome> {
    const { orgId, leadId } = job;
    if (!(await this.conversations.repliesHere(orgId))) return 'engine_off';
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, orgId },
      select: { id: true, phone: true, normalizedPhone: true, status: true, dncStatus: true, takenOverById: true, reviewReasons: true },
    });
    if (!lead?.phone || !lead.normalizedPhone) return 'no_lead';
    const phone = lead.normalizedPhone;
    if (await this.alreadyAnswered(job)) return 'answered';
    if (await this.newerText(orgId, phone, job)) return 'newer_text';
    if (lead.takenOverById) return 'taken_over';
    if (lead.dncStatus) return 'opted_out';
    if (await this.capped(job, lead.reviewReasons)) return 'capped';

    const ctx: AssistantToolCaller = { orgId, leadId, callId: null };
    const called: string[] = [];
    const acted: string[] = [];
    const results: unknown[] = [];
    const usage = { prompt_tokens: 0, completion_tokens: 0 };
    let optedOut = false;
    let setup: Setup;
    let text = '';
    try {
      setup = await this.setup(orgId);
      const note = standingNote(job.status ?? lead.status, job.stranger ?? lead.reviewReasons.includes(STRANGER_REVIEW));
      const messages = await this.prompt(orgId, leadId, phone, setup, note);
      for (let round = 0; round < TOOL_ROUNDS && !text; round += 1) {
        const message = await this.complete(setup, messages, usage);
        const calls = message.tool_calls ?? [];
        if (!calls.length) {
          text = message.content ?? '';
          break;
        }
        messages.push({ role: 'assistant', content: message.content ?? '', tool_calls: calls });
        for (const call of calls) {
          const { name, args, result } = await this.runTool(ctx, call);
          called.push(name);
          results.push(result);
          if (result.ok && ACTING_TOOLS.includes(name as AgentTool)) acted.push(name);
          if (result.ok && name === 'record_outcome' && args.outcome === 'do_not_contact') optedOut = true;
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        }
      }
    } catch (error) {
      return this.failed(job, `the AI call failed: ${(error as Error).message}`, called);
    }
    const reply = guardReply(text, linksFrom(results));
    if (!reply) return this.failed(job, 'the AI gave no reply', called);

    // Looked at once more right before sending: an agent, an opt-out or the organization's switch may have moved meanwhile.
    if (!(await this.conversations.repliesHere(orgId))) return 'engine_off';
    const fresh = await this.prisma.lead.findUnique({ where: { id: leadId }, select: { dncStatus: true, takenOverById: true } });
    if (!fresh || fresh.takenOverById) return 'taken_over';
    // The AI's own do_not_contact in this turn: its reply is the one confirmation the lead gets.
    if (fresh.dncStatus && !optedOut) return 'opted_out';
    // Something it did (a booking, a callback) must be told now, whatever the lead texted since.
    if (!acted.length && (await this.newerText(orgId, phone, job))) return 'newer_text';

    let sent: { id?: string; text: string };
    try {
      sent = await this.send(orgId, lead.phone, reply, optedOut);
    } catch (error) {
      if (error instanceof OptedOutError) return 'opted_out';
      return this.failed(job, `sending the reply failed: ${(error as Error).message}`, called);
    }
    await this.prisma.message.create({
      data: {
        orgId,
        leadId,
        senderType: 'ai',
        direction: 'outbound',
        channel: 'sms',
        body: sent.text,
        providerMessageId: sent.id ?? null,
        deliveryStatus: DeliveryStatus.sent,
        sentAt: new Date(),
      },
    });
    await this.prisma.lead.update({ where: { id: leadId }, data: { lastContactAt: new Date() } }).catch(() => undefined);
    this.events.publish({ organizationId: orgId, type: 'conversation.updated', leadSourceId: null, leadId });
    this.state.quietly({
      orgId,
      leadId,
      type: 'ai_reply',
      source: 'sms_agent',
      channel: 'sms',
      payload: { inboundId: job.inboundId, tools: called, model: setup.model, usage },
    });
    return 'sent';
  }

  /** A job run again (a restart mid-way) never sends the same answer twice. */
  private async alreadyAnswered(job: SmsReplyJobData): Promise<boolean> {
    const count = await this.prisma.leadEvent.count({ where: { leadId: job.leadId, type: 'ai_reply', payload: { path: ['inboundId'], equals: job.inboundId } } });
    return count > 0;
  }

  /** The number texted again after this text: that text's own job answers, with this one in the chat. */
  private async newerText(orgId: string, phone: string, job: SmsReplyJobData): Promise<boolean> {
    const newer = await this.prisma.message.findFirst({
      where: { orgId, channel: 'sms', direction: 'inbound', createdAt: { gt: new Date(job.receivedAt) }, lead: { orgId, normalizedPhone: phone } },
      select: { id: true },
    });
    return newer !== null;
  }

  /** Too many AI replies to the lead in the last hour: another bot, or a loop. A person takes over from here. */
  private async capped(job: SmsReplyJobData, reasons: string[]): Promise<boolean> {
    const replies = await this.prisma.leadEvent.count({
      where: { leadId: job.leadId, type: 'ai_reply', createdAt: { gte: new Date(Date.now() - 3_600_000) } },
    });
    if (replies < AI_REPLIES_PER_HOUR) return false;
    if (!reasons.includes(AI_REPLY_CAPPED_REVIEW)) {
      await this.prisma.lead.update({ where: { id: job.leadId }, data: { needsReview: true, reviewReasons: { push: AI_REPLY_CAPPED_REVIEW } } });
      this.state.quietly({ orgId: job.orgId, leadId: job.leadId, type: 'ai_reply_capped', source: 'sms_agent', channel: 'sms', reason: `${replies} AI replies in the last hour` });
      this.events.publish({ organizationId: job.orgId, type: 'conversation.updated', leadSourceId: null, leadId: job.leadId });
    }
    this.logger.warn(`lead ${job.leadId}: ${replies} AI replies in an hour; the AI stops answering`);
    return true;
  }

  /** Nobody answered the lead: a person must, so the lead is flagged and the conversation lights up. */
  private async failed(job: SmsReplyJobData, reason: string, called: string[]): Promise<ReplyOutcome> {
    this.logger.error(`lead ${job.leadId}: no AI reply to text ${job.inboundId}: ${reason}`);
    const lead = await this.prisma.lead.findUnique({ where: { id: job.leadId }, select: { reviewReasons: true } });
    const flag = Boolean(lead && !lead.reviewReasons.includes(AI_REPLY_FAILED_REVIEW));
    await this.prisma.lead
      .update({ where: { id: job.leadId }, data: { needsReview: true, ...(flag ? { reviewReasons: { push: AI_REPLY_FAILED_REVIEW } } : {}) } })
      .catch(() => undefined);
    this.state.quietly({
      orgId: job.orgId,
      leadId: job.leadId,
      type: 'ai_reply_failed',
      source: 'sms_agent',
      channel: 'sms',
      reason: reason.slice(0, 500),
      payload: { inboundId: job.inboundId, tools: called },
    });
    this.events.publish({ organizationId: job.orgId, type: 'conversation.updated', leadSourceId: null, leadId: job.leadId });
    return 'failed';
  }

  /** The organization's key and number, and its assistant's instructions, model and tools (re-read once a minute). */
  private async setup(orgId: string): Promise<Setup> {
    const [c, settings] = await Promise.all([
      this.creds.getCreds(orgId),
      this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { timezone: true } }),
    ]);
    if (!c?.apiKey || !c.assistantId || !c.fromNumber) throw new Error('Telnyx, the AI assistant or the number is not set up');
    const key = `${orgId}:${c.assistantId}`;
    const hit = this.assistants.get(key);
    let value = hit && hit.at > Date.now() - ASSISTANT_CACHE_MS ? hit.value : null;
    if (!value) {
      const raw = await telnyx<any>(c.apiKey, `/ai/assistants/${c.assistantId}`);
      const a = raw?.data ?? raw ?? {};
      if (typeof a.instructions !== 'string' || !a.model) throw new Error(`assistant ${c.assistantId} has no instructions or model`);
      value = { model: String(a.model), instructions: a.instructions, tools: toolFunctions(a.tools ?? []) };
      this.assistants.set(key, { at: Date.now(), value });
    }
    return { ...value, apiKey: c.apiKey, fromNumber: c.fromNumber, timeZone: settings?.timezone || 'UTC' };
  }

  /**
   * The assistant's instructions with the lead's details filled in, as Telnyx
   * fills them in a text chat, the time now, and the chat with the number.
   */
  private async prompt(orgId: string, leadId: string, phone: string, setup: Setup, note: string): Promise<ChatMessage[]> {
    const variables = await this.activity.leadVariables(orgId, leadId);
    const instructions = fillVariables(setup.instructions, {
      ...variables,
      telnyx_conversation_channel: 'sms_chat',
      telnyx_agent_target: setup.fromNumber,
      telnyx_end_user_target: phone,
      call_control_id: '',
    });
    const now = new Intl.DateTimeFormat('en-US', {
      timeZone: setup.timeZone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date());
    const texts = await this.prisma.message.findMany({
      where: {
        orgId,
        channel: 'sms',
        lead: { orgId, normalizedPhone: phone },
        NOT: { direction: 'outbound', deliveryStatus: DeliveryStatus.failed },
      },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_TEXTS,
      select: { direction: true, senderType: true, body: true, senderUser: { select: { firstName: true, lastName: true, email: true } } },
    });
    let history = chatHistory(texts.reverse());
    while (history.length > 1 && history.reduce((n, m) => n + m.content.length, 0) > HISTORY_MAX_CHARS) history = history.slice(1);
    const standing = note ? `\n\nAbout this lead: ${note}` : '';
    return [{ role: 'system', content: `${instructions}\n\nIt is now ${now} (${setup.timeZone}).${standing}` }, ...history];
  }

  /** One turn of the model; a passing Telnyx failure is tried once more. */
  private async complete(setup: Setup, messages: ChatMessage[], usage: { prompt_tokens: number; completion_tokens: number }) {
    const body = JSON.stringify({
      model: setup.model,
      messages,
      max_tokens: MAX_REPLY_TOKENS,
      ...(setup.tools.length ? { tools: setup.tools, tool_choice: 'auto' } : {}),
    });
    let res: any;
    try {
      res = await telnyx<any>(setup.apiKey, '/ai/chat/completions', { method: 'POST', body, signal: AbortSignal.timeout(MODEL_TIMEOUT_MS) });
    } catch (error) {
      if (!isTransientSmsError(error)) throw error;
      await wait(1_000);
      res = await telnyx<any>(setup.apiKey, '/ai/chat/completions', { method: 'POST', body, signal: AbortSignal.timeout(MODEL_TIMEOUT_MS) });
    }
    usage.prompt_tokens += Number(res?.usage?.prompt_tokens) || 0;
    usage.completion_tokens += Number(res?.usage?.completion_tokens) || 0;
    const message = res?.choices?.[0]?.message;
    if (!message) throw new Error('the model returned no message');
    return message as { content?: string | null; tool_calls?: ToolCall[] };
  }

  /**
   * Runs a tool the model asked for, with the same service its webhook calls.
   * Its result goes back to the model as the webhook's would; a tool that
   * throws tells the model to offer a person instead.
   */
  private async runTool(ctx: AssistantToolCaller, call: ToolCall): Promise<{ name: string; args: Record<string, unknown>; result: ToolResult }> {
    const name = call.function?.name ?? '';
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.function?.arguments || '{}') ?? {};
    } catch {
      return { name, args, result: { ok: false, reason: 'bad_arguments', say: 'Ask the lead again what they would like.' } };
    }
    try {
      const timing = { day: str(args.day, 40), time: str(args.time, 10), inMinutes: minutes(args.in_minutes), note: str(args.note, 200) };
      switch (name) {
        case 'record_outcome':
          return { name, args, result: await this.outcomes.record(ctx, { outcome: str(args.outcome, 40), note: str(args.note, 300) }) };
        case 'schedule_callback':
          return { name, args, result: await this.callbacks.schedule(ctx, timing) };
        case 'schedule_text':
          return { name, args, result: await this.textBacks.schedule(ctx, timing) };
        case 'check_availability':
        case 'book_appointment': {
          const config = await this.bookingSettings.activeConfig(ctx.orgId);
          if (!config) return { name, args, result: { ok: false, reason: 'booking_off', say: 'Booking is not available right now. Offer to have an agent reach out to schedule.' } };
          const booking = { ...ctx, config };
          const result =
            name === 'check_availability'
              ? await this.booking.availability(booking, { day: str(args.day, 40), preferred_time: str(args.preferred_time, 10) })
              : await this.booking.book(booking, { start_time: str(args.start_time, 40), email: str(args.email, 254), name: str(args.name, 120) });
          return { name, args, result };
        }
        default:
          return { name, args, result: { ok: false, reason: 'unknown_tool', say: 'That is not something you can do in a text chat.' } };
      }
    } catch (error) {
      this.logger.warn(`lead ${ctx.leadId}: tool ${name} failed: ${(error as Error).message}`);
      return { name, args, result: { ok: false, reason: 'error', say: 'That did not work. Offer to have someone from the team follow up.' } };
    }
  }

  /** A send that failed for a passing reason is tried twice more; the text was never written twice by the model. */
  private async send(orgId: string, phone: string, text: string, evenIfOptedOut: boolean): Promise<{ id?: string; text: string }> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.sms.sendSms(orgId, phone, text, { evenIfOptedOut });
      } catch (error) {
        if (attempt >= SEND_RETRY_MS.length || !isTransientSmsError(error)) throw error;
        await wait(SEND_RETRY_MS[attempt]);
      }
    }
  }
}
