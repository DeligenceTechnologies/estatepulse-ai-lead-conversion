import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationProvider, IntegrationStatus } from '@prisma/client';
import { withBookingSection } from '@/calendar/booking/booking-prompt';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import type { IntegrationEnv } from '@/common/utils/interface';
import { DEFAULT_TEMPLATE, RECORDING_NOTICE } from '@/telnyx/assistant.service';
import { CallSlots } from '@/telnyx/calls/call-slots';
import { DEFAULT_CALL_LIMIT } from '@/telnyx/calls/call.types';
import { callToolsSettings, withCallToolsSection } from '@/telnyx/tools/call-tools';
import { POST_CALL_ANALYSIS_DATA } from './retell-analysis';
import { editRetellLlm, retell, storageFor, type RetellLlmTool } from './retell-api';
import { RetellCredentialsService, type RetellCreds } from './retell-credentials.service';
import { retellEnabled } from './retell-enabled.guard';
import { RetellSmsService, WEBHOOK_PATH } from './retell-sms.service';
import { OUR_RETELL_TOOLS, isOurRetellTool } from './retell-tools';
import { RetellToolsService } from './retell-tools.service';

/** A JSON object of string values, anything else dropped. */
function stringMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>)
      .filter(([k, v]) => k.trim() && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'))
      .map(([k, v]) => [k.trim(), String(v)]),
  );
}

/** A tool as the settings page shows it: ours without their secrets (the bearer token in their headers), the organization's as they are. */
function toolView(t: RetellLlmTool): RetellToolView {
  const base = { type: String(t.type ?? ''), name: String(t.name ?? ''), ...(typeof t.description === 'string' ? { description: t.description } : {}) };
  if (isOurRetellTool(t)) return { ...base, ...(typeof t.url === 'string' ? { url: t.url } : {}), managed: true };
  return { ...t, ...base, managed: false } as RetellToolView;
}

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** One of the organization's tools, checked field by field; anything else is refused with what is wrong. */
function sanitizeTool(raw: unknown): RetellLlmTool & { name: string } {
  const t = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const type = String(t.type ?? '');
  const name = String(t.name ?? '').trim();
  if (!TOOL_NAME.test(name)) throw new AppError('VALIDATION_ERROR', 'Each tool needs a name of letters, numbers, hyphens or underscores (up to 64).');
  const description = typeof t.description === 'string' ? t.description.slice(0, 2000) : undefined;
  const common = { type, name, ...(description ? { description } : {}) };
  if (type === 'end_call' || type === 'press_digit') return common;
  if (type === 'custom') {
    const url = String(t.url ?? '').trim();
    if (!/^https?:\/\/\S+$/.test(url)) throw new AppError('VALIDATION_ERROR', `Tool “${name}” needs an http(s) URL.`);
    const method = String(t.method ?? 'POST').toUpperCase();
    if (!METHODS.has(method)) throw new AppError('VALIDATION_ERROR', `Tool “${name}”: unknown method ${method}.`);
    const parameters = t.parameters && typeof t.parameters === 'object' && !Array.isArray(t.parameters) ? t.parameters : undefined;
    const timeout = typeof t.timeout_ms === 'number' && t.timeout_ms >= 1000 && t.timeout_ms <= 600_000 ? Math.round(t.timeout_ms) : undefined;
    return { ...common, url, method, headers: stringMap(t.headers), ...(parameters ? { parameters } : {}), ...(timeout ? { timeout_ms: timeout } : {}) };
  }
  if (type === 'transfer_call') {
    const d = (t.transfer_destination ?? {}) as Record<string, unknown>;
    const destination =
      d.type === 'inferred' && typeof d.prompt === 'string' && d.prompt.trim()
        ? { type: 'inferred', prompt: d.prompt.trim().slice(0, 2000) }
        : typeof d.number === 'string' && /^\+[1-9][0-9]{6,14}$/.test(d.number.trim())
          ? { type: 'predefined', number: d.number.trim() }
          : null;
    if (!destination) throw new AppError('VALIDATION_ERROR', `Tool “${name}” needs a number to transfer to, in E.164 format (e.g. +12025550123).`);
    const o = (t.transfer_option ?? {}) as Record<string, unknown>;
    const option = o.type === 'warm_transfer' ? { type: 'warm_transfer' } : { type: 'cold_transfer' };
    return { ...common, transfer_destination: destination, transfer_option: option };
  }
  throw new AppError('VALIDATION_ERROR', `Tool “${name}”: “${type}” is not a kind this page can add. Build it in the Retell dashboard.`);
}

