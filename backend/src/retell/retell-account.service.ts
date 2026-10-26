import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { withBookingSection } from '@/calendar/booking/booking-prompt';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import type { IntegrationEnv } from '@/common/utils/interface';
import { DEFAULT_TEMPLATE, RECORDING_NOTICE } from '@/telnyx/assistant.service';
import { CallSlots } from '@/telnyx/calls/call-slots';
import { DEFAULT_CALL_LIMIT } from '@/telnyx/calls/call.types';
import { POST_CALL_ANALYSIS_DATA } from './retell-analysis';
import { retell } from './retell-api';
import { RetellCredentialsService, type RetellCreds } from './retell-credentials.service';

/** Telnyx's default call length (1800 s), so an organization that switches keeps the same ceiling. */
const DEFAULT_MAX_CALL_MS = 1_800_000;

const END_CALL_TOOL = {
  type: 'end_call',
  name: 'end_call',
  description: 'End the call. Use it right after saying goodbye: once the conversation is complete, the caller is not interested, or the caller asks to end the call.',
};

export interface RetellAgentView {
  agentId: string;
  llmId: string;
  prompt: string;
  greeting: string;
  voiceId: string;
  language: string;
  maxCallSeconds: number;
  voicemailHangup: boolean;
  recordCalls: boolean;
}

export interface RetellAgentPatch {
  prompt?: string;
  greeting?: string;
  voiceId?: string;
  language?: string;
  maxCallSeconds?: number;
  voicemailHangup?: boolean;
  recordCalls?: boolean;
}

/** Recording off = Retell keeps no transcript or recording either, only what scoring needs. */
const storageFor = (record: boolean) => (record ? 'everything' : 'basic_attributes_only');

/**
 * The organization's Retell workspace through its own API key: the agent
 * (a Retell LLM for the prompt plus a voice agent), voices, phone numbers and
 * concurrency. Retell is voice only here, so nothing touches SMS.
 */
