import { Injectable, Logger } from '@nestjs/common';
import { withBookingSection } from '@/calendar/booking/booking-prompt';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { TelnyxCredentialsService, type TelnyxCreds } from './telnyx-credentials.service';

const BASE = 'https://api.telnyx.com/v2/ai/assistants';

const authHeaders = (apiKey: string) => ({ Authorization: `Bearer ${apiKey}` });

function shape(a: any) {
  const vs = a.voice_settings ?? {};
  const ts = a.telephony_settings ?? {};
  const is = a.interruption_settings ?? {};
  const tr = a.transcription ?? {};
  const trs = tr.settings ?? {};
  const ms = a.messaging_settings ?? {};
  const vm = ts.voicemail_detection ?? {};
  return {
    id: a.id,
    name: a.name,
    model: a.model,
    description: a.description ?? '',
    instructions: a.instructions ?? '',
    greeting: a.greeting ?? '',
    voice: vs.voice ?? '',
    voice_speed: vs.voice_speed ?? 1,
    background_audio: vs.background_audio?.value ?? 'silence',
    similarity_boost: vs.similarity_boost ?? 0.5,
    style: vs.style ?? 0,
    use_speaker_boost: vs.use_speaker_boost !== false,
    expressive_mode: vs.expressive_mode !== false,
    language_boost: vs.language_boost ?? 'English',
    stt_model: tr.model ?? '',
    stt_language: tr.language ?? '',
    eot_threshold: trs.eot_threshold ?? 0.8,
    eot_timeout_ms: trs.eot_timeout_ms ?? 5000,
    allow_interruptions: is.enable !== false,

    disable_greeting_interruption: !!is.disable_greeting_interruption,

    interrupt_prediction_threshold:
      is.interrupt_prediction_threshold == null ? null : Number(is.interrupt_prediction_threshold),
    record_calls: !!ts.recording_settings?.enabled,
    max_call_secs: ts.time_limit_secs ?? 1800,
    user_idle_timeout_secs: ts.user_idle_timeout_secs ?? 0,
    user_idle_reply_secs: ts.user_idle_reply_secs ?? 10,
    disable_dtmf: !!ts.disable_dtmf,
    noise_suppression: ts.noise_suppression ?? 'disabled',

    fallback_destination: ts.fallback_destination ?? '',

    voicemail_detection: !!ts.voicemail_detection,
    voicemail_action: vm.action ?? 'hangup',
    post_call_processing: !!a.post_conversation_settings?.enabled,

    enabled_features: a.enabled_features ?? ['telephony'],
    messaging_profile_id: ms.default_messaging_profile_id ?? '',
    messaging_inactivity_minutes: ms.conversation_inactivity_minutes ?? 0,
    data_retention: a.privacy_settings?.data_retention !== false,
    dynamic_variables: a.dynamic_variables ?? {},
    dynamic_variables_webhook_url: a.dynamic_variables_webhook_url ?? '',
    tools: a.tools ?? [],
  };
}

export const DEFAULT_TEMPLATE = {
  name: 'EstatePulse AI Agent',
  greeting: 'Hi, this is your home-buying assistant, calling about your recent enquiry. Are you looking to buy a home sometime soon?',
  instructions:
    '# Role\nYou are a warm, professional AI assistant for a real estate brokerage. You are calling a home-buyer lead who recently enquired, to qualify them over the phone. You placed this call, so never thank them for calling in.\n\n# Goal\nCollect, one question at a time: (1) buying intent, (2) timeline, (3) location, (4) budget, (5) property type and bedrooms, (6) financing / pre-approval. Acknowledge each answer briefly. Keep replies short and human.\n\n# Wrap up\nIf ready, offer to book a consultation with a human agent. Never give legal advice, never guarantee mortgage approval, and escalate to a human whenever uncertain.\n\n# Ending the call\nOnce the details are collected, or the caller is not interested or asks to stop, thank them, say a short goodbye, then use the hangup tool. Never stay silent on the line after saying goodbye.',
};

const HANGUP_TOOL = {
  type: 'hangup',
  hangup: {
    description:
      'End the call. Use it right after saying goodbye — once the conversation is complete, ' +
      'the caller is not interested, or the caller asks to end the call.',
  },
};