/** Telnyx's default call length (1800 s), so an organization that switches keeps the same ceiling. */
const DEFAULT_MAX_CALL_MS = 1_800_000;

const END_CALL_TOOL = {
  type: 'end_call',
  name: 'end_call',
  description: 'End the call. Use it right after saying goodbye: once the conversation is complete, the caller is not interested, or the caller asks to end the call.',
};

/** A tool on the agent's Retell LLM. One of ours (booking, callbacks, outcomes) is shown without its secrets and cannot be edited here. */
export interface RetellToolView {
  type: string;
  name: string;
  description?: string;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  parameters?: unknown;
  transfer_destination?: unknown;
  transfer_option?: unknown;
  timeout_ms?: number;
  managed: boolean;
}

export interface RetellAgentView {
  agentId: string;
  llmId: string;
  name: string;
  prompt: string;
  greeting: string;
  voiceId: string;
  language: string;
  maxCallSeconds: number;
  voicemailHangup: boolean;
  recordCalls: boolean;
  /** Retell analyses each finished call (summary, our qualification fields) and sends call_analyzed. */
  postCallProcessing: boolean;
  /** The LLM's default dynamic variables: {{key}} in the prompt when a call does not supply the key. */
  dynamicVariables: Record<string, string>;
  tools: RetellToolView[];
}

export interface RetellAgentPatch {
  name?: string;
  prompt?: string;
  postCallProcessing?: boolean;
  dynamicVariables?: Record<string, string>;
  greeting?: string;
  voiceId?: string;
  language?: string;
  maxCallSeconds?: number;
  voicemailHangup?: boolean;
  recordCalls?: boolean;
}

/**
 * The organization's Retell workspace through its own API key: the agent
 * (a Retell LLM for the prompt plus a voice agent), voices, phone numbers and
 * concurrency. The SMS agent is RetellSmsService's; the callback and outcome
 * tools on both agents are RetellToolsService's. Everything that names this
 * server's address (webhooks, tool URLs) is pointed at it again on start-up
 * and whenever the agent is saved, so a new domain or tunnel needs no re-setup.
 */
