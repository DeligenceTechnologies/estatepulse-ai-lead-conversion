import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { withBookingSection } from '@/calendar/booking/booking-prompt';
import type { SmsCapability } from '@/calling/calling-providers';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import type { IntegrationEnv } from '@/common/utils/interface';
import { ActivityService } from '@/telnyx/activity.service';
import { callToolsSettings, withCallToolsSection } from '@/telnyx/tools/call-tools';
import { POST_CALL_ANALYSIS_DATA } from './retell-analysis';
import { retell, storageFor } from './retell-api';
import { RetellCredentialsService, type RetellCreds } from './retell-credentials.service';
import { RetellToolsService } from './retell-tools.service';

/** Where Retell asks before answering an inbound text (the number's inbound SMS webhook). */
export const SMS_INBOUND_PATH = '/webhooks/retell/sms-inbound';
/** Chat events (chat_started, chat_ended, chat_analyzed) share the call webhook. */
export const WEBHOOK_PATH = '/webhooks/retell';

/**
 * The dynamic variable the SMS agent's opening message is: the exact text a
 * strategy or follow-up step wrote. Retell renders the begin message from it
 * verbatim, so a template reaches the lead as written, not as the agent's
 * own wording (Retell's create-sms-chat has no field for a first message).
 */
export const OPENING_VARIABLE = 'opening_message';
export const SMS_AGENT_NAME = 'EstatePulse SMS Agent';
/** A chat the lead leaves quiet this long ends on Retell; a later reply opens a new one. */
const END_CHAT_AFTER_SILENCE_MS = 2 * 60 * 60_000;
const NUMBER_CACHE_MS = 5 * 60_000;

export const DEFAULT_SMS_PROMPT = [
  '# Role',
  'You are a warm, professional AI assistant for a real estate brokerage, texting a home-buyer lead who recently enquired. ' +
    'Write like a person texting: one or two short sentences and at most one question per message. No greetings or sign-offs on every message, no emojis.',
  '# Goal',
  'Qualify them the same way as on a call, one question at a time: buying intent, timeline, location, budget, property type and bedrooms, financing or pre-approval. ' +
    'Acknowledge each answer briefly and never ask for something they already told you.',
  '# Context',
  'Our earlier texts with them, if any: {{recent_sms}}',
  '# Rules',
  'Never give legal advice, never guarantee mortgage approval, and offer to have a human agent follow up whenever you are unsure. ' +
    'If they are not interested, ask you to stop, or it is the wrong number, reply once politely and ask nothing more.',
].join('\n');

interface NumberInfo {
  type: string;
  terminationUri: string;
  inboundSmsAgents: string[];
  outboundSmsAgents: string[];
  inboundSmsWebhookUrl: string | null;
}

export interface RetellSmsStatus {
  capability: SmsCapability;
  smsAgentId: string;
  fromNumber: string;
  number: NumberInfo | null;
  numberError: string | null;
  /** Retell does not expose A2P 10DLC registration, so it is the owner's to confirm in the Retell dashboard. */
  registrationNote: string;
}

const TOLL_FREE = /^\+1(800|833|844|855|866|877|888)/;
export const REGISTRATION_NOTE =
  'Retell does not report whether the number’s SMS add-on (A2P 10DLC registration) is approved. Texts fail until it is: check the number’s “Advanced Add-Ons” in the Retell dashboard.';

/**
 * Texting through the organization's Retell workspace: a chat agent (on its
 * own Retell LLM) bound to the calling number for inbound and outbound SMS,
 * each of our texts opening an SMS chat whose first message is that exact
 * text. Readiness is read from the number itself: only a Retell-Twilio US
 * number with the SMS agent bound can text, and even then Retell's A2P
 * approval is not visible through its API, so readiness is "unverified"
 * rather than "ready".
 */
@Injectable()
export class RetellSmsService {
  private readonly logger = new Logger(RetellSmsService.name);
  private readonly publicUrl: string;
  private readonly numbers = new Map<string, { value: NumberInfo; until: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly creds: RetellCredentialsService,
    private readonly activity: ActivityService,
    private readonly tools: RetellToolsService,
    config: ConfigService<IntegrationEnv, true>,
  ) {
    this.publicUrl = (config.get('PUBLIC_API_URL', { infer: true }) ?? '').replace(/\/+$/, '');
  }

