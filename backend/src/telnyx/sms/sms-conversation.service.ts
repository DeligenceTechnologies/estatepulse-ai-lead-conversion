import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import type { IntegrationEnv } from '@/common/utils/interface';
import { normalizePhone } from '../phone';
import { TelnyxCredentialsService } from '../telnyx-credentials.service';
import { telnyx } from '../telnyx-api';
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

export interface SmsConversationStatus {
  enabled: boolean;
  assistantId: string | null;
  messagingProfileId: string | null;
  enabledAt: string | null;
  /** In-call booking is on, so the AI can book a meeting in the chat too. */
  bookingInChat: boolean;
}

/**
 * The AI assistant answering a lead's texts. Turning it on links three things
 * on Telnyx: the org's messaging profile to the assistant, the assistant's
 * messaging feature to that profile, and the assistant's variables webhook to
 * this server, plus the text-chat section of its prompt. Off undoes them.
 */
@Injectable()
export class SmsConversationService {
  private readonly logger = new Logger(SmsConversationService.name);
  private readonly publicApiUrl: string;
  private readonly enabledCache = new Map<string, { value: boolean; until: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly creds: TelnyxCredentialsService,
    config: ConfigService<IntegrationEnv, true>,
  ) {
    this.publicApiUrl = (config.get('PUBLIC_API_URL', { infer: true }) ?? '').replace(/\/+$/, '');
  }

  get variablesUrl(): string {
    return `${this.publicApiUrl}${ASSISTANT_VARIABLES_PATH}`;
  }

  async status(orgId: string): Promise<SmsConversationStatus> {
    const row = await this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { smsConversation: true, inCallBooking: true } });
    const config = row?.smsConversation as SmsConversationConfig | null | undefined;
    return {
      enabled: Boolean(config?.enabled),
      assistantId: config?.assistantId ?? null,
      messagingProfileId: config?.messagingProfileId ?? null,
      enabledAt: config?.enabledAt ?? null,
      bookingInChat: Boolean((row?.inCallBooking as { tokenHash?: string } | null)?.tokenHash),
    };
  }

  /** Cached briefly: it is read on every inbound text and every strategy step. */
  async isEnabled(orgId: string): Promise<boolean> {
    const hit = this.enabledCache.get(orgId);
    if (hit && hit.until > Date.now()) return hit.value;
    const value = (await this.status(orgId)).enabled;
    this.enabledCache.set(orgId, { value, until: Date.now() + ENABLED_CACHE_MS });
    return value;
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
    await telnyx(c.apiKey, `/messaging_profiles/${c.messagingProfileId}`, {
      method: 'PATCH',
      body: JSON.stringify({ ai_assistant_id: c.assistantId }),
    });

    const config: SmsConversationConfig = {
      enabled: true,
      assistantId: c.assistantId,
      messagingProfileId: c.messagingProfileId,
      enabledAt: new Date().toISOString(),
    };
    await this.save(orgId, config as unknown as Prisma.InputJsonObject);
    this.logger.log(`AI text conversations on for ${orgId} (assistant ${c.assistantId}, profile ${c.messagingProfileId})`);
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
    if (!leadPhone || !(await this.isEnabled(orgId))) return;
    const c = await this.creds.getCreds(orgId);
    if (!c?.apiKey || !c.fromNumber) return;
    const filter = (key: string, value: string) => `metadata->${key}=eq.${encodeURIComponent(value)}`;
    const query = [
      filter('telnyx_conversation_channel', 'sms_chat'),
      filter('telnyx_agent_target', normalizePhone(c.fromNumber)),
      filter('telnyx_end_user_target', normalizePhone(leadPhone)),
    ].join('&');
    const found = await telnyx<{ data?: { id: string }[] }>(c.apiKey, `/ai/conversations?${query}`);
    const conversationId = found.data?.[0]?.id;
    if (!conversationId) return;
    await telnyx(c.apiKey, `/ai/conversations/${conversationId}/message`, {
      method: 'POST',
      body: JSON.stringify({ role: 'assistant', content: text, sent_at: new Date().toISOString() }),
    });
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
    this.enabledCache.delete(orgId);
  }
}
