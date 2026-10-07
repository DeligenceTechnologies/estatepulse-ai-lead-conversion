import { Inject, Injectable, Logger } from '@nestjs/common';
import { TENANT_PRISMA, type GuardedPrisma } from '../prisma/prisma.service';
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
    // Telnyx's own default is false, so `!!` is the whole truth here.
    disable_greeting_interruption: !!is.disable_greeting_interruption,
    // Nullable on purpose: null means "let the model decide", which is not 0.
    interrupt_prediction_threshold:
      is.interrupt_prediction_threshold == null ? null : Number(is.interrupt_prediction_threshold),
    record_calls: !!ts.recording_settings?.enabled,
    max_call_secs: ts.time_limit_secs ?? 1800,
    user_idle_timeout_secs: ts.user_idle_timeout_secs ?? 0,
    user_idle_reply_secs: ts.user_idle_reply_secs ?? 10,
    disable_dtmf: !!ts.disable_dtmf,
    noise_suppression: ts.noise_suppression ?? 'disabled',
    // Where a call goes when the assistant itself fails. Empty string, not null,
    // so the field round-trips through a text input unchanged.
    fallback_destination: ts.fallback_destination ?? '',
    // Answering-machine detection. Telnyx omits the object entirely when it is
    // off, which is why presence is the flag rather than a nested `enabled`.
    voicemail_detection: !!ts.voicemail_detection,
    voicemail_action: vm.action ?? 'hangup',
    post_call_processing: !!a.post_conversation_settings?.enabled,
    // Which channels the assistant is allowed on at all. Telephony-only is the
    // Telnyx default for a voice assistant.
    enabled_features: a.enabled_features ?? ['telephony'],
    messaging_profile_id: ms.default_messaging_profile_id ?? '',
    messaging_inactivity_minutes: ms.conversation_inactivity_minutes ?? 0,
    data_retention: a.privacy_settings?.data_retention !== false,
    dynamic_variables: a.dynamic_variables ?? {},
    dynamic_variables_webhook_url: a.dynamic_variables_webhook_url ?? '',
    tools: a.tools ?? [],
  };
}

const DEFAULT_TEMPLATE = {
  name: 'EstatePulse AI Agent',
  greeting: 'Hi, thanks for reaching out! This is your home-buying assistant. Are you looking to buy a home sometime soon?',
  instructions:
    '# Role\nYou are a warm, professional AI assistant for a real estate brokerage. Qualify inbound home-buyer leads over the phone.\n\n# Goal\nCollect, one question at a time: (1) buying intent, (2) timeline, (3) location, (4) budget, (5) property type and bedrooms, (6) financing / pre-approval. Acknowledge each answer briefly. Keep replies short and human.\n\n# Wrap up\nIf ready, offer to book a consultation with a human agent. Never give legal advice, never guarantee mortgage approval, and escalate to a human whenever uncertain.\n\n# Ending the call\nOnce the details are collected, or the caller is not interested or asks to stop, thank them, say a short goodbye, then use the hangup tool. Never stay silent on the line after saying goodbye.',
};

/**
 * Telnyx's built-in hangup tool. Without it the assistant has no way to end a
 * call: it says goodbye and then holds the line open in silence until the
 * caller gives up or the time limit hits. The description is what the model
 * reads to decide when to use it, so it carries the rule even for an office
 * whose own prompt never mentions hanging up.
 */
const HANGUP_TOOL = {
  type: 'hangup',
  hangup: {
    description:
      'End the call. Use it right after saying goodbye — once the conversation is complete, ' +
      'the caller is not interested, or the caller asks to end the call.',
  },
};

/**
 * Spoken before anything else when the office records calls and has not turned
 * the announcement off. Recording consent is state-specific — some states need
 * every party to consent — and the combination of recording plus an up-front
 * announcement is the one that is lawful in all of them.
 *
 * It is prepended to the greeting rather than buried in the instructions
 * because instructions are guidance the model may paraphrase or skip, and the
 * greeting is a script it reads.
 */
const RECORDING_NOTICE = 'Just so you know, this call is recorded for quality and training.';

const ASSISTANT_MODELS = [
  'meta-llama/Llama-3.3-70B-Instruct',
  'moonshotai/Kimi-K2.6',
  'meta-llama/Meta-Llama-3.1-70B-Instruct',
  'Qwen/Qwen3-235B-A22B',
];