  get inboundWebhookUrl(): string {
    return `${this.publicUrl}${SMS_INBOUND_PATH}`;
  }

  get webhookUrl(): string {
    return `${this.publicUrl}${WEBHOOK_PATH}`;
  }

  /** Whether this organization can text through Retell right now, and why not. Cached per number for a few minutes. */
  async capability(orgId: string, c?: RetellCreds | null): Promise<SmsCapability> {
    const creds = c === undefined ? await this.creds.getCreds(orgId) : c;
    const no = (state: SmsCapability['state'], reason: string): SmsCapability => ({ available: false, state, reason, deliveryReports: false });
    if (!creds?.apiKey) return no('unavailable', 'Connect a Retell account first.');
    if (!creds.active) return no('unavailable', 'Retell is not this organization’s calling provider.');
    if (!creds.fromNumber) return no('no_number', 'Choose the Retell number calls come from before texting through Retell.');
    if (!creds.smsAgentId) return no('not_configured', 'SMS is not set up on Retell yet: set up the SMS agent in Settings → Calling → Retell.');
    let n: NumberInfo;
    try {
      n = await this.numberInfo(creds);
    } catch (error) {
      return no('unavailable', `Retell could not describe ${creds.fromNumber}: ${(error as Error).message}`);
    }
    const unsupported = this.unsupportedReason(creds.fromNumber, n);
    if (unsupported) return no('unsupported_number', unsupported);
    if (!n.inboundSmsAgents.includes(creds.smsAgentId) || !n.outboundSmsAgents.includes(creds.smsAgentId)) {
      return no('not_configured', `The SMS agent is not bound to ${creds.fromNumber} on Retell. Run “Set up SMS” again in Settings → Calling → Retell.`);
    }
    return { available: true, state: 'unverified', reason: REGISTRATION_NOTE, deliveryReports: false };
  }

  async status(orgId: string): Promise<RetellSmsStatus> {
    const c = await this.creds.getCreds(orgId);
    let number: NumberInfo | null = null;
    let numberError: string | null = null;
    if (c?.apiKey && c.fromNumber) {
      try {
        number = await this.numberInfo(c, true);
      } catch (error) {
        numberError = (error as Error).message;
      }
    }
    return { capability: await this.capability(orgId, c), smsAgentId: c?.smsAgentId ?? '', fromNumber: c?.fromNumber ?? '', number, numberError, registrationNote: REGISTRATION_NOTE };
  }

  /**
   * Sets SMS up, or finishes a setup that stopped halfway: the SMS LLM and
   * chat agent are created once and their ids kept as soon as they exist, the
   * number is bound to the agent for both directions and told where to ask
   * about inbound texts, and the outcome tools go on the new LLM. Safe to run
   * again at any time; nothing is created twice.
   */
  async setup(orgId: string): Promise<RetellSmsStatus> {
    let c = await this.creds.getCreds(orgId);
    if (!c?.apiKey) throw new AppError('CONFLICT', 'Connect a Retell account first.');
    if (!c.agentId) throw new AppError('CONFLICT', 'Create the Retell agent first.');
    if (!c.fromNumber) throw new AppError('CONFLICT', 'Choose the Retell number calls come from first.');
    if (!this.publicUrl) throw new AppError('CONFLICT', 'PUBLIC_API_URL is not configured on the server, so Retell could not reach us.');
    const n = await this.numberInfo(c, true);
    const unsupported = this.unsupportedReason(c.fromNumber, n);
    if (unsupported) throw new AppError('CONFLICT', unsupported);

    if (!c.smsLlmId) {
      const llm = await retell<{ llm_id: string }>(c.apiKey, '/create-retell-llm', {
        method: 'POST',
        body: JSON.stringify({
          general_prompt: await this.withSections(orgId, DEFAULT_SMS_PROMPT),
          begin_message: `{{${OPENING_VARIABLE}}}`,
          start_speaker: 'agent',
          general_tools: [],
          // An inbound chat we were not asked about renders no stray placeholders.
          default_dynamic_variables: { [OPENING_VARIABLE]: '', recent_sms: '', last_outbound_sms: '', firstName: 'there' },
        }),
      });
      c = await this.creds.save(orgId, { smsLlmId: llm.llm_id });
    }
    if (!c.smsAgentId) {
      const agent = await retell<{ agent_id: string }>(c.apiKey, '/create-chat-agent', {
        method: 'POST',
        body: JSON.stringify({
          agent_name: SMS_AGENT_NAME,
          response_engine: { type: 'retell-llm', llm_id: c.smsLlmId },
          webhook_url: this.webhookUrl,
          webhook_events: ['chat_started', 'chat_ended', 'chat_analyzed'],
          post_chat_analysis_data: POST_CALL_ANALYSIS_DATA,
          data_storage_setting: storageFor(await this.recordsCalls(orgId)),
          end_chat_after_silence_ms: END_CHAT_AFTER_SILENCE_MS,
        }),
      });
      c = await this.creds.save(orgId, { smsAgentId: agent.agent_id });
    } else {
      await this.refreshChatAgentUrl(c);
    }
    await this.bindNumber(c, true);
    await this.tools.provisionNow(orgId).catch((error) => this.logger.warn(`Retell SMS tools for org ${orgId}: ${(error as Error).message}`));
    this.numbers.delete(this.numberKey(c));
    this.logger.log(`Retell SMS set up for org ${orgId}: agent ${c.smsAgentId} on ${c.fromNumber}`);
    return this.status(orgId);
  }

