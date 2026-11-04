import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import type { IntegrationEnv } from '@/common/utils/interface';
import { normalizePhone } from '../phone';
import { TelnyxCredentialsService } from '../telnyx-credentials.service';
import { telnyx } from '../telnyx-api';
import { CallToolsService } from '../tools/call-tools.service';
import { withSmsSection, withoutSmsSection } from './sms-prompt';

/** Where Telnyx asks for a conversation's variables (the lead's details). Kept at the root, outside /api. */
export const ASSISTANT_VARIABLES_PATH = '/webhooks/telnyx/assistant-variables';
const VARIABLES_TIMEOUT_MS = 3000;
const ENABLED_CACHE_MS = 30_000;

/** What was linked on Telnyx when the AI started answering texts, so it can be undone exactly. */
export interface SmsConversationConfig {
  enabled: true;
  assistantId: string;
  messagingProfileId: string;
  enabledAt: string;
}

/**
 * Who writes the AI's text replies. 'telnyx': the assistant linked to the
 * messaging profile answers every text itself, and this server only records
 * it. 'estatepulse': the profile is not linked; this server decides per text
 * whether the AI answers, runs its tools and sends the reply (sms-agent).
 */
export const SMS_REPLY_ENGINES = ['telnyx', 'estatepulse'] as const;
export type SmsReplyEngine = (typeof SMS_REPLY_ENGINES)[number];
const engineOf = (value: unknown): SmsReplyEngine => (value === 'estatepulse' ? 'estatepulse' : 'telnyx');

/** At most this many paused chats are paused again on Telnyx when an organization goes back to Telnyx replies. */
const REPAUSE_LIMIT = 500;

export interface SmsConversationStatus {
  enabled: boolean;
  assistantId: string | null;
  messagingProfileId: string | null;
  enabledAt: string | null;
  /** In-call booking is on, so the AI can book a meeting in the chat too. */
  bookingInChat: boolean;
  engine: SmsReplyEngine;
}

/**
 * The AI assistant answering a lead's texts. Turning it on links three things
 * on Telnyx: the org's messaging profile to the assistant, the assistant's
 * messaging feature to that profile, and the assistant's variables webhook to
 * this server, plus the text-chat section of its prompt. Off undoes them. The
 * call tools (callback, text later, outcome) are put on the assistant too, so
 * a chat has them before the organization's first AI call.
 */
