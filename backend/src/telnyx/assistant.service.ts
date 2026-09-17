import { Injectable } from '@nestjs/common';
import { CredStoreService, type Creds } from './cred-store.service';

/** Telnyx AI Assistant read/update — per org (Bring-Your-Own-Telnyx). */
const BASE = 'https://api.telnyx.com/v2/ai/assistants';

const authHeaders = (apiKey: string) => ({ Authorization: `Bearer ${apiKey}` });

/* eslint-disable @typescript-eslint/no-explicit-any */
function shape(a: any) {
  const vs = a.voice_settings ?? {};
  const ts = a.telephony_settings ?? {};
  const is = a.interruption_settings ?? {};
  const tr = a.transcription ?? {};
  const trs = tr.settings ?? {};
  return {
    id: a.id,
    name: a.name,
    model: a.model,
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
    record_calls: !!ts.recording_settings?.enabled,
    max_call_secs: ts.time_limit_secs ?? 1800,
    user_idle_timeout_secs: ts.user_idle_timeout_secs ?? 0,
    post_call_processing: !!a.post_conversation_settings?.enabled,
    dynamic_variables: a.dynamic_variables ?? {},
    tools: a.tools ?? [],
  };
}

const DEFAULT_TEMPLATE = {
  name: 'EstatePulse AI Agent',
  greeting: 'Hi, thanks for reaching out! This is your home-buying assistant. Are you looking to buy a home sometime soon?',
  instructions:
    '# Role\nYou are a warm, professional AI assistant for a real estate brokerage. Qualify inbound home-buyer leads over the phone.\n\n# Goal\nCollect, one question at a time: (1) buying intent, (2) timeline, (3) location, (4) budget, (5) property type and bedrooms, (6) financing / pre-approval. Acknowledge each answer briefly. Keep replies short and human.\n\n# Wrap up\nIf ready, offer to book a consultation with a human agent. Never give legal advice, never guarantee mortgage approval, and escalate to a human whenever uncertain.',
};


const ASSISTANT_MODELS = [
  'meta-llama/Llama-3.3-70B-Instruct',
  'moonshotai/Kimi-K2.6',
  'meta-llama/Meta-Llama-3.1-70B-Instruct',
  'Qwen/Qwen3-235B-A22B',
];


@Injectable()
export class AssistantService {
  constructor(private readonly creds: CredStoreService) {}

  private async requireCreds(orgId: string): Promise<Creds> {
    const c = await this.creds.getCreds(orgId);
    if (!c || !c.apiKey) throw new Error('No AI provider connected — add your credentials first.');
    return c;
  }

  private async fetchRaw(orgId: string): Promise<any> {
    const c = await this.requireCreds(orgId);
    if (!c.assistantId) throw new Error('No AI assistant yet — create one or paste an existing assistant id.');
    const res = await fetch(`${BASE}/${c.assistantId}`, { headers: authHeaders(c.apiKey) });
    if (!res.ok) throw new Error(`AI agent fetch failed ${res.status}: ${await res.text()}`);
    const j = (await res.json()) as any;
    return j.data ?? j;
  }

  async getAssistant(orgId: string) {
    const c = await this.creds.getCreds(orgId);
    if (!c || !c.apiKey || !c.assistantId) return null;
    return shape(await this.fetchRaw(orgId));
  }

  async updateAssistant(orgId: string, patch: any) {
    const c = await this.requireCreds(orgId);
    const cur = await this.fetchRaw(orgId);
    const body: any = {};
    if (patch.instructions != null) body.instructions = patch.instructions;
    if (patch.greeting != null) body.greeting = patch.greeting;
    if (patch.model != null) body.model = patch.model;
    if (patch.dynamic_variables != null) body.dynamic_variables = patch.dynamic_variables;
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
    if (patch.allow_interruptions != null) body.interruption_settings = { ...(cur.interruption_settings ?? {}), enable: !!patch.allow_interruptions };
    if (patch.record_calls != null || patch.max_call_secs != null || patch.user_idle_timeout_secs != null) {
      const ts: any = { ...(cur.telephony_settings ?? {}) };
      if (patch.max_call_secs != null) ts.time_limit_secs = Number(patch.max_call_secs);
      if (patch.user_idle_timeout_secs != null) ts.user_idle_timeout_secs = patch.user_idle_timeout_secs ? Number(patch.user_idle_timeout_secs) : null;
      if (patch.record_calls != null) ts.recording_settings = { ...(ts.recording_settings ?? {}), enabled: !!patch.record_calls };
      body.telephony_settings = ts;
    }

    const res = await fetch(`${BASE}/${c.assistantId}`, { method: 'PATCH', headers: { ...authHeaders(c.apiKey), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`AI agent update failed ${res.status}: ${await res.text()}`);
    const j = (await res.json()) as any;
    return shape(j.data ?? j);
  }

  async listModels(orgId: string): Promise<string[]> {
    const c = await this.requireCreds(orgId);
    const res = await fetch('https://api.telnyx.com/v2/ai/models', { headers: authHeaders(c.apiKey) });
    if (!res.ok) throw new Error(`AI agent models fetch failed ${res.status}`);
    const j = (await res.json()) as any;
    return ((j.data ?? j.models ?? []) as any[]).map((m) => m.id ?? m.name).filter(Boolean);
  }

  async listAssistants(orgId: string) {
    const c = await this.requireCreds(orgId);
    const res = await fetch(BASE, { headers: authHeaders(c.apiKey) });
    if (!res.ok) throw new Error(`List assistants failed ${res.status}`);
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
    for (const model of candidates) {
      const body = {
        name: overrides.name || DEFAULT_TEMPLATE.name,
        model,
        instructions: overrides.instructions || DEFAULT_TEMPLATE.instructions,
        greeting: overrides.greeting || DEFAULT_TEMPLATE.greeting,
      };
      const res = await fetch(BASE, { method: 'POST', headers: { ...authHeaders(c.apiKey), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (res.ok) {
        const a = ((await res.json()) as any).data ?? {};
        await this.creds.saveCreds(orgId, { assistantId: a.id });
        return shape(a);
      }
      const text = await res.text();
      lastErr = `AI agent create failed ${res.status}: ${text}`;
      if (!/not available for AI Assistants|10027/i.test(text)) break;
    }
    throw new Error(lastErr);
  }

  async setAssistantId(orgId: string, assistantId: string) {
    const c = await this.requireCreds(orgId);
    const res = await fetch(`${BASE}/${assistantId}`, { headers: authHeaders(c.apiKey) });
    if (!res.ok) throw new Error(`Could not find that assistant in your account (${res.status})`);
    await this.creds.saveCreds(orgId, { assistantId });
    const j = (await res.json()) as any;
    return shape(j.data ?? j);
  }
}