@Injectable()
export class RetellAccountService {
  private readonly publicUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly creds: RetellCredentialsService,
    config: ConfigService<IntegrationEnv, true>,
    private readonly slots: CallSlots,
  ) {
    this.publicUrl = (config.get('PUBLIC_API_URL', { infer: true }) ?? '').replace(/\/+$/, '');
  }

  /** Both keys must belong to one workspace: the API key places calls, the webhook key proves Retell's deliveries. */
  async verifyKeys(apiKey: string, webhookKey: string): Promise<{ workspace: string }> {
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
  async createAgent(orgId: string, input: { voiceId?: string; language?: string }): Promise<RetellAgentView> {
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
          agent_name: DEFAULT_TEMPLATE.name,
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
    return {
      agentId: c.agentId,
      llmId: c.llmId,
      prompt: llm.general_prompt ?? '',
      greeting: llm.begin_message ?? '',
      voiceId: agent.voice_id ?? '',
      language: Array.isArray(agent.language) ? agent.language.join(',') : (agent.language ?? 'en-US'),
      maxCallSeconds: Math.round((agent.max_call_duration_ms ?? DEFAULT_MAX_CALL_MS) / 1000),
      voicemailHangup: agent.voicemail_option?.action?.type === 'hangup',
      recordCalls: record,
    };
  }

  async updateAgent(orgId: string, patch: RetellAgentPatch): Promise<RetellAgentView> {
    const c = await this.requireAgent(orgId);
    const llm: Record<string, unknown> = {};
    if (patch.prompt != null) llm.general_prompt = await this.withBooking(orgId, patch.prompt);
    if (patch.greeting != null) llm.begin_message = patch.greeting;
    if (Object.keys(llm).length) await retell(c.apiKey, `/update-retell-llm/${c.llmId}`, { method: 'PATCH', body: JSON.stringify(llm) });

    const agent: Record<string, unknown> = {};
    if (patch.voiceId != null) agent.voice_id = patch.voiceId;
    if (patch.language != null) agent.language = patch.language;
    if (patch.maxCallSeconds != null) agent.max_call_duration_ms = Math.round(patch.maxCallSeconds * 1000);
    if (patch.voicemailHangup != null) agent.voicemail_option = patch.voicemailHangup ? { action: { type: 'hangup' } } : null;
    if (patch.recordCalls != null) agent.data_storage_setting = storageFor(patch.recordCalls);
    if (Object.keys(agent).length) await retell(c.apiKey, `/update-agent/${c.agentId}`, { method: 'PATCH', body: JSON.stringify(agent) });

    if (patch.recordCalls != null) {
      await this.prisma.organizationSetting.upsert({
        where: { orgId },
        create: { orgId, callRecordingEnabled: patch.recordCalls },
        update: { callRecordingEnabled: patch.recordCalls },
      });
    }
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

  /** Buys a Retell number (US or Canada) already routed to the organization's agent. */
  async buyNumber(orgId: string, input: { areaCode?: number; countryCode?: 'US' | 'CA'; tollFree?: boolean }) {
    const c = await this.requireAgent(orgId);
    const n = await retell<{ phone_number: string }>(c.apiKey, '/create-phone-number', {
      method: 'POST',
      body: JSON.stringify({
        ...(input.areaCode ? { area_code: input.areaCode } : {}),
        country_code: input.countryCode ?? 'US',
        ...(input.tollFree ? { toll_free: true } : {}),
        nickname: 'EstatePulse',
        outbound_agents: [{ agent_id: c.agentId, weight: 1 }],
      }),
    });
    return { phoneNumber: n.phone_number };
  }

  /** Brings a number from the organization's own SIP trunk. Telnyx trunks are refused: an organization uses Telnyx or Retell, not both. */
  async importNumber(orgId: string, input: { phoneNumber: string; terminationUri: string; username?: string; password?: string }) {
    if (/telnyx/i.test(input.terminationUri)) {
      throw new AppError('VALIDATION_ERROR', 'Telnyx numbers cannot be imported into Retell: an organization calls through Telnyx or Retell, not both.');
    }
    const c = await this.requireAgent(orgId);
    const n = await retell<{ phone_number: string }>(c.apiKey, '/import-phone-number', {
      method: 'POST',
      body: JSON.stringify({
        phone_number: input.phoneNumber,
        termination_uri: input.terminationUri,
        ...(input.username ? { sip_trunk_auth_username: input.username } : {}),
        ...(input.password ? { sip_trunk_auth_password: input.password } : {}),
        nickname: 'EstatePulse',
        outbound_agents: [{ agent_id: c.agentId, weight: 1 }],
      }),
    });
    return { phoneNumber: n.phone_number };
  }

  /** Routes the number's outbound calls to the agent and makes it the number every call comes from. */
  async assignNumber(orgId: string, phoneNumber: string) {
    const c = await this.requireAgent(orgId);
    await retell(c.apiKey, `/update-phone-number/${encodeURIComponent(phoneNumber)}`, {
      method: 'PATCH',
      body: JSON.stringify({ outbound_agents: [{ agent_id: c.agentId, weight: 1 }] }),
    });
    await this.creds.save(orgId, { fromNumber: phoneNumber });
    return { phoneNumber };
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

  /** Keeps in-call booking's marked prompt section, when booking is set up on Retell, as the prompt text is replaced. */
  private async withBooking(orgId: string, prompt: string): Promise<string> {
    const s = await this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { inCallBooking: true } }).catch(() => null);
    const cfg = (s?.inCallBooking ?? null) as { provider?: string; eventTypeName?: string; durationMinutes?: number } | null;
    return cfg?.provider === 'retell' && cfg.eventTypeName && cfg.durationMinutes ? withBookingSection(prompt, cfg.eventTypeName, cfg.durationMinutes) : prompt;
  }
}