  /** Unbinds the SMS agent from the number: no text goes out or is answered; the agent itself is kept for a later setup. */
  async disable(orgId: string): Promise<RetellSmsStatus> {
    const c = await this.creds.getCreds(orgId);
    if (!c?.apiKey || !c.fromNumber) return this.status(orgId);
    await this.bindNumber(c, false);
    this.numbers.delete(this.numberKey(c));
    return this.status(orgId);
  }

  async getAgent(orgId: string): Promise<{ agentId: string; llmId: string; prompt: string } | null> {
    const c = await this.creds.getCreds(orgId);
    if (!c?.apiKey || !c.smsAgentId || !c.smsLlmId) return null;
    const llm = await retell<{ general_prompt?: string }>(c.apiKey, `/get-retell-llm/${c.smsLlmId}`);
    return { agentId: c.smsAgentId, llmId: c.smsLlmId, prompt: llm.general_prompt ?? '' };
  }

  /** The prompt is replaced as given; the booking and outcome sections this app manages are kept on it. */
  async updateAgent(orgId: string, patch: { prompt?: string }): Promise<{ agentId: string; llmId: string; prompt: string }> {
    const c = await this.creds.getCreds(orgId);
    if (!c?.apiKey || !c.smsLlmId) throw new AppError('CONFLICT', 'Set up SMS on Retell first.');
    if (patch.prompt != null) {
      await retell(c.apiKey, `/update-retell-llm/${c.smsLlmId}`, { method: 'PATCH', body: JSON.stringify({ general_prompt: await this.withSections(orgId, patch.prompt, c.smsLlmId) }) });
    }
    return (await this.getAgent(orgId))!;
  }

  /**
   * One text: a new SMS chat on the organization's SMS agent whose opening
   * message is exactly `text`. Refused, with the reason, when the number
   * cannot text. The returned id names the chat and its opening message;
   * the chat sync replaces it with Retell's own message id once it shows.
   * Success means Retell accepted the chat, not that the carrier delivered
   * the text: Retell reports no delivery per message.
   */
  async sendSms(orgId: string, to: string, text: string, ctx: { leadId?: string } = {}): Promise<{ id?: string }> {
    const c = await this.creds.getCreds(orgId);
    const cap = await this.capability(orgId, c);
    if (!cap.available || !c) throw new AppError('CONFLICT', cap.reason ?? 'SMS is not available on Retell.');
    const leadId = ctx.leadId ?? (await this.leadIdFor(orgId, to));
    if (!leadId) throw new AppError('CONFLICT', `No lead with the number ${to} in this organization.`);
    await this.tools.ensure(orgId);
    await this.endOpenChats(c, orgId, leadId);

    const chat = await retell<{ chat_id: string; chat_status?: string; message_with_tool_calls?: { role?: string; message_id?: string }[] }>(c.apiKey, '/create-sms-chat', {
      method: 'POST',
      body: JSON.stringify({
        from_number: c.fromNumber,
        to_number: to,
        override_agent_id: c.smsAgentId,
        metadata: { orgId, leadId, source: 'outbound' },
        retell_llm_dynamic_variables: { ...(await this.activity.leadVariables(orgId, leadId)), [OPENING_VARIABLE]: text },
        honor_internal_dnc: true,
      }),
    });
    if (chat.chat_status === 'error') throw new AppError('UPSTREAM_ERROR', `Retell could not start the SMS chat ${chat.chat_id}.`);
    await this.prisma.smsChat.upsert({
      where: { provider_providerChatId: { provider: 'retell', providerChatId: chat.chat_id } },
      create: { orgId, leadId, provider: 'retell', providerChatId: chat.chat_id, agentId: c.smsAgentId, direction: 'outbound', status: chat.chat_status ?? 'ongoing', nextSyncAt: new Date(Date.now() + 30_000) },
      update: {},
    });
    const opening = chat.message_with_tool_calls?.find((m) => m.role === 'agent' && typeof m.message_id === 'string')?.message_id;
    return { id: `${chat.chat_id}:${opening ?? 'opening'}` };
  }