export const RECORDING_NOTICE = 'Just so you know, this call is recorded for quality and training.';

const ASSISTANT_MODELS = [
  'meta-llama/Llama-3.3-70B-Instruct',
  'moonshotai/Kimi-K2.6',
  'meta-llama/Meta-Llama-3.1-70B-Instruct',
  'Qwen/Qwen3-235B-A22B',
];

@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);

  private readonly hangupReady = new Set<string>();
  private readonly hangupInflight = new Map<string, Promise<void>>();

  constructor(
    private readonly creds: TelnyxCredentialsService,
    private readonly prisma: PrismaService,
  ) {}

  private async greetingFor(orgId: string, base: string): Promise<string> {
    const settings = await this.prisma.organizationSetting
      .findUnique({ where: { orgId }, select: { callRecordingEnabled: true, callRecordingAnnounce: true } })
      .catch(() => null);
    const announce = Boolean(settings?.callRecordingEnabled && settings.callRecordingAnnounce);
    return announce ? `${RECORDING_NOTICE} ${base}` : base;
  }

  private async requireCreds(orgId: string): Promise<TelnyxCreds> {
    const c = await this.creds.getCreds(orgId);
    if (!c || !c.apiKey) throw new AppError('CONFLICT', 'No AI provider connected — add your credentials first.');
    return c;
  }

  private async fetchRaw(orgId: string): Promise<any> {
    const c = await this.requireCreds(orgId);
    if (!c.assistantId) throw new AppError('CONFLICT', 'No AI assistant yet — create one or paste an existing assistant id.');
    const res = await fetch(`${BASE}/${c.assistantId}`, { headers: authHeaders(c.apiKey) });
    if (!res.ok) throw new AppError('UPSTREAM_ERROR', `AI agent fetch failed ${res.status}: ${await res.text()}`);
    const j = (await res.json()) as any;
    return j.data ?? j;
  }

  private async keepBookingSection(orgId: string, instructions: string): Promise<string> {
    const settings = await this.prisma.organizationSetting
      .findUnique({ where: { orgId }, select: { inCallBooking: true } })
      .catch(() => null);
    const cfg = (settings?.inCallBooking ?? null) as { eventTypeName?: string; durationMinutes?: number } | null;
    if (!cfg?.eventTypeName || !cfg.durationMinutes) return instructions;
    return withBookingSection(String(instructions), cfg.eventTypeName, cfg.durationMinutes);
  }

  /**
   * "Record calls" is the organization's switch: the call records itself (dual
   * channel, transcribed) and the assistant never records on its own as well.
   */
  private async recordsCalls(orgId: string): Promise<boolean> {
    const settings = await this.prisma.organizationSetting
      .findUnique({ where: { orgId }, select: { callRecordingEnabled: true } })
      .catch(() => null);
    return settings?.callRecordingEnabled ?? true;
  }

  async getAssistant(orgId: string) {
    const c = await this.creds.getCreds(orgId);
    if (!c || !c.apiKey || !c.assistantId) return null;
    return { ...shape(await this.fetchRaw(orgId)), record_calls: await this.recordsCalls(orgId) };
  }

  async updateAssistant(orgId: string, patch: any) {
    const c = await this.requireCreds(orgId);
    const cur = await this.fetchRaw(orgId);
    const body: any = {};
    if (patch.instructions != null) body.instructions = await this.keepBookingSection(orgId, patch.instructions);
    if (patch.greeting != null) body.greeting = patch.greeting;
    if (patch.model != null) body.model = patch.model;
    if (patch.description != null) body.description = patch.description;
    if (patch.dynamic_variables != null) body.dynamic_variables = patch.dynamic_variables;
    if (patch.dynamic_variables_webhook_url != null) {
      body.dynamic_variables_webhook_url = patch.dynamic_variables_webhook_url || null;
    }
    if (patch.enabled_features != null) body.enabled_features = patch.enabled_features;
    if (patch.data_retention != null) {
      body.privacy_settings = { ...(cur.privacy_settings ?? {}), data_retention: !!patch.data_retention };
    }
    if (patch.messaging_profile_id != null || patch.messaging_inactivity_minutes != null) {
      const ms: any = { ...(cur.messaging_settings ?? {}) };
      if (patch.messaging_profile_id != null) {
        ms.default_messaging_profile_id = patch.messaging_profile_id || null;
      }
      if (patch.messaging_inactivity_minutes != null) {
        const mins = Number(patch.messaging_inactivity_minutes);
        ms.conversation_inactivity_minutes = mins > 0 ? mins : null;
      }
      body.messaging_settings = ms;
    }

    if (patch.tools != null) body.tools = patch.tools;
    if (patch.post_call_processing != null) {
      body.post_conversation_settings = { ...(cur.post_conversation_settings ?? {}), enabled: !!patch.post_call_processing };
    }

    const voiceKeys = ['voice', 'voice_speed', 'background_audio', 'similarity_boost', 'style', 'use_speaker_boost', 'expressive_mode', 'language_boost'];
    if (voiceKeys.some((k) => patch[k] != null)) {
      const vs: any = { ...(cur.voice_settings ?? {}) };
      if (patch.voice != null) vs.voice = patch.voice;
      if (patch.voice_speed != null) vs.voice_speed = Number(patch.voice_speed);
      if (patch.background_audio != null) vs.background_audio = { type: 'predefined_media', value: patch.background_audio, volume: cur.voice_settings?.background_audio?.volume ?? 0.5 };
      if (patch.similarity_boost != null) vs.similarity_boost = Number(patch.similarity_boost);
      if (patch.style != null) vs.style = Number(patch.style);
      if (patch.use_speaker_boost != null) vs.use_speaker_boost = !!patch.use_speaker_boost;
      if (patch.expressive_mode != null) vs.expressive_mode = !!patch.expressive_mode;
      if (patch.language_boost != null) vs.language_boost = patch.language_boost;
      body.voice_settings = vs;
    }
    if (patch.stt_model != null || patch.stt_language != null || patch.eot_threshold != null || patch.eot_timeout_ms != null) {
      const tr: any = { ...(cur.transcription ?? {}) };
      if (patch.stt_model != null) tr.model = patch.stt_model;
      if (patch.stt_language != null) tr.language = patch.stt_language;
      tr.settings = { ...(tr.settings ?? {}) };
      if (patch.eot_threshold != null) tr.settings.eot_threshold = Number(patch.eot_threshold);
      if (patch.eot_timeout_ms != null) tr.settings.eot_timeout_ms = Number(patch.eot_timeout_ms);
      body.transcription = tr;
    }
    if (
      patch.allow_interruptions != null ||
      patch.disable_greeting_interruption != null ||
      patch.interrupt_prediction_threshold !== undefined
    ) {
      const is: any = { ...(cur.interruption_settings ?? {}) };
      if (patch.allow_interruptions != null) is.enable = !!patch.allow_interruptions;
      if (patch.disable_greeting_interruption != null) {
        is.disable_greeting_interruption = !!patch.disable_greeting_interruption;
      }

      if (patch.interrupt_prediction_threshold !== undefined) {
        is.interrupt_prediction_threshold =
          patch.interrupt_prediction_threshold == null
            ? null
            : Number(patch.interrupt_prediction_threshold);
      }
      body.interruption_settings = is;
    }
    const telephonyKeys = [
      'record_calls',
      'max_call_secs',
      'user_idle_timeout_secs',
      'user_idle_reply_secs',
      'disable_dtmf',
      'noise_suppression',
      'fallback_destination',
      'voicemail_detection',
      'voicemail_action',
    ];
    if (telephonyKeys.some((k) => patch[k] != null)) {
      const ts: any = { ...(cur.telephony_settings ?? {}) };
      if (patch.max_call_secs != null) ts.time_limit_secs = Number(patch.max_call_secs);
      if (patch.user_idle_timeout_secs != null) ts.user_idle_timeout_secs = patch.user_idle_timeout_secs ? Number(patch.user_idle_timeout_secs) : null;
      if (patch.user_idle_reply_secs != null) ts.user_idle_reply_secs = Number(patch.user_idle_reply_secs);
      if (patch.disable_dtmf != null) ts.disable_dtmf = !!patch.disable_dtmf;
      if (patch.noise_suppression != null) ts.noise_suppression = patch.noise_suppression;
      if (patch.fallback_destination != null) ts.fallback_destination = patch.fallback_destination || null;
      if (patch.record_calls != null) ts.recording_settings = { ...(ts.recording_settings ?? {}), enabled: false };
      if (patch.voicemail_detection != null) {
        ts.voicemail_detection = patch.voicemail_detection
          ? { ...(ts.voicemail_detection ?? {}), action: patch.voicemail_action ?? ts.voicemail_detection?.action ?? 'hangup' }
          : null;
      } else if (patch.voicemail_action != null && ts.voicemail_detection) {
        ts.voicemail_detection = { ...ts.voicemail_detection, action: patch.voicemail_action };
      }
      body.telephony_settings = ts;
    }

    const res = await fetch(`${BASE}/${c.assistantId}`, { method: 'PATCH', headers: { ...authHeaders(c.apiKey), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new AppError('UPSTREAM_ERROR', `AI agent update failed ${res.status}: ${await res.text()}`);
    const j = (await res.json()) as any;
    if (patch.record_calls != null) {
      await this.prisma.organizationSetting.updateMany({ where: { orgId }, data: { callRecordingEnabled: !!patch.record_calls } });
    }
    return { ...shape(j.data ?? j), record_calls: await this.recordsCalls(orgId) };
  }

  async setTools(orgId: string, owned: any[]) {
    const c = await this.requireCreds(orgId);
    const cur = await this.fetchRaw(orgId);
    const sharedIds: string[] = ((cur.tools ?? []) as any[])
      .filter((t) => t?.shared && t?.id)
      .map((t) => t.id);

    const tools = (owned ?? []).map(({ id: _id, shared: _shared, ...rest }: any) => rest);

    this.hangupReady.delete(`${orgId}:${c.assistantId}`);

    const res = await fetch(`${BASE}/${c.assistantId}`, {
      method: 'PATCH',
      headers: { ...authHeaders(c.apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({ tools }),
    });
    if (!res.ok) throw new AppError('UPSTREAM_ERROR', `Tool update failed ${res.status}: ${await res.text()}`);

    for (const toolId of sharedIds) {
      await fetch(`${BASE}/${c.assistantId}/tools/${toolId}`, {
        method: 'PUT',
        headers: authHeaders(c.apiKey),
      }).catch(() => undefined);
    }

    return shape(await this.fetchRaw(orgId));
  }

  /** Once per assistant: the hangup tool is attached, and the assistant does not record on top of the call's own recording. */
  async ensureCallSetup(orgId: string): Promise<void> {
    const c = await this.creds.getCreds(orgId).catch(() => null);
    if (!c?.apiKey || !c.assistantId) return;

    const key = `${orgId}:${c.assistantId}`;
    if (this.hangupReady.has(key)) return;
    const running = this.hangupInflight.get(key);
    if (running) return running;

    const run = (async () => {
      const cur = await this.fetchRaw(orgId);
      const tools = (cur.tools ?? []) as any[];
      if (!tools.some((t) => t?.type === 'hangup')) {
        await this.setTools(orgId, [...tools.filter((t) => !t?.shared), HANGUP_TOOL]);
        this.logger.log(`hangup tool added to assistant ${c.assistantId}`);
      }
      const ts = cur.telephony_settings ?? {};
      if (ts.recording_settings?.enabled) {
        const res = await fetch(`${BASE}/${c.assistantId}`, {
          method: 'PATCH',
          headers: { ...authHeaders(c.apiKey), 'Content-Type': 'application/json' },
          body: JSON.stringify({ telephony_settings: { ...ts, recording_settings: { ...ts.recording_settings, enabled: false } } }),
        });
        if (!res.ok) throw new Error(`turning off the assistant's own recording failed ${res.status}: ${await res.text()}`);
        this.logger.log(`assistant ${c.assistantId} no longer records on its own; the call's recording covers it`);
      }
      this.hangupReady.add(key);
    })()
      .catch((e) => this.logger.warn(`assistant call setup for org ${orgId}: ${(e as Error).message}`))
      .finally(() => this.hangupInflight.delete(key));
    this.hangupInflight.set(key, run);
    return run;
  }

  async detachTool(orgId: string, toolId: string) {
    const c = await this.requireCreds(orgId);
    const res = await fetch(`${BASE}/${c.assistantId}/tools/${toolId}`, {
      method: 'DELETE',
      headers: authHeaders(c.apiKey),
    });
    if (!res.ok) throw new AppError('UPSTREAM_ERROR', `Tool detach failed ${res.status}: ${await res.text()}`);
    return shape(await this.fetchRaw(orgId));
  }

  async testTool(orgId: string, toolId: string, args: any, dynamicVariables: any) {
    const c = await this.requireCreds(orgId);
    const res = await fetch(`${BASE}/${c.assistantId}/tools/${toolId}/test`, {
      method: 'POST',
      headers: { ...authHeaders(c.apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        arguments: args ?? {},
        dynamic_variables: dynamicVariables ?? {},
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new AppError('UPSTREAM_ERROR', `Tool test failed ${res.status}: ${text}`);
    return text ? JSON.parse(text) : {};
  }

  async listModels(orgId: string): Promise<string[]> {
    const c = await this.requireCreds(orgId);
    const res = await fetch('https://api.telnyx.com/v2/ai/models', { headers: authHeaders(c.apiKey) });
    if (!res.ok) throw new AppError('UPSTREAM_ERROR', `AI agent models fetch failed ${res.status}`);
    const j = (await res.json()) as any;
    return ((j.data ?? j.models ?? []) as any[]).map((m) => m.id ?? m.name).filter(Boolean);
  }

  async listAssistants(orgId: string) {
    const c = await this.requireCreds(orgId);
    const res = await fetch(BASE, { headers: authHeaders(c.apiKey) });
    if (!res.ok) throw new AppError('UPSTREAM_ERROR', `List assistants failed ${res.status}`);
    const j = (await res.json()) as any;
    return ((j.data ?? []) as any[]).map((a) => ({ id: a.id, name: a.name, model: a.model }));
  }

  async createAssistant(orgId: string, overrides: any = {}) {
    const c = await this.requireCreds(orgId);
    let candidates: string[];
    if (overrides.model) candidates = [overrides.model];
    else {
      const avail = new Set(await this.listModels(orgId).catch(() => [] as string[]));
      const preferred = ASSISTANT_MODELS.filter((m) => avail.has(m));
      candidates = preferred.length ? preferred : ASSISTANT_MODELS;
    }
    let lastErr = 'AI agent create failed';
    const greeting = await this.greetingFor(
      orgId,
      overrides.greeting || DEFAULT_TEMPLATE.greeting,
    );
    for (const model of candidates) {
      const body = {
        name: overrides.name || DEFAULT_TEMPLATE.name,
        model,
        instructions: overrides.instructions || DEFAULT_TEMPLATE.instructions,
        greeting,
        tools: [HANGUP_TOOL],
      };
      const res = await fetch(BASE, { method: 'POST', headers: { ...authHeaders(c.apiKey), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (res.ok) {
        const j = (await res.json()) as any;
        const a = j?.data ?? j ?? {};
        if (!a.id) throw new AppError('UPSTREAM_ERROR', 'Telnyx created the assistant but returned no id; attach it by id instead.');
        await this.creds.saveCreds(orgId, { assistantId: a.id });
        return shape(a);
      }
      const text = await res.text();
      lastErr = `AI agent create failed ${res.status}: ${text}`;
      if (!/not available for AI Assistants|10027/i.test(text)) break;
    }
    throw new AppError('UPSTREAM_ERROR', lastErr);
  }

  async setAssistantId(orgId: string, pasted: string) {
    const c = await this.requireCreds(orgId);

    const assistantId = /assistant-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(pasted ?? '')?.[0];
    if (!assistantId) {
      throw new AppError('VALIDATION_ERROR', 'That does not look like a Telnyx assistant id (assistant-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).');
    }
    const res = await fetch(`${BASE}/${encodeURIComponent(assistantId)}`, { headers: authHeaders(c.apiKey) });
    if (!res.ok) throw new AppError('UPSTREAM_ERROR', `Could not find that assistant in your account (${res.status})`);
    await this.creds.saveCreds(orgId, { assistantId });
    const j = (await res.json()) as any;
    return shape(j.data ?? j);
  }
}