@Injectable()
export class SmsConversationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SmsConversationService.name);
  private readonly publicApiUrl: string;
  private readonly statusCache = new Map<string, { value: { enabled: boolean; engine: SmsReplyEngine }; until: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly creds: TelnyxCredentialsService,
    config: ConfigService<IntegrationEnv, true>,
    private readonly callTools: CallToolsService,
  ) {
    this.publicApiUrl = (config.get('PUBLIC_API_URL', { infer: true }) ?? '').replace(/\/+$/, '');
  }

  get variablesUrl(): string {
    return `${this.publicApiUrl}${ASSISTANT_VARIABLES_PATH}`;
  }

  /** The server's address can change (a new deploy domain, a dev tunnel), and a release can change the chat prompt or tools. */
  onApplicationBootstrap(): void {
    if (this.publicApiUrl) void this.refreshChats();
  }

  /**
   * Brings every chatting assistant up to date: its variables webhook moves to
   * this server when it still names our path on an older address (an address
   * the organization typed in itself is left alone), its text-chat prompt
   * section is rewritten when this release changed it, and it gets the call
   * tools.
   */
  async refreshChats(): Promise<void> {
    const rows = await this.prisma.organizationSetting
      .findMany({ where: { smsConversation: { path: ['enabled'], equals: true } }, select: { orgId: true } })
      .catch((error) => {
        this.logger.warn(`text chat check: ${(error as Error).message}`);
        return [];
      });
    for (const { orgId } of rows) {
      try {
        const c = await this.creds.getCreds(orgId);
        if (!c?.apiKey || !c.assistantId) continue;
        const assistant = await this.assistant(c.apiKey, c.assistantId);
        const patch: Record<string, string> = {};
        const current = String(assistant.dynamic_variables_webhook_url ?? '');
        if (current.endsWith(ASSISTANT_VARIABLES_PATH) && current !== this.variablesUrl) patch.dynamic_variables_webhook_url = this.variablesUrl;
        // Unreadable instructions are never written over.
        if (typeof assistant.instructions === 'string') {
          const instructions = withSmsSection(assistant.instructions);
          if (instructions !== assistant.instructions) patch.instructions = instructions;
        }
        if (Object.keys(patch).length) {
          await telnyx(c.apiKey, `/ai/assistants/${c.assistantId}`, { method: 'PATCH', body: JSON.stringify(patch) });
          this.logger.log(`assistant ${c.assistantId}: text chat brought up to date (${Object.keys(patch).join(', ')})`);
        }
      } catch (error) {
        this.logger.warn(`text chat for org ${orgId}: ${(error as Error).message}`);
      }
      await this.callTools.ensure(orgId);
    }
  }

  async status(orgId: string): Promise<SmsConversationStatus> {
    const row = await this.prisma.organizationSetting.findUnique({
      where: { orgId },
      select: { smsConversation: true, inCallBooking: true, smsReplyEngine: true },
    });
    const config = row?.smsConversation as SmsConversationConfig | null | undefined;
    return {
      enabled: Boolean(config?.enabled),
      assistantId: config?.assistantId ?? null,
      messagingProfileId: config?.messagingProfileId ?? null,
      enabledAt: config?.enabledAt ?? null,
      bookingInChat: Boolean((row?.inCallBooking as { tokenHash?: string } | null)?.tokenHash),
      engine: engineOf(row?.smsReplyEngine),
    };
  }

  /** Cached briefly: it is read on every inbound text and every strategy step. */
  async isEnabled(orgId: string): Promise<boolean> {
    return (await this.cached(orgId)).enabled;
  }

  /** Who writes the AI's replies for the organization; cached like isEnabled. */
  async replyEngine(orgId: string): Promise<SmsReplyEngine> {
    return (await this.cached(orgId)).engine;
  }

  /** The AI answers texts, and this server writes its replies (the sms-agent), not the assistant linked on Telnyx. */
  async repliesHere(orgId: string): Promise<boolean> {
    const s = await this.cached(orgId);
    return s.enabled && s.engine === 'estatepulse';
  }

  private async cached(orgId: string): Promise<{ enabled: boolean; engine: SmsReplyEngine }> {
    const hit = this.statusCache.get(orgId);
    if (hit && hit.until > Date.now()) return hit.value;
    const { enabled, engine } = await this.status(orgId);
    const value = { enabled, engine };
    this.statusCache.set(orgId, { value, until: Date.now() + ENABLED_CACHE_MS });
    return value;
  }

  /**
   * Moves the organization's AI replies to this server or back to Telnyx.
   * Never both at once and never neither for long: to this server, the
   * profile is unlinked first (Telnyx stops) and then the engine is saved; back
   * to Telnyx, the engine is saved first (this server stops) and then the
   * profile is linked, and the chats agents hold or opted-out leads had are
   * paused on Telnyx again. A profile another organization shares is refused,
   * since one link answers for every organization on it.
   */
  async setEngine(orgId: string, engine: SmsReplyEngine): Promise<SmsConversationStatus> {
    const current = await this.status(orgId);
    if (current.engine === engine) return current;
    const c = current.enabled ? await this.creds.getCreds(orgId) : null;
    const profileId = current.messagingProfileId;
    if (current.enabled && c?.apiKey && profileId) {
      await this.assertProfileNotShared(orgId, profileId);
      const link = (assistantId: string) =>
        telnyx(c.apiKey, `/messaging_profiles/${profileId}`, { method: 'PATCH', body: JSON.stringify({ ai_assistant_id: assistantId }) });
      if (engine === 'estatepulse') {
        await link('');
        try {
          await this.saveEngine(orgId, engine);
        } catch (error) {
          await link(current.assistantId ?? '').catch(() => undefined);
          throw error;
        }
      } else {
        await this.saveEngine(orgId, engine);
        try {
          await link(current.assistantId ?? c.assistantId);
        } catch (error) {
          await this.saveEngine(orgId, current.engine).catch(() => undefined);
          throw error;
        }
        await this.repauseHeldChats(orgId);
      }
    } else {
      await this.saveEngine(orgId, engine);
    }
    this.logger.log(`AI text replies for ${orgId} now come from ${engine === 'estatepulse' ? 'this server' : 'the Telnyx assistant'}`);
    return this.status(orgId);
  }

  /** Another organization with AI text replies on the same messaging profile: linking or unlinking it would change their replies too. */
  private async assertProfileNotShared(orgId: string, profileId: string): Promise<void> {
    const others = await this.prisma.organizationSetting.count({
      where: {
        NOT: { orgId },
        AND: [{ smsConversation: { path: ['enabled'], equals: true } }, { smsConversation: { path: ['messagingProfileId'], equals: profileId } }],
      },
    });
    if (others > 0) {
      throw new AppError('CONFLICT', 'Another organization uses AI text replies on this messaging profile. Give this number its own messaging profile first.');
    }
  }

  private async saveEngine(orgId: string, smsReplyEngine: SmsReplyEngine): Promise<void> {
    await this.prisma.organizationSetting.upsert({ where: { orgId }, create: { orgId, smsReplyEngine }, update: { smsReplyEngine } });
    this.statusCache.delete(orgId);
  }

  /**
   * Back on Telnyx replies, the assistant answers every chat it has, so the
   * chats of leads an agent holds or who opted out are paused there again:
   * this server did not keep their Telnyx chats paused while it wrote replies.
   */
  private async repauseHeldChats(orgId: string): Promise<void> {
    const leads = await this.prisma.lead.findMany({
      where: { orgId, normalizedPhone: { not: null }, OR: [{ takenOverById: { not: null } }, { dncStatus: true }] },
      select: { normalizedPhone: true },
      take: REPAUSE_LIMIT,
    });
    for (const phone of new Set(leads.map((l) => l.normalizedPhone!))) {
      await this.pauseAi(orgId, phone, true).catch((error) => this.logger.warn(`re-pausing the Telnyx chat with ${phone}: ${(error as Error).message}`));
    }
  }

  async enable(orgId: string): Promise<SmsConversationStatus> {
    if (!this.publicApiUrl) throw new AppError('CONFLICT', 'PUBLIC_API_URL is not configured on the server.');
    const c = await this.creds.getCreds(orgId);
    if (!c?.apiKey || !c.assistantId) throw new AppError('CONFLICT', 'Connect Telnyx and create the AI assistant first.');
    if (!c.messagingProfileId) throw new AppError('CONFLICT', 'Assign your number to a Telnyx messaging profile first.');

    const assistant = await this.assistant(c.apiKey, c.assistantId);
    const features = new Set<string>([...(assistant.enabled_features ?? ['telephony']), 'messaging']);
    await telnyx(c.apiKey, `/ai/assistants/${c.assistantId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        enabled_features: [...features],
        messaging_settings: { ...(assistant.messaging_settings ?? {}), default_messaging_profile_id: c.messagingProfileId },
        dynamic_variables_webhook_url: this.variablesUrl,
        dynamic_variables_webhook_timeout_ms: VARIABLES_TIMEOUT_MS,
        instructions: withSmsSection(String(assistant.instructions ?? '')),
      }),
    });
    // On Telnyx replies the profile is linked, so the assistant answers texts; on this server's, it stays unlinked.
    if ((await this.status(orgId)).engine === 'telnyx') {
      await this.assertProfileFree(c.apiKey, c.messagingProfileId, c.assistantId);
      await telnyx(c.apiKey, `/messaging_profiles/${c.messagingProfileId}`, {
        method: 'PATCH',
        body: JSON.stringify({ ai_assistant_id: c.assistantId }),
      });
    }

    const config: SmsConversationConfig = {
      enabled: true,
      assistantId: c.assistantId,
      messagingProfileId: c.messagingProfileId,
      enabledAt: new Date().toISOString(),
    };
    await this.save(orgId, config as unknown as Prisma.InputJsonObject);
    this.logger.log(`AI text conversations on for ${orgId} (assistant ${c.assistantId}, profile ${c.messagingProfileId})`);
    // Without them the AI could promise a callback or a text it has no way to keep.
    await this.callTools.ensure(orgId);
    return this.status(orgId);
  }

  async disable(orgId: string): Promise<SmsConversationStatus> {
    const row = await this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { smsConversation: true } });
    const config = row?.smsConversation as SmsConversationConfig | null | undefined;
    const c = await this.creds.getCreds(orgId).catch(() => null);
    if (config && c?.apiKey) {
      const quiet = (what: string, p: Promise<unknown>) => p.catch((error) => this.logger.warn(`turning off texts, ${what}: ${(error as Error).message}`));
      // An empty id unlinks the assistant; Telnyx refuses null.
      await quiet('profile', telnyx(c.apiKey, `/messaging_profiles/${config.messagingProfileId}`, { method: 'PATCH', body: JSON.stringify({ ai_assistant_id: '' }) }));
      const assistant = await this.assistant(c.apiKey, config.assistantId).catch(() => null);
      if (assistant) {
        await quiet(
          'assistant',
          telnyx(c.apiKey, `/ai/assistants/${config.assistantId}`, {
            method: 'PATCH',
            body: JSON.stringify({
              enabled_features: (assistant.enabled_features ?? ['telephony']).filter((f: string) => f !== 'messaging'),
              messaging_settings: { ...(assistant.messaging_settings ?? {}), default_messaging_profile_id: null },
              dynamic_variables_webhook_url: null,
              instructions: withoutSmsSection(String(assistant.instructions ?? '')),
            }),
          }),
        );
      }
    }
    await this.save(orgId, Prisma.DbNull);
    this.logger.log(`AI text conversations off for ${orgId}`);
    return this.status(orgId);
  }

  /**
   * Adds a text we sent outside the assistant (a strategy or follow-up step) to
   * the lead's text conversation, so the AI reads the lead's reply in context.
   * A lead who never texted has no conversation yet; the variables endpoint
   * gives the AI our last text then.
   */
  async appendOurMessage(orgId: string, leadPhone: string | null, text: string): Promise<void> {
    await this.appendToChat(orgId, leadPhone, 'assistant', text);
  }

  /** Adds a turn to the lead's text conversation: ours as `assistant`, the lead's as `user`. */
  async appendToChat(orgId: string, leadPhone: string | null, role: 'assistant' | 'user', text: string, sentAt = new Date()): Promise<void> {
    // On this server's replies the chat is read from our own messages: there is no Telnyx copy to keep.
    if (!leadPhone || !(await this.isEnabled(orgId)) || (await this.replyEngine(orgId)) === 'estatepulse') return;
    const chat = await this.chatWith(orgId, leadPhone);
    if (!chat) return;
    await telnyx(chat.apiKey, `/ai/conversations/${chat.id}/message`, {
      method: 'POST',
      body: JSON.stringify({ role, content: text, sent_at: sentAt.toISOString() }),
    });
  }

  /**
   * Stops the AI answering this one lead's texts, or lets it answer again;
   * every other lead's chat goes on. False when the lead has no text
   * conversation yet (Telnyx starts one at their first text). Not gated on the
   * org's toggle, so a chat paused before the AI was turned off can still be
   * let go.
   */
  async pauseAi(orgId: string, leadPhone: string | null, paused: boolean): Promise<boolean> {
    // On this server's replies Telnyx answers nothing, and the sms-agent itself skips a lead an agent holds.
    if (!leadPhone || (await this.replyEngine(orgId)) === 'estatepulse') return false;
    const chat = await this.chatWith(orgId, leadPhone);
    if (!chat) return false;
    // A real boolean: Telnyx ignores the string "true" its own docs show (live-tested 2026-10-30). PUT merges into the metadata.
    await telnyx(chat.apiKey, `/ai/conversations/${chat.id}`, { method: 'PUT', body: JSON.stringify({ metadata: { ai_disabled: paused } }) });
    return true;
  }

  /** The lead's text conversation with the assistant: the newest, should inactivity have started another. */
  private async chatWith(orgId: string, leadPhone: string): Promise<{ apiKey: string; id: string } | null> {
    const c = await this.creds.getCreds(orgId);
    if (!c?.apiKey || !c.fromNumber) return null;
    const filter = (key: string, value: string) => `metadata->${key}=eq.${encodeURIComponent(value)}`;
    const query = [
      filter('telnyx_conversation_channel', 'sms_chat'),
      filter('telnyx_agent_target', normalizePhone(c.fromNumber)),
      filter('telnyx_end_user_target', normalizePhone(leadPhone)),
      'order=last_message_at.desc',
    ].join('&');
    const found = await telnyx<{ data?: { id: string }[] }>(c.apiKey, `/ai/conversations?${query}`);
    const id = found.data?.[0]?.id;
    return id ? { apiKey: c.apiKey, id } : null;
  }

  /**
   * A profile already linked to another assistant answers for whoever linked
   * it: linking ours would silently take over that organization's texts.
   */
  private async assertProfileFree(apiKey: string, profileId: string, assistantId: string): Promise<void> {
    const raw = await telnyx<any>(apiKey, `/messaging_profiles/${profileId}`);
    const linked = String((raw?.data ?? raw)?.ai_assistant_id ?? '');
    if (linked && linked !== assistantId) {
      throw new AppError('CONFLICT', 'This messaging profile already answers texts with another AI assistant. Give this number its own messaging profile first.');
    }
  }

  private async assistant(apiKey: string, assistantId: string): Promise<any> {
    const raw = await telnyx<any>(apiKey, `/ai/assistants/${assistantId}`);
    return raw?.data ?? raw ?? {};
  }

  private async save(orgId: string, smsConversation: Prisma.InputJsonObject | typeof Prisma.DbNull): Promise<void> {
    await this.prisma.organizationSetting.upsert({
      where: { orgId },
      create: { orgId, smsConversation },
      update: { smsConversation },
    });
    this.statusCache.delete(orgId);
  }
}