  /** Points the chat agent's webhook and the number's inbound-SMS webhook at this server again after an address change. */
  async refreshUrls(c: RetellCreds): Promise<void> {
    if (!this.publicUrl) return;
    if (c.smsAgentId) await this.refreshChatAgentUrl(c);
    if (c.smsAgentId && c.fromNumber) {
      const n = await this.numberInfo(c, true);
      const current = n.inboundSmsWebhookUrl ?? '';
      if (current.endsWith(SMS_INBOUND_PATH) && current !== this.inboundWebhookUrl) {
        await retell(c.apiKey, `/update-phone-number/${encodeURIComponent(c.fromNumber)}`, { method: 'PATCH', body: JSON.stringify({ inbound_sms_webhook_url: this.inboundWebhookUrl }) });
        this.numbers.delete(this.numberKey(c));
        this.logger.log(`Retell number ${c.fromNumber}: inbound SMS webhook moved to ${this.inboundWebhookUrl}`);
      }
    }
  }

  /** The SMS agent keeps what the voice agent keeps: with recording off, Retell stores no chat transcript either. */
  async setDataStorage(c: RetellCreds, record: boolean): Promise<void> {
    if (!c.smsAgentId) return;
    await retell(c.apiKey, `/update-chat-agent/${c.smsAgentId}`, { method: 'PATCH', body: JSON.stringify({ data_storage_setting: storageFor(record) }) });
  }

  /** Ends the chat on Retell (its agent stops answering) and closes our record of it. */
  async endChat(c: RetellCreds, providerChatId: string): Promise<void> {
    await retell(c.apiKey, `/end-chat/${encodeURIComponent(providerChatId)}`, { method: 'PATCH' }).catch((error) =>
      this.logger.warn(`end Retell chat ${providerChatId}: ${(error as Error).message}`),
    );
    await this.prisma.smsChat.updateMany({ where: { provider: 'retell', providerChatId, status: 'ongoing' }, data: { status: 'ended', endedAt: new Date(), nextSyncAt: null } });
  }

  private async refreshChatAgentUrl(c: RetellCreds): Promise<void> {
    const agent = await retell<{ webhook_url?: string | null }>(c.apiKey, `/get-chat-agent/${c.smsAgentId}`);
    if ((agent.webhook_url ?? '') === this.webhookUrl) return;
    await retell(c.apiKey, `/update-chat-agent/${c.smsAgentId}`, { method: 'PATCH', body: JSON.stringify({ webhook_url: this.webhookUrl, webhook_events: ['chat_started', 'chat_ended', 'chat_analyzed'] }) });
    this.logger.log(`Retell SMS agent ${c.smsAgentId}: webhook moved to ${this.webhookUrl}`);
  }

  /** One chat per lead at a time: a new text closes the chat before it, so the agent never runs two conversations with one person. */
  private async endOpenChats(c: RetellCreds, orgId: string, leadId: string): Promise<void> {
    const open = await this.prisma.smsChat.findMany({ where: { orgId, leadId, provider: 'retell', status: 'ongoing' }, select: { providerChatId: true } });
    for (const chat of open) await this.endChat(c, chat.providerChatId);
  }