@Injectable()
export class RetellAccountService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RetellAccountService.name);
  private readonly publicUrl: string;
  private readonly retellOn: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly creds: RetellCredentialsService,
    config: ConfigService<IntegrationEnv, true>,
    private readonly slots: CallSlots,
    private readonly tools: RetellToolsService,
    private readonly sms: RetellSmsService,
  ) {
    this.publicUrl = (config.get('PUBLIC_API_URL', { infer: true }) ?? '').replace(/\/+$/, '');
    this.retellOn = retellEnabled(config);
  }

  /** The server's address can change (a new deploy domain, a dev tunnel): every Retell org's webhooks and tools keep reaching it. */
  onApplicationBootstrap(): void {
    if (this.retellOn && this.publicUrl) void this.refreshAllUrls();
  }

  async refreshAllUrls(): Promise<void> {
    const rows = await this.prisma.integration
      .findMany({ where: { provider: IntegrationProvider.retell, status: IntegrationStatus.active, revokedAt: null }, select: { orgId: true } })
      .catch((error) => {
        this.logger.warn(`Retell URL check: ${(error as Error).message}`);
        return [];
      });
    for (const { orgId } of rows) {
      await this.ensureUrls(orgId).catch((error) => this.logger.warn(`Retell URLs for org ${orgId}: ${(error as Error).message}`));
    }
  }

  /**
   * Points the agent's webhook, the SMS agent's webhook, the number's inbound
   * SMS webhook and our tools' URLs at this server. Idempotent: nothing is
   * written where the address already matches.
   */
  async ensureUrls(orgId: string): Promise<void> {
    if (!this.publicUrl) return;
    const c = await this.creds.getCreds(orgId);
    if (!c?.apiKey) return;
    if (c.agentId) {
      const agent = await retell<{ webhook_url?: string | null }>(c.apiKey, `/get-agent/${c.agentId}`);
      const wanted = `${this.publicUrl}${WEBHOOK_PATH}`;
      if ((agent.webhook_url ?? '') !== wanted) {
        await retell(c.apiKey, `/update-agent/${c.agentId}`, { method: 'PATCH', body: JSON.stringify({ webhook_url: wanted }) });
        this.logger.log(`Retell agent ${c.agentId}: webhook moved to ${wanted}`);
      }
    }
    await this.tools.refreshUrls(c);
    await this.sms.refreshUrls(c);
  }

  /**
   * Both keys must belong to one workspace: the API key places calls, the
   * webhook key proves Retell's deliveries. On first connect both are given;
   * later either one alone replaces just that key, checked against the one on
   * file.
   */
  async verifyKeys(orgId: string, patch: { apiKey?: string; webhookKey?: string }): Promise<{ workspace: string }> {
    const current = await this.creds.getCreds(orgId);
    const apiKey = patch.apiKey || current?.apiKey || '';
    const webhookKey = patch.webhookKey || current?.webhookKey || '';
    if (!patch.apiKey && !patch.webhookKey) throw new AppError('VALIDATION_ERROR', 'Enter the API key, the webhook key, or both.');
    if (!apiKey || !webhookKey) throw new AppError('VALIDATION_ERROR', 'Both the API key and the webhook key are needed to connect Retell.');
    const info = async (key: string, which: string) => {
      try {
        return await retell<{ org_id?: string; org_name?: string }>(key, '/get-api-key-info');
      } catch (error) {
        if (/failed 40[13]:/.test((error as Error).message)) throw new AppError('VALIDATION_ERROR', `Retell rejected the ${which} — check it and try again.`);
        throw error;
      }
    };
    const [api, hook] = await Promise.all([info(apiKey, 'API key'), info(webhookKey, 'webhook key')]);
    if (api.org_id && hook.org_id && api.org_id !== hook.org_id) {
      throw new AppError('VALIDATION_ERROR', 'The API key and the webhook key belong to different Retell workspaces.');
    }
    return { workspace: api.org_name ?? '' };
  }

  /** The voice agents on the workspace; `current` marks the one the organization uses. */
  async listAgents(orgId: string): Promise<{ agentId: string; name: string; current: boolean }[]> {
    const c = await this.requireCreds(orgId);
    type Item = { agent_id: string; agent_name?: string; channel?: string; is_suspended?: boolean };
    const { items = [] } = await retell<{ items?: Item[] }>(c.apiKey, '/v2/list-agents?limit=200', { method: 'POST', body: JSON.stringify({}) });
    return items
      .filter((a) => a && typeof a.agent_id === 'string' && a.channel !== 'chat' && !a.is_suspended)
      .map((a) => ({ agentId: a.agent_id, name: a.agent_name || a.agent_id, current: a.agent_id === c.agentId }));
  }

  /**
   * An agent built in the Retell dashboard becomes the organization's: it must
   * run on a Retell LLM (the app edits that LLM's prompt and puts its tools on
   * it), and it is pointed at our webhook and asked for our analysis fields.
   * Its prompt, voice and the rest are left as they are.
   */
  async useAgent(orgId: string, agentId: string): Promise<RetellAgentView> {
    const c = await this.requireCreds(orgId);
    if (!this.publicUrl) throw new AppError('CONFLICT', 'PUBLIC_API_URL is not configured on the server, so Retell could not reach us.');
    const agent = await retell<{ agent_id?: string; response_engine?: { type?: string; llm_id?: string } }>(c.apiKey, `/get-agent/${encodeURIComponent(agentId)}`);
    const engine = agent.response_engine;
    if (engine?.type !== 'retell-llm' || !engine.llm_id) {
      throw new AppError('VALIDATION_ERROR', 'That agent does not run on a Retell LLM (single prompt). EstatePulse can only use single-prompt agents, whose prompt it edits here.');
    }
    if (agentId === c.agentId) return (await this.getAgent(orgId))!;
    await retell(c.apiKey, `/update-agent/${encodeURIComponent(agentId)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        webhook_url: `${this.publicUrl}${WEBHOOK_PATH}`,
        webhook_events: ['call_started', 'call_ended', 'call_analyzed'],
        post_call_analysis_data: POST_CALL_ANALYSIS_DATA,
        enable_dnc_detection: true,
        data_storage_setting: storageFor(await this.recordsCalls(orgId)),
      }),
    });
    await this.creds.save(orgId, { agentId, llmId: engine.llm_id });
    await this.tools.provisionNow(orgId).catch((error) => this.logger.warn(`Retell call tools for org ${orgId}: ${(error as Error).message}`));
    if (c.fromNumber) await this.routeNumber(c.apiKey, c.fromNumber, agentId).catch((error) => this.logger.warn(`routing ${c.fromNumber} to agent ${agentId}: ${(error as Error).message}`));
    this.logger.log(`org ${orgId} now uses Retell agent ${agentId} (LLM ${engine.llm_id})`);
    return (await this.getAgent(orgId))!;
  }

  async listVoices(orgId: string) {
    const c = await this.requireCreds(orgId);
    const voices = await retell<{ voice_id: string; voice_name?: string; provider?: string; gender?: string; accent?: string; preview_audio_url?: string }[]>(
      c.apiKey,
      '/list-voices',
    );
    return (
      voices
        // xAI voices work only with xAI speech-to-speech models; our agent runs on a Retell LLM, which refuses them.
        .filter((v) => v.provider !== 'xai')
        .map((v) => ({ id: v.voice_id, name: v.voice_name ?? v.voice_id, provider: v.provider ?? '', gender: v.gender ?? '', accent: v.accent ?? '', previewUrl: v.preview_audio_url ?? '' }))
    );
  }

  /** Creates the Retell LLM and the voice agent on it, and keeps their ids. Replaces nothing that exists. */
  async createAgent(orgId: string, input: { name?: string; voiceId?: string; language?: string }): Promise<RetellAgentView> {
    const c = await this.requireCreds(orgId);
    if (c.agentId) throw new AppError('CONFLICT', 'This Retell account already has an agent.');
    if (!this.publicUrl) throw new AppError('CONFLICT', 'PUBLIC_API_URL is not configured on the server, so Retell could not reach us.');
    const voiceId = input.voiceId || (await this.listVoices(orgId))[0]?.id;
    if (!voiceId) throw new AppError('CONFLICT', 'No Retell voice is available on this workspace.');
    const record = await this.recordsCalls(orgId);

    const llm = await retell<{ llm_id: string }>(c.apiKey, '/create-retell-llm', {
      method: 'POST',
      body: JSON.stringify({
        general_prompt: await this.withBooking(orgId, DEFAULT_TEMPLATE.instructions),
        begin_message: await this.greetingFor(orgId, DEFAULT_TEMPLATE.greeting),
        start_speaker: 'agent',
        general_tools: [END_CALL_TOOL],
      }),
    });
    let agent: { agent_id: string };
    try {
      agent = await retell<{ agent_id: string }>(c.apiKey, '/create-agent', {
        method: 'POST',
        body: JSON.stringify({
          agent_name: input.name?.trim() || DEFAULT_TEMPLATE.name,
          response_engine: { type: 'retell-llm', llm_id: llm.llm_id },
          voice_id: voiceId,
          language: input.language || 'en-US',
          webhook_url: `${this.publicUrl}/webhooks/retell`,
          webhook_events: ['call_started', 'call_ended', 'call_analyzed'],
          post_call_analysis_data: POST_CALL_ANALYSIS_DATA,
          voicemail_option: { action: { type: 'hangup' } },
          enable_dnc_detection: true,
          data_storage_setting: storageFor(record),
          max_call_duration_ms: DEFAULT_MAX_CALL_MS,
        }),
      });
    } catch (error) {
      await retell(c.apiKey, `/delete-retell-llm/${llm.llm_id}`, { method: 'DELETE' }).catch(() => undefined);
      throw error;
    }
    await this.creds.save(orgId, { agentId: agent.agent_id, llmId: llm.llm_id });
    // The callback and outcome tools go on the new LLM now; a failure here is retried before the first call.
    await this.tools.provisionNow(orgId).catch((error) => this.logger.warn(`Retell call tools for org ${orgId}: ${(error as Error).message}`));
    if (c.fromNumber) await this.routeNumber(c.apiKey, c.fromNumber, agent.agent_id).catch((error) => this.logger.warn(`routing ${c.fromNumber} to the new agent: ${(error as Error).message}`));
    return this.getAgent(orgId) as Promise<RetellAgentView>;
  }

  async getAgent(orgId: string): Promise<RetellAgentView | null> {
    const c = await this.creds.getCreds(orgId);
    if (!c?.apiKey || !c.agentId) return null;
    const [agent, llm, record] = await Promise.all([
      retell<any>(c.apiKey, `/get-agent/${c.agentId}`),
      retell<any>(c.apiKey, `/get-retell-llm/${c.llmId}`),
      this.recordsCalls(orgId),
    ]);
    const events: string[] = Array.isArray(agent.webhook_events) ? agent.webhook_events : [];
    return {
      agentId: c.agentId,
      llmId: c.llmId,
      name: agent.agent_name ?? '',
      prompt: llm.general_prompt ?? '',
      greeting: llm.begin_message ?? '',
      voiceId: agent.voice_id ?? '',
      language: Array.isArray(agent.language) ? agent.language.join(',') : (agent.language ?? 'en-US'),
      maxCallSeconds: Math.round((agent.max_call_duration_ms ?? DEFAULT_MAX_CALL_MS) / 1000),
      voicemailHangup: agent.voicemail_option?.action?.type === 'hangup',
      recordCalls: record,
      postCallProcessing: events.includes('call_analyzed') && Array.isArray(agent.post_call_analysis_data) && agent.post_call_analysis_data.length > 0,
      dynamicVariables: stringMap(llm.default_dynamic_variables),
      tools: ((llm.general_tools ?? []) as RetellLlmTool[]).map(toolView),
    };
  }

  /**
   * Replaces the agent's own tools on its LLM. Ours (booking, callbacks,
   * outcomes) stay as they are and cannot be named by the organization's.
   * Only the tool kinds the editor offers are accepted, each checked here so
   * nothing malformed reaches Retell.
   */
  async setTools(orgId: string, tools: unknown[]): Promise<RetellAgentView> {
    const c = await this.requireAgent(orgId);
    const own = tools.map(sanitizeTool);
    const names = new Set<string>();
    for (const t of own) {
      if (OUR_RETELL_TOOLS.has(t.name)) throw new AppError('VALIDATION_ERROR', `“${t.name}” is a tool EstatePulse manages; choose another name.`);
      if (names.has(t.name)) throw new AppError('VALIDATION_ERROR', `Two tools are named “${t.name}”; names must be unique.`);
      names.add(t.name);
    }
    await editRetellLlm(c.apiKey, c.llmId, (current) => ({ general_tools: [...current.filter(isOurRetellTool), ...own] }));
    return (await this.getAgent(orgId))!;
  }

  async updateAgent(orgId: string, patch: RetellAgentPatch): Promise<RetellAgentView> {
    const c = await this.requireAgent(orgId);
    const llm: Record<string, unknown> = {};
    if (patch.prompt != null) llm.general_prompt = await this.withCallTools(orgId, c.llmId, await this.withBooking(orgId, patch.prompt));
    if (patch.greeting != null) llm.begin_message = patch.greeting;
    if (patch.dynamicVariables != null) llm.default_dynamic_variables = stringMap(patch.dynamicVariables);
    if (Object.keys(llm).length) await retell(c.apiKey, `/update-retell-llm/${c.llmId}`, { method: 'PATCH', body: JSON.stringify(llm) });

    const agent: Record<string, unknown> = {};
    if (patch.name != null && patch.name.trim()) agent.agent_name = patch.name.trim();
    if (patch.postCallProcessing != null) {
      // Off: Retell neither analyses the call nor sends call_analyzed, so nothing is scored; on: our fields and the event come back.
      agent.webhook_events = patch.postCallProcessing ? ['call_started', 'call_ended', 'call_analyzed'] : ['call_started', 'call_ended'];
      agent.post_call_analysis_data = patch.postCallProcessing ? POST_CALL_ANALYSIS_DATA : [];
    }
    if (patch.voiceId != null) agent.voice_id = patch.voiceId;
    if (patch.language != null) agent.language = patch.language;
    if (patch.maxCallSeconds != null) agent.max_call_duration_ms = Math.round(patch.maxCallSeconds * 1000);
    if (patch.voicemailHangup != null) agent.voicemail_option = patch.voicemailHangup ? { action: { type: 'hangup' } } : null;
    if (patch.recordCalls != null) agent.data_storage_setting = storageFor(patch.recordCalls);
    if (Object.keys(agent).length) await retell(c.apiKey, `/update-agent/${c.agentId}`, { method: 'PATCH', body: JSON.stringify(agent) });

    if (patch.recordCalls != null) {
      await this.sms.setDataStorage(c, patch.recordCalls).catch((error) => this.logger.warn(`Retell SMS agent storage for org ${orgId}: ${(error as Error).message}`));
      await this.prisma.organizationSetting.upsert({
        where: { orgId },
        create: { orgId, callRecordingEnabled: patch.recordCalls },
        update: { callRecordingEnabled: patch.recordCalls },
      });
    }
    // A save is the moment to make sure everything still points at this server (a tunnel may have changed).
    await this.ensureUrls(orgId).catch((error) => this.logger.warn(`Retell URLs for org ${orgId}: ${(error as Error).message}`));
    return (await this.getAgent(orgId))!;
  }

  async listNumbers(orgId: string) {
    const c = await this.requireCreds(orgId);
    const res = await retell<{ items?: any[] } | any[]>(c.apiKey, '/v2/list-phone-numbers?limit=1000');
    const items = Array.isArray(res) ? res : (res.items ?? []);
    return items.map((n) => ({
      phoneNumber: String(n.phone_number),
      type: String(n.phone_number_type ?? ''),
      nickname: n.nickname ?? '',
      routedToAgent: ((n.outbound_agents ?? []) as { agent_id?: string }[]).some((a) => a.agent_id === c.agentId),
      fromNumber: n.phone_number === c.fromNumber,
    }));
  }

  /** Buys a Retell number (US or Canada), routed to the organization's agent once there is one. */
  async buyNumber(orgId: string, input: { areaCode?: number; countryCode?: 'US' | 'CA'; tollFree?: boolean }) {
    const c = await this.requireCreds(orgId);
    const n = await retell<{ phone_number: string }>(c.apiKey, '/create-phone-number', {
      method: 'POST',
      body: JSON.stringify({
        ...(input.areaCode ? { area_code: input.areaCode } : {}),
        country_code: input.countryCode ?? 'US',
        ...(input.tollFree ? { toll_free: true } : {}),
        nickname: 'EstatePulse',
        ...(c.agentId ? { outbound_agents: [{ agent_id: c.agentId, weight: 1 }] } : {}),
      }),
    });
    return { phoneNumber: n.phone_number };
  }

  /** Brings a number from the organization's own SIP trunk, Telnyx included: under Retell, Telnyx is only the carrier. */
  async importNumber(orgId: string, input: { phoneNumber: string; terminationUri: string; username?: string; password?: string }) {
    const c = await this.requireCreds(orgId);
    const n = await retell<{ phone_number: string }>(c.apiKey, '/import-phone-number', {
      method: 'POST',
      body: JSON.stringify({
        phone_number: input.phoneNumber,
        termination_uri: input.terminationUri,
        ...(input.username ? { sip_trunk_auth_username: input.username } : {}),
        ...(input.password ? { sip_trunk_auth_password: input.password } : {}),
        nickname: 'EstatePulse',
        ...(c.agentId ? { outbound_agents: [{ agent_id: c.agentId, weight: 1 }] } : {}),
      }),
    });
    return { phoneNumber: n.phone_number };
  }

  /**
   * Makes the number the one every call comes from, routed to the agent once
   * there is one: the number may be chosen before the agent is created, and
   * the agent is routed to it when it appears.
   */
  async assignNumber(orgId: string, phoneNumber: string) {
    const c = await this.requireCreds(orgId);
    if (c.agentId) await this.routeNumber(c.apiKey, phoneNumber, c.agentId);
    await this.creds.save(orgId, { fromNumber: phoneNumber });
    return { phoneNumber };
  }

  private async routeNumber(apiKey: string, phoneNumber: string, agentId: string): Promise<void> {
    await retell(apiKey, `/update-phone-number/${encodeURIComponent(phoneNumber)}`, {
      method: 'PATCH',
      body: JSON.stringify({ outbound_agents: [{ agent_id: agentId, weight: 1 }] }),
    });
  }

  async concurrency(orgId: string): Promise<{ inUse: number | null; limit: number | null }> {
    const c = await this.requireCreds(orgId);
    const res = await retell<{ current_concurrency?: number; concurrency_limit?: number }>(c.apiKey, '/get-concurrency');
    return { inUse: res.current_concurrency ?? null, limit: res.concurrency_limit ?? null };
  }

  /**
   * The app's own call limit (the call worker's Redis slots) beside Retell's
   * workspace limit. Retell's cannot be set through its API, so only ours is
   * saved, and never above Retell's.
   */
  async callCapacity(orgId: string): Promise<{ appLimit: number; retellLimit: number | null; inUse: number; retellError: string | null }> {
    const [settings, inUse, retellSide] = await Promise.all([
      this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { maxConcurrentCalls: true } }),
      this.slots.inUse(orgId).catch(() => 0),
      this.concurrency(orgId).then(
        (r) => ({ limit: r.limit, error: null as string | null }),
        (e: Error) => ({ limit: null, error: e.message }),
      ),
    ]);
    return { appLimit: settings?.maxConcurrentCalls ?? DEFAULT_CALL_LIMIT, retellLimit: retellSide.limit, inUse, retellError: retellSide.error };
  }

  async setCallCapacity(orgId: string, limit: number) {
    const { limit: retellLimit } = await this.concurrency(orgId);
    if (retellLimit != null && limit > retellLimit) {
      throw new AppError('VALIDATION_ERROR', `Your Retell workspace allows ${retellLimit} concurrent calls. Buy more concurrency in the Retell dashboard first.`, [
        { path: 'maxConcurrentCalls', message: `At most ${retellLimit}.` },
      ]);
    }
    await this.prisma.organizationSetting.upsert({ where: { orgId }, create: { orgId, maxConcurrentCalls: limit }, update: { maxConcurrentCalls: limit } });
    return this.callCapacity(orgId);
  }

  private async requireCreds(orgId: string): Promise<RetellCreds> {
    const c = await this.creds.getCreds(orgId);
    if (!c?.apiKey) throw new AppError('CONFLICT', 'Connect a Retell account first.');
    return c;
  }

  private async requireAgent(orgId: string): Promise<RetellCreds> {
    const c = await this.requireCreds(orgId);
    if (!c.agentId || !c.llmId) throw new AppError('CONFLICT', 'Create the Retell agent first.');
    return c;
  }

  private async recordsCalls(orgId: string): Promise<boolean> {
    const s = await this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { callRecordingEnabled: true } }).catch(() => null);
    return s?.callRecordingEnabled ?? true;
  }

  private async greetingFor(orgId: string, base: string): Promise<string> {
    const s = await this.prisma.organizationSetting
      .findUnique({ where: { orgId }, select: { callRecordingEnabled: true, callRecordingAnnounce: true } })
      .catch(() => null);
    return s?.callRecordingEnabled && s.callRecordingAnnounce ? `${RECORDING_NOTICE} ${base}` : base;
  }

  /** Keeps the callbacks-and-outcomes section on a prompt whose LLM carries those tools, as the prompt text is replaced. */
  private async withCallTools(orgId: string, llmId: string, prompt: string): Promise<string> {
    const row = await this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { callTools: true } }).catch(() => null);
    const provisioned = ((row?.callTools ?? null) as { retell?: { llmIds?: string[] } } | null)?.retell?.llmIds ?? [];
    return callToolsSettings(row?.callTools).enabled && provisioned.includes(llmId) ? withCallToolsSection(prompt) : prompt;
  }

  /** Keeps in-call booking's marked prompt section, when booking is set up on Retell, as the prompt text is replaced. */
  private async withBooking(orgId: string, prompt: string): Promise<string> {
    const s = await this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { inCallBooking: true } }).catch(() => null);
    const cfg = (s?.inCallBooking ?? null) as { provider?: string; eventTypeName?: string; durationMinutes?: number } | null;
    return cfg?.provider === 'retell' && cfg.eventTypeName && cfg.durationMinutes ? withBookingSection(prompt, cfg.eventTypeName, cfg.durationMinutes) : prompt;
  }
}
