import { randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { sha256Hex } from '@/common/utils/crypto';
import type { IntegrationEnv } from '@/common/utils/interface';
import { telnyx } from '../telnyx-api';
import { TelnyxCredentialsService } from '../telnyx-credentials.service';
import {
  CALL_TOOL_NAMES,
  CALL_TOOLS_VERSION,
  callToolDefinitions,
  callToolsSettings,
  DEFAULT_CONFIRM_MESSAGE,
  DEFAULT_TEXT_BACK_MESSAGE,
  withCallToolsSection,
  withoutCallToolsSection,
  type CallToolsSettings,
  type CallToolsTelnyx,
  type StoredCallTools,
} from './call-tools';

export interface CallToolsStatus extends CallToolsSettings {
  defaultConfirmMessage: string;
  defaultTextBackMessage: string;
  /** The tools are on the organization's current assistant, pointing at this server. */
  active: boolean;
  problem: string | null;
}

/** How long a provisioning that matched the assistant is trusted before the database is read again. */
const READY_TTL_MS = 10 * 60_000;

/**
 * The switch and the Telnyx side of the call-outcome tools. On (the default),
 * the organization's assistant gets a bearer integration secret, two webhook
 * tools pointing at this API and a marked prompt section. They are provisioned
 * on the first call that needs them, and again when the assistant or this
 * server's public URL changes. Off removes all of it; the organization's own
 * prompt text is never touched. Only the token's hash is kept here.
 */
@Injectable()
export class CallToolsService {
  private readonly logger = new Logger(CallToolsService.name);
  private readonly publicApiUrl: string;
  private readonly ready = new Map<string, number>();
  /** One provisioning or teardown at a time per organization: two would fight over the same secret identifier. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly creds: TelnyxCredentialsService,
    config: ConfigService<IntegrationEnv, true>,
  ) {
    this.publicApiUrl = (config.get('PUBLIC_API_URL', { infer: true }) ?? '').replace(/\/+$/, '');
  }

  async settings(orgId: string) {
    const row = await this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { callTools: true } });
    return callToolsSettings(row?.callTools);
  }

  /** The hash of the tools' bearer token; the opt-out tool stays on the assistant with the switch off, so it is kept then too. */
  async tokenHash(orgId: string): Promise<string | null> {
    return (await this.settings(orgId)).telnyx?.tokenHash ?? null;
  }

  async status(orgId: string): Promise<CallToolsStatus> {
    const [s, c] = await Promise.all([this.settings(orgId), this.creds.getCreds(orgId).catch(() => null)]);
    const active = !!s.telnyx && this.current(s.telnyx, c?.assistantId, s.enabled);
    const problem = !c?.apiKey || !c.assistantId ? 'Connect Telnyx and create your AI assistant first.' : null;
    const { telnyx: _telnyx, ...settings } = s;
    return { ...settings, defaultConfirmMessage: DEFAULT_CONFIRM_MESSAGE, defaultTextBackMessage: DEFAULT_TEXT_BACK_MESSAGE, active: s.enabled && active, problem };
  }

  /** Turning it on provisions the tools now, so a problem shows here rather than on the next call. */
  async update(orgId: string, patch: Partial<CallToolsSettings>): Promise<CallToolsStatus> {
    const current = await this.settings(orgId);
    const confirmMessage = patch.confirmMessage === undefined ? current.confirmMessage : patch.confirmMessage.trim() || DEFAULT_CONFIRM_MESSAGE;
    const textBackMessage = patch.textBackMessage === undefined ? current.textBackMessage : patch.textBackMessage.trim() || DEFAULT_TEXT_BACK_MESSAGE;
    const next = this.stored({
      enabled: patch.enabled ?? current.enabled,
      confirmSms: patch.confirmSms ?? current.confirmSms,
      confirmMessage,
      retryMinutes: patch.retryMinutes ?? current.retryMinutes,
      retryAttempts: patch.retryAttempts ?? current.retryAttempts,
      textBack: patch.textBack ?? current.textBack,
      textBackMessage,
    });
    await this.serial(orgId, async () => {
      await this.save(orgId, { ...next, telnyx: (await this.settings(orgId)).telnyx });
      // Only switching the tools on or off touches Telnyx; the texts, the retry and the text-back switch live here.
      if (patch.enabled === undefined) return;
      this.ready.delete(orgId);
      // Off keeps the opt-out tool: the assistant is provisioned again with it alone.
      await this.provision(orgId, true);
    });
    return this.status(orgId);
  }

  /** Before a call or chat: makes sure the tools are on the current assistant. Never throws; a failure is logged. */
  async ensure(orgId: string): Promise<void> {
    if ((this.ready.get(orgId) ?? 0) > Date.now()) return;
    await this.serial(orgId, () => this.provision(orgId, false)).catch((error) =>
      this.logger.warn(`call tools for org ${orgId}: ${(error as Error).message}`),
    );
  }

  private serial<T>(orgId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(orgId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    const settled = next.catch(() => undefined);
    this.queues.set(orgId, settled);
    void settled.then(() => {
      if (this.queues.get(orgId) === settled) this.queues.delete(orgId);
    });
    return next;
  }

  /** Provisions afresh unless what is on Telnyx already matches the assistant and this server. */
  private async provision(orgId: string, rethrow: boolean): Promise<void> {
    const s = await this.settings(orgId);
    if (!this.publicApiUrl) return;
    const full = s.enabled;
    const c = await this.creds.getCreds(orgId).catch(() => null);
    if (!c?.apiKey || !c.assistantId) {
      if (rethrow) throw new AppError('CONFLICT', 'Connect Telnyx and create your AI assistant first.');
      return;
    }
    if (s.telnyx && this.current(s.telnyx, c.assistantId, full)) {
      this.ready.set(orgId, Date.now() + READY_TTL_MS);
      return;
    }

    if (s.telnyx) await this.removeFromTelnyx(c.apiKey, s.telnyx);
    // Tools this server attached but never got to record (a save that failed) are still on the
    // assistant, and Telnyx refuses a second tool with the same name.
    await this.removeLeftovers(c.apiKey, c.assistantId);
  
    const identifier = `ep_calltools_${orgId.replace(/-/g, '')}`;
    const token = randomBytes(32).toString('base64url');
    const created: CallToolsTelnyx = {
      tokenHash: sha256Hex(token),
      secretId: '',
      secretIdentifier: identifier,
      toolIds: [],
      assistantId: c.assistantId,
      url: this.publicApiUrl,
      version: CALL_TOOLS_VERSION,
      full,
    };
    try {
      created.secretId = await this.createSecret(c.apiKey, identifier, token);
      for (const def of callToolDefinitions(this.publicApiUrl, identifier, full)) {
        const tool = await telnyx<{ id?: string; data?: { id: string } }>(c.apiKey, '/ai/tools', { method: 'POST', body: JSON.stringify(def) });
        const toolId = tool.id ?? tool.data?.id ?? '';
        created.toolIds.push(toolId);
        await telnyx(c.apiKey, `/ai/assistants/${c.assistantId}/tools/${toolId}`, { method: 'PUT' });
      }
      await this.setPrompt(c.apiKey, c.assistantId, (instructions) => withCallToolsSection(instructions, full));
    } catch (error) {
      await this.removeFromTelnyx(c.apiKey, created);
      await this.save(orgId, { ...this.stored(s), telnyx: null });
      if (rethrow) throw error;
      throw new Error(`provisioning failed: ${(error as Error).message}`);
    }
    await this.save(orgId, { ...this.stored(s), telnyx: created });
    this.ready.set(orgId, Date.now() + READY_TTL_MS);
    this.logger.log(`call tools provisioned for org ${orgId} on assistant ${c.assistantId}`);
  }

  /** What is on Telnyx is for this assistant, this server, these tool definitions and the switch's position. */
  private current(t: CallToolsTelnyx, assistantId: string | undefined, full: boolean): boolean {
    return t.assistantId === assistantId && t.url === this.publicApiUrl && t.version === CALL_TOOLS_VERSION && (t.full ?? true) === full;
  }

  /** A secret left behind by an interrupted provisioning has the same identifier; it is replaced. */
  private async createSecret(apiKey: string, identifier: string, token: string): Promise<string> {
    const create = () =>
      telnyx<{ data?: { id: string } }>(apiKey, '/integration_secrets', { method: 'POST', body: JSON.stringify({ identifier, type: 'bearer', token }) });
    try {
      return (await create()).data?.id ?? '';
    } catch (error) {
      if (!/failed 4(09|22)/.test((error as Error).message)) throw error;
      const list = await telnyx<{ data?: { id: string; identifier: string }[] }>(apiKey, '/integration_secrets?filter[type]=bearer&page[size]=250');
      const stale = list.data?.find((x) => x.identifier === identifier);
      if (!stale) throw error;
      await telnyx(apiKey, `/integration_secrets/${stale.id}`, { method: 'DELETE' });
      return (await create()).data?.id ?? '';
    }
  }

  /** Rewrites the assistant's prompt through `edit`; refuses to write when the current prompt cannot be read. */
  private async setPrompt(apiKey: string, assistantId: string, edit: (instructions: string) => string): Promise<void> {
    const raw = await telnyx<{ data?: { instructions?: unknown }; instructions?: unknown }>(apiKey, `/ai/assistants/${assistantId}`);
    const current = (raw?.data ?? raw)?.instructions;
    if (typeof current !== 'string') throw new AppError('UPSTREAM_ERROR', 'Could not read the assistant prompt from Telnyx; it was left unchanged.');
    const next = edit(current);
    if (next === current) return;
    await telnyx(apiKey, `/ai/assistants/${assistantId}`, { method: 'PATCH', body: JSON.stringify({ instructions: next }) });
  }

  /**
   * Our tools still on the assistant though nothing here records them (a
   * provision that failed half way, a record lost): Telnyx refuses a second
   * webhook tool of the same name, so every provision after would fail too.
   * They come off before the tools are put on again.
   */
  private async removeStrays(apiKey: string, assistantId: string): Promise<void> {
    const quiet = (p: Promise<unknown>) => p.catch((error) => this.logger.warn(`call tools, removing a stray: ${(error as Error).message}`));
    const raw = await telnyx<any>(apiKey, `/ai/assistants/${assistantId}`);
    const tools: any[] = (raw?.data ?? raw)?.tools ?? [];
    for (const t of tools) {
      if (t?.type !== 'webhook' || !t.tool_id || !CALL_TOOL_NAMES.includes(t.webhook?.name ?? t.name)) continue;
      this.logger.warn(`assistant ${assistantId}: removing a stray ${t.webhook?.name ?? t.name} tool (${t.tool_id})`);
      await quiet(telnyx(apiKey, `/ai/assistants/${assistantId}/tools/${t.tool_id}`, { method: 'DELETE' }));
      await quiet(telnyx(apiKey, `/ai/tools/${t.tool_id}`, { method: 'DELETE' }));
    }
  }

  private async removeFromTelnyx(apiKey: string, t: CallToolsTelnyx): Promise<void> {
    const quiet = (p: Promise<unknown>) => p.catch((error) => this.logger.warn(`call tools teardown: ${(error as Error).message}`));
    await quiet(this.setPrompt(apiKey, t.assistantId, withoutCallToolsSection));
    for (const id of t.toolIds.filter(Boolean)) {
      await quiet(telnyx(apiKey, `/ai/assistants/${t.assistantId}/tools/${id}`, { method: 'DELETE' }));
      await quiet(telnyx(apiKey, `/ai/tools/${id}`, { method: 'DELETE' }));
    }
    if (t.secretId) await quiet(telnyx(apiKey, `/integration_secrets/${t.secretId}`, { method: 'DELETE' }));
  }

  /** Our webhook tools on the assistant that the stored provisioning does not know about: detached and deleted. */
  private async removeLeftovers(apiKey: string, assistantId: string): Promise<void> {
    const raw = await telnyx<{ data?: { tools?: unknown }; tools?: unknown }>(apiKey, `/ai/assistants/${assistantId}`);
    // An assistant lists its tools by `tool_id`.
    const tools = ((raw?.data ?? raw)?.tools ?? []) as { id?: string; tool_id?: string; type?: string; webhook?: { url?: string } }[];
    const ours = tools
      .filter((t) => t.type === 'webhook' && isOurToolUrl(t.webhook?.url))
      .map((t) => t.tool_id ?? t.id)
      .filter((id): id is string => !!id);
    if (!ours.length) return;
    const quiet = (p: Promise<unknown>) => p.catch((error) => this.logger.warn(`call tools cleanup: ${(error as Error).message}`));
    for (const id of ours) {
      await quiet(telnyx(apiKey, `/ai/assistants/${assistantId}/tools/${id}`, { method: 'DELETE' }));
      await quiet(telnyx(apiKey, `/ai/tools/${id}`, { method: 'DELETE' }));
    }
    this.logger.log(`removed ${ours.length} leftover call tool(s) from assistant ${assistantId}`);
  }

  /** Every setting, so saving what was provisioned never resets the rest; a default message is not stored. */
  private stored(s: CallToolsSettings): StoredCallTools {
    return {
      enabled: s.enabled,
      confirmSms: s.confirmSms,
      ...(s.confirmMessage === DEFAULT_CONFIRM_MESSAGE ? {} : { confirmMessage: s.confirmMessage }),
      retryMinutes: s.retryMinutes,
      retryAttempts: s.retryAttempts,
      textBack: s.textBack,
      ...(s.textBackMessage === DEFAULT_TEXT_BACK_MESSAGE ? {} : { textBackMessage: s.textBackMessage }),
    };
  }

  private async save(orgId: string, value: StoredCallTools): Promise<void> {
    const callTools = value as unknown as Prisma.InputJsonObject;
    await this.prisma.organizationSetting.upsert({ where: { orgId }, create: { orgId, callTools }, update: { callTools } });
  }
}

/** A tool pointing at our outcome endpoints, on any host this server was ever reachable at (an old tunnel too). */
function isOurToolUrl(url: string | undefined): boolean {
  return !!url && /\/tools\/telnyx\/outcome\/(callback|text|record)$/.test(url);
}
