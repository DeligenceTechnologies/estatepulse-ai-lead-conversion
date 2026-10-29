import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LeadStatus, Prisma, type SmsChat } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';
import type { IntegrationEnv } from '@/common/utils/interface';
import { LeadStateService } from '@/lead/lead-state.service';
import { EngineService } from '@/telnyx/engine.service';
import { InboundSmsService } from '@/telnyx/inbound-sms.service';
import { OutcomeService } from '@/telnyx/tools/outcome.service';
import { extractionFromRetell } from './retell-analysis';
import { isRetellRateLimited, retell } from './retell-api';
import { RetellCredentialsService, type RetellCreds } from './retell-credentials.service';
import { retellEnabled } from './retell-enabled.guard';
import { RetellSmsService } from './retell-sms.service';

/** A Retell chat as its webhooks and get-chat describe it; only what the sync reads. */
export interface RetellChat {
  chat_id?: string;
  agent_id?: string;
  chat_status?: string;
  chat_type?: string;
  start_timestamp?: number;
  end_timestamp?: number | null;
  message_with_tool_calls?: { role?: string; content?: string; message_id?: string; created_timestamp?: number }[];
  chat_analysis?: unknown;
  metadata?: unknown;
}

export interface ChatRef {
  orgId: string;
  leadId: string;
  chatId: string;
  agentId?: string | null;
  direction: 'inbound' | 'outbound';
}

/** How often ongoing chats are looked at, and how soon after a message. */
const POLL_MS = 10_000;
const BATCH = 20;
export const FIRST_SYNC_MS = 5_000;
export const MIN_INTERVAL_MS = 15_000;
export const MAX_INTERVAL_MS = 5 * 60_000;
/** A chat still open this long after it began is closed here: Retell has ended it by then. */
const STALE_MS = 3 * 24 * 60 * 60_000;
/** A row claimed for a sync is not claimed again this soon, so a failing sync backs off. */
const CLAIM_HOLD_MS = 60_000;
const RATE_LIMIT_WAIT_MS = 60_000;

const SPOKEN_ROLES = new Set(['agent', 'user', 'sms']);
const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/**
 * Keeps the lead's text thread in `messages` in step with the SMS chats
 * Retell runs. Retell sends no webhook per message, only chat_started,
 * chat_ended and chat_analyzed (the full chat each time), so an ongoing chat
 * is read with get-chat: soon after it opens, then at a widening interval
 * while it stays quiet, until it ends. Every message is filed once, by
 * Retell's message id; a lead's new texts go through the same STOP / START
 * rules as a Telnyx reply, and the post-chat analysis ends the outreach when
 * the lead said so in their own words.
 */