  private async bindNumber(c: RetellCreds, on: boolean): Promise<void> {
    const agents = on ? [{ agent_id: c.smsAgentId, weight: 1 }] : null;
    await retell(c.apiKey, `/update-phone-number/${encodeURIComponent(c.fromNumber)}`, {
      method: 'PATCH',
      body: JSON.stringify({ inbound_sms_agents: agents, outbound_sms_agents: agents, inbound_sms_webhook_url: on ? this.inboundWebhookUrl : null }),
    });
  }

  /**
   * Why this number can never text through Retell, if so. Retell's SMS runs
   * on its Twilio numbers (US, not toll-free) after A2P registration; a number
   * brought in over a SIP trunk from Telnyx cannot (Retell: "Telnyx isn't
   * supported yet"), nor can a Retell-Telnyx number. Another SIP number may
   * have Retell's "SMS function" set up with its own Twilio account, which the
   * API does not show, so it is left to the send to tell.
   */
  private unsupportedReason(from: string, n: NumberInfo): string | null {
    if (n.type === 'retell-telnyx') return `Retell cannot text from ${from}: it is a Retell-Telnyx number, and Retell SMS needs a Retell-Twilio US number.`;
    if (n.type === 'custom' && /telnyx/i.test(n.terminationUri)) {
      return `Retell cannot text from ${from}: it is brought in from Telnyx over SIP, and Retell SMS does not support Telnyx numbers. Buy a Retell (Twilio) US number for SMS, or call through Telnyx.`;
    }
    if (!from.startsWith('+1')) return `Retell cannot text from ${from}: Retell SMS is available on US numbers only.`;
    if (TOLL_FREE.test(from)) return `Retell cannot text from ${from}: Retell SMS is not available on toll-free numbers.`;
    return null;
  }

  private numberKey(c: RetellCreds): string {
    return `${c.id}:${c.fromNumber}`;
  }

  private async numberInfo(c: RetellCreds, fresh = false): Promise<NumberInfo> {
    const key = this.numberKey(c);
    const hit = this.numbers.get(key);
    if (!fresh && hit && hit.until > Date.now()) return hit.value;
    const n = await retell<any>(c.apiKey, `/get-phone-number/${encodeURIComponent(c.fromNumber)}`);
    const ids = (list: unknown) => (Array.isArray(list) ? list.map((a) => String((a as { agent_id?: unknown })?.agent_id ?? '')).filter(Boolean) : []);
    const value: NumberInfo = {
      type: String(n.phone_number_type ?? ''),
      terminationUri: String(n.sip_outbound_trunk_config?.termination_uri ?? n.termination_uri ?? ''),
      inboundSmsAgents: ids(n.inbound_sms_agents),
      outboundSmsAgents: ids(n.outbound_sms_agents),
      inboundSmsWebhookUrl: typeof n.inbound_sms_webhook_url === 'string' ? n.inbound_sms_webhook_url : null,
    };
    if (this.numbers.size > 500) this.numbers.clear();
    this.numbers.set(key, { value, until: Date.now() + NUMBER_CACHE_MS });
    return value;
  }

  private async leadIdFor(orgId: string, phone: string): Promise<string | null> {
    const lead = await this.prisma.lead.findFirst({ where: { orgId, normalizedPhone: phone }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    return lead?.id ?? null;
  }

  private async recordsCalls(orgId: string): Promise<boolean> {
    const s = await this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { callRecordingEnabled: true } }).catch(() => null);
    return s?.callRecordingEnabled ?? true;
  }

  /**
   * The SMS prompt with the sections this app manages kept on it: in-chat
   * booking when it is on for Retell, and callbacks and outcomes once their
   * tools are on this LLM (the section must never name tools the LLM lacks).
   */
  private async withSections(orgId: string, prompt: string, llmId?: string): Promise<string> {
    const s = await this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { inCallBooking: true, callTools: true } }).catch(() => null);
    const booking = (s?.inCallBooking ?? null) as { provider?: string; eventTypeName?: string; durationMinutes?: number } | null;
    const withBooking = booking?.provider === 'retell' && booking.eventTypeName && booking.durationMinutes ? withBookingSection(prompt, booking.eventTypeName, booking.durationMinutes) : prompt;
    const provisioned = ((s?.callTools ?? null) as { retell?: { llmIds?: string[] } } | null)?.retell?.llmIds ?? [];
    return callToolsSettings(s?.callTools).enabled && !!llmId && provisioned.includes(llmId) ? withCallToolsSection(withBooking) : withBooking;
  }
}