@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);
  /** `${orgId}:${assistantId}` keys known to carry the hangup tool in this process. */
  private readonly hangupReady = new Set<string>();
  private readonly hangupInflight = new Map<string, Promise<void>>();

  constructor(
    private readonly creds: CredStoreService,
    @Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma,
  ) {}

  /**
   * The greeting a new assistant is born with, announcement included when the
   * office's settings call for one.
   *
   * Applied only at creation, deliberately. Rewriting the greeting of an
   * existing assistant every time the flag is read would silently overwrite a
   * greeting the office had customised, and an office that edits its greeting
   * owns what it says from then on.
   */
  private async greetingFor(orgId: string, base: string): Promise<string> {
    const org = await this.prisma.organizations
      .findUnique({
        where: { id: orgId },
        select: { call_recording_enabled: true, call_recording_announce: true },
      })
      .catch(() => null);
    const announce = !!org?.call_recording_enabled && !!org?.call_recording_announce;
    return announce ? `${RECORDING_NOTICE} ${base}` : base;
  }

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
    if (patch.description != null) body.description = patch.description;
    if (patch.dynamic_variables != null) body.dynamic_variables = patch.dynamic_variables;
    if (patch.dynamic_variables_webhook_url != null) {
      // Empty string clears it. Telnyx rejects '' as a url, so it goes as null.
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
        // 0 is the UI's "no timeout"; the API's minimum is 1, so it clears instead.
        const mins = Number(patch.messaging_inactivity_minutes);
        ms.conversation_inactivity_minutes = mins > 0 ? mins : null;
      }
      body.messaging_settings = ms;
    }
    // Written one tool at a time through the tool methods below, never as a
    // wholesale array from the settings form — see the note on setTools().
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
      // `=== undefined` rather than `!= null`: null is a meaningful value here
      // (hand the decision back to the model) and must be sendable.
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
      if (patch.record_calls != null) ts.recording_settings = { ...(ts.recording_settings ?? {}), enabled: !!patch.record_calls };
      if (patch.voicemail_detection != null) {
        // Off is the absence of the object, not `{enabled: false}` — that is how
        // it reads back, so it is how it has to be written for a round trip to
        // be a no-op.
        ts.voicemail_detection = patch.voicemail_detection
          ? { ...(ts.voicemail_detection ?? {}), action: patch.voicemail_action ?? ts.voicemail_detection?.action ?? 'hangup' }
          : null;
      } else if (patch.voicemail_action != null && ts.voicemail_detection) {
        ts.voicemail_detection = { ...ts.voicemail_detection, action: patch.voicemail_action };
      }
      body.telephony_settings = ts;
    }

    const res = await fetch(`${BASE}/${c.assistantId}`, { method: 'PATCH', headers: { ...authHeaders(c.apiKey), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`AI agent update failed ${res.status}: ${await res.text()}`);
    const j = (await res.json()) as any;
    return shape(j.data ?? j);
  }

  /**
   * Replaces the assistant's own tools, leaving shared ones alone.
   *
   * Tools reach the assistant two ways. An *owned* tool is defined inline on the
   * assistant and lives and dies with it. A *shared* tool is a row in the
   * account's tool library, attached by id, and comes back from a GET expanded
   * inline and flagged `shared: true` — indistinguishable from an owned tool
   * apart from that flag.
   *
   * That flag is why this cannot be a single PATCH of everything the GET
   * returned. `shared` is read-only, so writing those expanded objects back
   * inline would at best be rejected and at worst fork each shared tool into a
   * private copy that stops tracking the library. So the two kinds are written
   * by the two mechanisms Telnyx actually provides: owned tools as an inline
   * array, shared tools re-attached afterwards by id.
   *
   * The re-attach is belt and braces. If the PATCH left the attachments alone,
   * every PUT is a no-op; if it dropped them, they come straight back. Either
   * way the caller cannot silently detach a shared tool by saving a form that
   * was never about shared tools.
   */
  async setTools(orgId: string, owned: any[]) {
    const c = await this.requireCreds(orgId);
    const cur = await this.fetchRaw(orgId);
    const sharedIds: string[] = ((cur.tools ?? []) as any[])
      .filter((t) => t?.shared && t?.id)
      .map((t) => t.id);

    // id and shared are both server-owned. The array is a full replacement, so
    // dropping ids cannot orphan or duplicate anything.
    const tools = (owned ?? []).map(({ id: _id, shared: _shared, ...rest }: any) => rest);
    // A save that leaves the hangup tool out must not be masked by the cache.
    this.hangupReady.delete(`${orgId}:${c.assistantId}`);

    const res = await fetch(`${BASE}/${c.assistantId}`, {
      method: 'PATCH',
      headers: { ...authHeaders(c.apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({ tools }),
    });
    if (!res.ok) throw new Error(`Tool update failed ${res.status}: ${await res.text()}`);

    for (const toolId of sharedIds) {
      await fetch(`${BASE}/${c.assistantId}/tools/${toolId}`, {
        method: 'PUT',
        headers: authHeaders(c.apiKey),
      }).catch(() => undefined);
    }

    return shape(await this.fetchRaw(orgId));
  }

  /**
   * Make sure the org's assistant can end its own calls. Assistants created
   * before the hangup tool was part of the template — or picked from the
   * office's existing Telnyx account — get it added alongside whatever tools
   * they already have.
   *
   * Runs before the assistant is attached to a call, at most once per assistant
   * per process. Never throws: a call must go ahead even if this fails, and a
   * failure retries on the next call.
   */
  async ensureHangupTool(orgId: string): Promise<void> {
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
      this.hangupReady.add(key);
    })()
      .catch((e) => this.logger.warn(`hangup tool setup for org ${orgId}: ${(e as Error).message}`))
      .finally(() => this.hangupInflight.delete(key));
    this.hangupInflight.set(key, run);
    return run;
  }

  /**
   * Detaches a shared tool. The tool itself stays in the account library — this
   * is the inverse of the PUT above, not a delete.
   */
  async detachTool(orgId: string, toolId: string) {
    const c = await this.requireCreds(orgId);
    const res = await fetch(`${BASE}/${c.assistantId}/tools/${toolId}`, {
      method: 'DELETE',
      headers: authHeaders(c.apiKey),
    });
    if (!res.ok) throw new Error(`Tool detach failed ${res.status}: ${await res.text()}`);
    return shape(await this.fetchRaw(orgId));
  }

  /**
   * Fires a webhook tool for real, with arguments the user typed, and hands back
   * what came off the wire.
   *
   * This is the one thing that made the provider console unavoidable: a webhook
   * tool that 404s or times out is invisible until a live call hits it, and a
   * live call is an expensive way to find a typo in a URL.
   */
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
    if (!res.ok) throw new Error(`Tool test failed ${res.status}: ${text}`);
    return text ? JSON.parse(text) : {};
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