@Injectable()
export class RetellChatSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetellChatSyncService.name);
  private readonly on: boolean;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly creds: RetellCredentialsService,
    private readonly sms: RetellSmsService,
    private readonly inbound: InboundSmsService,
    private readonly engine: EngineService,
    private readonly outcomes: OutcomeService,
    private readonly state: LeadStateService,
    config: ConfigService<IntegrationEnv, true>,
  ) {
    this.on = retellEnabled(config) && config.get('STRATEGY_ENGINE', { infer: true }) === true;
  }

  onModuleInit(): void {
    if (!this.on) return;
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** A chat we know about from now on; the same chat registered twice stays one row. */
  async register(ref: ChatRef): Promise<SmsChat> {
    return this.prisma.smsChat.upsert({
      where: { provider_providerChatId: { provider: 'retell', providerChatId: ref.chatId } },
      create: {
        orgId: ref.orgId,
        leadId: ref.leadId,
        provider: 'retell',
        providerChatId: ref.chatId,
        agentId: ref.agentId ?? null,
        direction: ref.direction,
        nextSyncAt: new Date(Date.now() + FIRST_SYNC_MS),
      },
      update: {},
    });
  }

  async byChatId(chatId: string): Promise<SmsChat | null> {
    return this.prisma.smsChat.findFirst({ where: { provider: 'retell', providerChatId: chatId } });
  }

  /** A chat webhook: the payload is the chat, so no read is needed. */
  async onChatEvent(row: SmsChat, chat: RetellChat): Promise<void> {
    await this.apply(row, chat);
  }

  /** Reads the chat from Retell and files what is new. */
  async syncNow(row: SmsChat): Promise<void> {
    const c = await this.creds.getCreds(row.orgId);
    if (!c?.apiKey) {
      await this.prisma.smsChat.update({ where: { id: row.id }, data: { nextSyncAt: null } });
      return;
    }
    const chat = await retell<RetellChat>(c.apiKey, `/get-chat/${encodeURIComponent(row.providerChatId)}`);
    await this.apply(row, chat, c);
  }

  /** Ongoing chats due for a read, a bounded batch at a time, shared with other instances through the claim. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.closeStale();
      const rows = await this.claim();
      for (const row of rows) {
        try {
          await this.syncNow(row);
        } catch (error) {
          if (isRetellRateLimited(error)) {
            this.logger.warn(`Retell rate limit while syncing chats; pausing ${RATE_LIMIT_WAIT_MS / 1000}s`);
            await this.prisma.smsChat.updateMany({ where: { id: { in: rows.map((r) => r.id) }, status: 'ongoing' }, data: { nextSyncAt: new Date(Date.now() + RATE_LIMIT_WAIT_MS) } });
            return;
          }
          this.logger.warn(`sync Retell chat ${row.providerChatId}: ${(error as Error).message}`);
        }
      }
    } catch (error) {
      this.logger.error(`Retell chat sync tick: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async claim(): Promise<SmsChat[]> {
    const ids = await this.prisma.$queryRaw<{ id: string }[]>`
      WITH due AS (
        SELECT id FROM sms_chats
         WHERE status = 'ongoing' AND next_sync_at IS NOT NULL AND next_sync_at <= now()
         ORDER BY next_sync_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT ${BATCH}
      )
      UPDATE sms_chats s
         SET next_sync_at = now() + make_interval(secs => ${CLAIM_HOLD_MS / 1000}), last_synced_at = now()
        FROM due
       WHERE s.id = due.id
      RETURNING s.id`;
    if (!ids.length) return [];
    return this.prisma.smsChat.findMany({ where: { id: { in: ids.map((r) => r.id) } } });
  }

  private async closeStale(): Promise<void> {
    await this.prisma.smsChat.updateMany({
      where: { status: 'ongoing', startedAt: { lt: new Date(Date.now() - STALE_MS) } },
      data: { status: 'ended', endedAt: new Date(), nextSyncAt: null },
    });
  }

  /**
   * Files the chat's messages that are not on record yet, runs the lead's new
   * texts through the reply rules, closes the row when the chat has ended and
   * acts on its analysis once. Retries of the same payload change nothing.
   */
  private async apply(row: SmsChat, chat: RetellChat, creds?: RetellCreds | null): Promise<void> {
    const chatId = row.providerChatId;
    const messages = (chat.message_with_tool_calls ?? []).filter((m) => typeof m?.role === 'string' && SPOKEN_ROLES.has(m.role));
    const newInbound: { text: string; at: Date }[] = [];
    let lastAt = row.lastMessageAt;
    let agentSpoke = false;
    let filed = 0;
    for (const [i, m] of messages.entries()) {
      const text = String(m.content ?? '').trim();
      const at = typeof m.created_timestamp === 'number' ? new Date(m.created_timestamp) : new Date();
      if (!lastAt || at > lastAt) lastAt = at;
      if (m.role !== 'user') agentSpoke = true;
      if (!text) continue;
      const providerMessageId = `${chatId}:${m.message_id ?? `i${i}`}`;
      if (await this.prisma.message.findFirst({ where: { providerMessageId }, select: { id: true } })) continue;
      filed += 1;
      if (m.role === 'user') {
        await this.prisma.message.create({
          data: { orgId: row.orgId, leadId: row.leadId, senderType: 'lead', direction: 'inbound', channel: 'sms', body: text, providerMessageId, deliveryStatus: 'delivered', sentAt: at, deliveredAt: at, createdAt: at },
        });
        newInbound.push({ text, at });
        continue;
      }
      // Our opening text was recorded when the chat was created, under a placeholder id, before Retell gave the message one.
      const placeholder = await this.prisma.message.findFirst({ where: { providerMessageId: `${chatId}:opening`, direction: 'outbound' }, select: { id: true } });
      if (placeholder) {
        await this.prisma.message.update({ where: { id: placeholder.id }, data: { providerMessageId, sentAt: at } });
      } else {
        await this.prisma.message.create({
          data: { orgId: row.orgId, leadId: row.leadId, senderType: 'ai', direction: 'outbound', channel: 'sms', body: text, providerMessageId, deliveryStatus: 'sent', sentAt: at, createdAt: at },
        });
        await this.prisma.lead.update({ where: { id: row.leadId }, data: { lastContactAt: new Date() } }).catch(() => undefined);
      }
    }

    let optedOut = false;
    for (const { text } of newInbound) {
      const decided = await this.inbound.onProviderText(row.orgId, row.leadId, text);
      if (decided === 'opt_out') optedOut = true;
    }

    const status = chat.chat_status === 'ended' || chat.chat_status === 'error' ? chat.chat_status : 'ongoing';
    const ended = status !== 'ongoing';
    const endedAt = ended ? (typeof chat.end_timestamp === 'number' ? new Date(chat.end_timestamp) : new Date()) : null;
    // A chat that errored before its agent ever spoke never sent our opening text.
    if (status === 'error' && !agentSpoke) {
      await this.prisma.message.updateMany({ where: { providerMessageId: `${chatId}:opening`, direction: 'outbound', deliveryStatus: 'sent' }, data: { deliveryStatus: 'failed', failedAt: new Date() } });
    }
    // Something new: look again soon; a quiet chat is looked at less and less often.
    const interval = filed > 0 ? MIN_INTERVAL_MS : Math.min(Math.max(row.syncIntervalMs, MIN_INTERVAL_MS) * 2, MAX_INTERVAL_MS);
    const analysis = chat.chat_analysis && typeof chat.chat_analysis === 'object' && !row.analysis ? (chat.chat_analysis as Prisma.InputJsonObject) : undefined;
    await this.prisma.smsChat.update({
      where: { id: row.id },
      data: {
        status,
        endedAt,
        lastMessageAt: lastAt,
        lastSyncedAt: new Date(),
        nextSyncAt: ended || optedOut ? null : new Date(Date.now() + interval),
        syncIntervalMs: interval,
        ...(chat.agent_id && !row.agentId ? { agentId: chat.agent_id } : {}),
        ...(analysis ? { analysis } : {}),
      },
    });

    if (optedOut && !ended) {
      const c = creds === undefined ? await this.creds.getCreds(row.orgId) : creds;
      if (c?.apiKey) await this.sms.endChat(c, chatId);
    }
    // The analysis is acted on once, and only for a chat the lead took part in: the agent alone decides nothing.
    const replied = newInbound.length > 0 || messages.some((m) => m.role === 'user');
    if (analysis && replied) await this.onAnalysis(row, chat.chat_analysis);
  }

  /**
   * What the lead said in their own words, read by Retell when the chat
   * ended: a request not to be contacted, a wrong number or a clear no end
   * the outreach, like a Telnyx text's intent check. The outcome tool records
   * these the moment they are said; this catches what it missed.
   */
  private async onAnalysis(row: SmsChat, analysis: unknown): Promise<void> {
    const x = extractionFromRetell(analysis);
    if (!x) return;
    const intent = x.do_not_contact ? 'opt_out' : x.invalid_lead ? 'wrong_number' : x.not_interested && !x.appointment_requested && !x.callback_requested ? 'not_interested' : 'continue';
    if (intent === 'continue') return;
    const lead = await this.prisma.lead.findFirst({ where: { id: row.leadId, orgId: row.orgId }, select: { dncStatus: true, status: true } });
    if (!lead) return;
    this.state.quietly({ orgId: row.orgId, leadId: row.leadId, type: 'sms_intent', source: 'sms_reply', channel: 'sms', reason: x.summary.slice(0, 500) || null, payload: { intent, from: 'retell_chat_analysis' } });
    const quoted = x.summary ? `: ${x.summary.slice(0, 160)}` : '';
    try {
      if (intent === 'opt_out') {
        if (!lead.dncStatus) await this.outcomes.record({ orgId: row.orgId, leadId: row.leadId, callId: null, provider: 'retell' }, { outcome: 'do_not_contact', note: 'Found in the text chat analysis' });
      } else if (intent === 'wrong_number') {
        await this.engine.setStatus(row.orgId, row.leadId, LeadStatus.invalid, `Wrong number, said by SMS${quoted}`, { source: 'sms_reply' });
      } else {
        await this.engine.setStatus(row.orgId, row.leadId, LeadStatus.not_interested, `Not interested, said by SMS${quoted}`, { source: 'sms_reply' });
      }
    } catch (error) {
      this.logger.warn(`chat analysis outcome for lead ${row.leadId}: ${(error as Error).message}`);
    }
  }
}

/** The organization and lead a chat's metadata names, when it is ours and well-formed. Never trusted on its own. */
export function chatMetadata(chat: RetellChat): { orgId: string; leadId: string; source: string } | null {
  const m = chat.metadata as { orgId?: unknown; leadId?: unknown; source?: unknown } | null | undefined;
  if (!m || !isUuid(m.orgId) || !isUuid(m.leadId)) return null;
  return { orgId: m.orgId, leadId: m.leadId, source: typeof m.source === 'string' ? m.source : '' };
}
