import React, { useState, useEffect } from 'react';
import {
  Sliders,
  Sparkles,
  ShieldCheck,
  Clock,
  MapPin,
  Check,
  AlertTriangle,
  Building2,
  CheckCircle2,
  Save,
  Wand2,
  Loader2,
  RefreshCw,
  PhoneCall,
  Plug,
  ArrowRight,
  Plus,
  Pencil,
  Trash2,
  Voicemail,
  MessageSquare,
  Lock
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import {
  getAssistant,
  updateAssistant,
  listModels,
  getTelnyxStatus,
  listAssistants,
  attachAssistant,
  AssistantSummary,
  TelnyxStatus,
  applyTone,
  stripTone,
  extractTone,
  BACKGROUND_AUDIO_OPTIONS,
  LANGUAGE_BOOST_OPTIONS,
  NOISE_SUPPRESSION_OPTIONS,
  LEAD_VARIABLES,
  AssistantTool,
  NoiseSuppression,
  VoicemailAction,
  toolLabel,
  setTools as saveTools,
  detachTool,
} from '../../utils/assistantApi';
import { StrategyEditor } from './StrategyEditor';
import { PhoneNumberCard } from './PhoneNumberCard';
import { ContactWindowCard } from './ContactWindowCard';
import { LeadTemperatureCard } from './LeadTemperatureCard';
import { ToolEditorModal } from '../modals/ToolEditorModal';

export const AISettingsView: React.FC = () => {
  const { orgSettings, updateOrgSettings, setActiveView } = useApp();

  const [aiName, setAiName] = useState(orgSettings.aiAgentName);
  const [tone, setTone] = useState(orgSettings.aiTone);
  const [systemPrompt, setSystemPrompt] = useState(orgSettings.aiSystemPrompt);
  const [savedSuccess, setSavedSuccess] = useState(false);

  // Provider connection (Bring-Your-Own-Telnyx).
  const [status, setStatus] = useState<TelnyxStatus | null>(null);
  const [assistants, setAssistants] = useState<AssistantSummary[]>([]);
  const [switching, setSwitching] = useState(false);

  const refreshStatus = () => {
    getTelnyxStatus()
      .then((s) => {
        setStatus(s);
        if (s.connected) listAssistants().then(setAssistants).catch(() => setAssistants([]));
        if (s.hasAssistant) loadAgent();
      })
      .catch(() => setStatus({ connected: false, hasAssistant: false } as TelnyxStatus));
  };
  useEffect(refreshStatus, []);

  const switchAgent = (id: string) => {
    if (!id || (status && id === status.assistantId)) return;
    setSwitching(true);
    attachAssistant(id).then(refreshStatus).catch(() => refreshStatus()).finally(() => setSwitching(false));
  };

  // Live AI agent state.
  const [assistantName, setAssistantName] = useState<string | null>(null);
  const [agentLoading, setAgentLoading] = useState(true);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);

  // Editable agent settings (loaded live).
  const [greeting, setGreeting] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [voice, setVoice] = useState('');
  const [voiceSpeed, setVoiceSpeed] = useState(1);
  const [backgroundAudio, setBackgroundAudio] = useState('silence');
  const [allowInterruptions, setAllowInterruptions] = useState(true);
  const [recordCalls, setRecordCalls] = useState(true);
  const [maxCallMins, setMaxCallMins] = useState(30);
  const [dynamicVars, setDynamicVars] = useState<Array<{ key: string; value: string }>>([]);
  // Advanced voice
  const [similarityBoost, setSimilarityBoost] = useState(0.5);
  const [style, setStyle] = useState(0);
  const [useSpeakerBoost, setUseSpeakerBoost] = useState(true);
  const [expressiveMode, setExpressiveMode] = useState(true);
  const [languageBoost, setLanguageBoost] = useState('English');
  // Transcription
  const [sttModel, setSttModel] = useState('');
  const [sttLanguage, setSttLanguage] = useState('');
  const [eotThreshold, setEotThreshold] = useState(0.8);
  const [eotTimeoutMs, setEotTimeoutMs] = useState(5000);
  const [userIdleSecs, setUserIdleSecs] = useState(0);
  const [postCall, setPostCall] = useState(false);
  // Call quality and behaviour
  const [userIdleReplySecs, setUserIdleReplySecs] = useState(10);
  const [noiseSuppression, setNoiseSuppression] = useState<NoiseSuppression>('disabled');
  const [fallbackDestination, setFallbackDestination] = useState('');
  const [voicemailDetection, setVoicemailDetection] = useState(false);
  const [voicemailAction, setVoicemailAction] = useState<VoicemailAction>('hangup');
  const [disableDtmf, setDisableDtmf] = useState(false);
  const [disableGreetingInterruption, setDisableGreetingInterruption] = useState(false);
  const [interruptThreshold, setInterruptThreshold] = useState<number | null>(null);
  const [dynamicVarsWebhook, setDynamicVarsWebhook] = useState('');
  const [smsEnabled, setSmsEnabled] = useState(false);
  const [dataRetention, setDataRetention] = useState(true);

  // Tools / Workflows
  const [tools, setTools] = useState<AssistantTool[]>([]);
  const [editingTool, setEditingTool] = useState<AssistantTool | null>(null);
  const [toolModalOpen, setToolModalOpen] = useState(false);
  const [toolError, setToolError] = useState<string | null>(null);
  const [toolBusy, setToolBusy] = useState(false);

  // Prompt helpers
  const promptRef = React.useRef<HTMLTextAreaElement>(null);

  // On mount, pull the live agent config so the UI reflects reality.
  const loadAgent = () => {
    setAgentLoading(true);
    setAgentError(null);
    getAssistant()
      .then((a) => {
        setAssistantName(a.name);
        setSystemPrompt(stripTone(a.instructions));
        const t = extractTone(a.instructions);
        if (t) setTone(t as typeof tone);
        setGreeting(a.greeting);
        setModel(a.model);
        setVoice(a.voice);
        setVoiceSpeed(a.voice_speed);
        setBackgroundAudio(a.background_audio);
        setAllowInterruptions(a.allow_interruptions);
        setRecordCalls(a.record_calls);
        setMaxCallMins(Math.round((a.max_call_secs || 1800) / 60));
        setDynamicVars(Object.entries(a.dynamic_variables || {}).map(([key, value]) => ({ key, value: String(value) })));
        setSimilarityBoost(a.similarity_boost);
        setStyle(a.style);
        setUseSpeakerBoost(a.use_speaker_boost);
        setExpressiveMode(a.expressive_mode);
        setLanguageBoost(a.language_boost);
        setSttModel(a.stt_model);
        setSttLanguage(a.stt_language);
        setEotThreshold(a.eot_threshold);
        setEotTimeoutMs(a.eot_timeout_ms);
        setUserIdleSecs(a.user_idle_timeout_secs);
        setPostCall(a.post_call_processing);
        setUserIdleReplySecs(a.user_idle_reply_secs);
        setNoiseSuppression(a.noise_suppression);
        setFallbackDestination(a.fallback_destination);
        setVoicemailDetection(a.voicemail_detection);
        setVoicemailAction(a.voicemail_action);
        setDisableDtmf(a.disable_dtmf);
        setDisableGreetingInterruption(a.disable_greeting_interruption);
        setInterruptThreshold(a.interrupt_prediction_threshold);
        setDynamicVarsWebhook(a.dynamic_variables_webhook_url);
        setSmsEnabled((a.enabled_features || []).includes('messaging'));
        setDataRetention(a.data_retention);
        setTools(a.tools || []);
      })
      .catch((e) => setAgentError(e.message))
      .finally(() => setAgentLoading(false));
    listModels().then(setModels);
  };

  const setVar = (i: number, patch: Partial<{ key: string; value: string }>) =>
    setDynamicVars((vs) => vs.map((v, k) => (k === i ? { ...v, ...patch } : v)));
  const addVar = () => setDynamicVars((vs) => [...vs, { key: '', value: '' }]);
  const removeVar = (i: number) => setDynamicVars((vs) => vs.filter((_, k) => k !== i));

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();

    // 1) Local org settings (drives the rest of the mock UI).
    updateOrgSettings({
      aiAgentName: aiName,
      aiTone: tone,
      aiSystemPrompt: systemPrompt,
      // businessHours is no longer written from here. Contact hours live in
      // strategy.guardrails, which is what both schedulers read, and
      // ContactWindowCard saves them on its own.
    });

    // 2) Deploy prompt + tone + voice + call behavior to the live AI voice agent.
    setDeploying(true);
    setDeployError(null);
    try {
      const dynamic_variables = dynamicVars.reduce((acc, { key, value }) => {
        if (key.trim()) acc[key.trim()] = value;
        return acc;
      }, {} as Record<string, string>);

      await updateAssistant({
        instructions: applyTone(systemPrompt, tone),
        greeting,
        model,
        voice: voice || undefined,
        voice_speed: voiceSpeed,
        background_audio: backgroundAudio,
        similarity_boost: similarityBoost,
        style,
        use_speaker_boost: useSpeakerBoost,
        expressive_mode: expressiveMode,
        language_boost: languageBoost,
        stt_model: sttModel || undefined,
        stt_language: sttLanguage || undefined,
        eot_threshold: eotThreshold,
        eot_timeout_ms: eotTimeoutMs,
        allow_interruptions: allowInterruptions,
        record_calls: recordCalls,
        max_call_secs: Math.max(60, maxCallMins * 60),
        user_idle_timeout_secs: userIdleSecs,
        user_idle_reply_secs: userIdleReplySecs,
        post_call_processing: postCall,
        noise_suppression: noiseSuppression,
        fallback_destination: fallbackDestination,
        voicemail_detection: voicemailDetection,
        voicemail_action: voicemailAction,
        disable_dtmf: disableDtmf,
        disable_greeting_interruption: disableGreetingInterruption,
        interrupt_prediction_threshold: interruptThreshold,
        dynamic_variables,
        dynamic_variables_webhook_url: dynamicVarsWebhook,
        enabled_features: smsEnabled ? ['telephony', 'messaging'] : ['telephony'],
        data_retention: dataRetention,
        // `tools` is deliberately absent. Tools are saved the moment they are
        // edited, through their own endpoint, so that saving this form can
        // never silently rewrite them — and so a shared tool is never forked
        // into a private copy. See the Tools card below.
      });
      setSavedSuccess(true);
      setTimeout(() => setSavedSuccess(false), 3000);
    } catch (err: any) {
      setDeployError(err.message || 'Failed to deploy to AI agent');
    } finally {
      setDeploying(false);
    }
  };

  /**
   * Tools are written on their own, not with the rest of the form.
   *
   * Each of these sends the assistant's complete list of OWNED tools — shared
   * ones are filtered out, because they are attached by reference and the
   * server re-attaches them afterwards. Writing one back inline would fork it
   * into a private copy that stops tracking the library.
   */
  const ownedTools = () => tools.filter((t) => !t.shared);

  const persistTools = async (next: AssistantTool[]) => {
    setToolError(null);
    setToolBusy(true);
    try {
      const a = await saveTools(next);
      setTools(a.tools || []);
    } catch (e: any) {
      setToolError(e?.message || 'Could not save tools.');
      throw e;
    } finally {
      setToolBusy(false);
    }
  };

  const saveTool = async (tool: AssistantTool) => {
    const owned = ownedTools();
    // Identity by position: `editingTool` is the very object out of `tools`, so
    // indexOf finds the one being edited even when two tools look alike.
    const i = editingTool ? owned.indexOf(editingTool) : -1;
    await persistTools(i >= 0 ? owned.map((t, j) => (j === i ? tool : t)) : [...owned, tool]);
  };

  const removeTool = async (tool: AssistantTool) => {
    if (!confirm(`Remove "${toolLabel(tool)}" from this agent?`)) return;
    setToolError(null);
    setToolBusy(true);
    try {
      // A shared tool is detached by id and survives in the library; an owned
      // one only exists here, so removing it from the list is the deletion.
      const a = tool.shared && tool.id
        ? await detachTool(tool.id)
        : await saveTools(ownedTools().filter((t) => t !== tool));
      setTools(a.tools || []);
    } catch (e: any) {
      setToolError(e?.message || 'Could not remove the tool.');
    } finally {
      setToolBusy(false);
    }
  };

  /** Inserts a variable at the cursor, rather than at the end of the prompt. */
  const insertVariable = (name: string) => {
    const el = promptRef.current;
    const token = `{{${name}}}`;
    if (!el) {
      setSystemPrompt((p) => `${p}${token}`);
      return;
    }
    const start = el.selectionStart ?? systemPrompt.length;
    const end = el.selectionEnd ?? start;
    setSystemPrompt(systemPrompt.slice(0, start) + token + systemPrompt.slice(end));
    // After React repaints, put the caret after what was just inserted so the
    // user can keep typing mid-sentence.
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto text-slate-100">
      
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight">AI Assistant</h2>
          <p className="text-xs text-slate-400">
            The prompt, voice and outreach strategy your AI agent uses on every lead.
          </p>
        </div>

        {savedSuccess && (
          <div className="flex items-center gap-1.5 text-xs text-emerald-400 font-semibold bg-emerald-950/60 border border-emerald-800/40 px-3 py-1.5 rounded-xl">
            <CheckCircle2 className="w-4 h-4" />
            <span>AI agent settings saved &amp; deployed</span>
          </div>
        )}
        {deployError && (
          <div className="flex items-center gap-1.5 text-xs text-rose-300 font-semibold bg-rose-950/60 border border-rose-800/40 px-3 py-1.5 rounded-xl">
            <AlertTriangle className="w-4 h-4" />
            <span>Deploy failed: {deployError}</span>
          </div>
        )}
      </div>

      {/* The connection itself is made on Integrations & Webhooks. This page
          only reports what that connection is, and sends you there if there
          isn't one — a prompt editor should not open on a credentials form. */}
      {status === null && (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-xl text-xs text-slate-400 flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Checking your Telnyx connection…
        </div>
      )}

      {status && !(status.connected && status.hasAssistant) && (
        <div className="bg-slate-900/90 border border-amber-500/40 rounded-2xl p-5 shadow-xl flex flex-col md:flex-row md:items-center gap-4">
          <div className="w-10 h-10 rounded-xl bg-amber-500/20 text-amber-300 flex items-center justify-center border border-amber-500/30 shrink-0">
            <Plug className="w-5 h-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-bold text-white">
              {status.connected
                ? 'No AI assistant on your Telnyx account yet'
                : 'Telnyx account not connected'}
            </h3>
            <p className="text-xs text-slate-400 mt-1 leading-relaxed">
              {status.connected ? (
                <>
                  Your Telnyx credentials are saved, but there is no assistant to configure. Create
                  or attach one on{' '}
                  <span className="text-slate-200">Integrations &amp; Webhooks</span>, then come back
                  to write its prompt and tone.
                </>
              ) : (
                <>
                  Please connect your Telnyx account from the{' '}
                  <span className="text-slate-200">Integrations &amp; Webhooks</span> page. Prompt,
                  tone and voice settings are written straight to the live agent, so there is nothing
                  to edit until it exists.
                </>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setActiveView('integrations')}
            className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-xl text-xs flex items-center justify-center gap-1.5 shadow-md shadow-amber-950 transition-colors cursor-pointer shrink-0"
          >
            Go to Integrations &amp; Webhooks
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      )}

      {status && status.connected && status.hasAssistant && (
      <form onSubmit={handleSave} className="space-y-6">

        {/* What the agent is actually running on. Read-only: the credentials
            are edited on Integrations & Webhooks, and showing a Disconnect
            here would be a second, competing place to break the connection.
            The agent switcher stays — picking which assistant you are editing
            is part of editing it. */}
        <div className="bg-slate-900/90 border border-emerald-500/40 rounded-2xl p-5 shadow-xl space-y-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-9 h-9 rounded-xl bg-violet-600/20 text-violet-300 flex items-center justify-center border border-violet-500/30 shrink-0">
                <PhoneCall className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  {status.label || 'Telnyx connected'}
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                </h3>
                <p className="text-xs text-slate-400">
                  {status.accountCount > 1
                    ? `This agent runs on the active one of your ${status.accountCount} Telnyx accounts.`
                    : 'This agent calls and texts from your own Telnyx account.'}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setActiveView('integrations')}
              className="text-xs font-semibold text-slate-400 hover:text-slate-200 border border-slate-800 hover:border-slate-600 rounded-lg px-2.5 py-1 flex items-center gap-1.5 transition-colors cursor-pointer shrink-0"
            >
              Manage connection
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Capability, not credentials.
              The four tiles here used to print the masked API key, the from
              number, the assistant id and the connect date. The key is a secret
              even masked and belongs nowhere near a settings page; the id is an
              internal handle nobody acts on; and the number is already shown, in
              full and with its controls, by PhoneNumberCard directly below —
              so it was duplication as well as noise. What is left is the only
              question this card exists to answer: can this agent call and text
              right now? */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="flex items-center gap-2.5 bg-slate-950 border border-emerald-800/40 rounded-xl px-3.5 py-2.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <div className="min-w-0">
                <div className="text-xs font-semibold text-slate-100">Voice calls</div>
                <div className="text-xs text-emerald-400">Ready</div>
              </div>
            </div>

            <div
              className={`flex items-center gap-2.5 bg-slate-950 rounded-xl px-3.5 py-2.5 border ${
                status.hasMessaging ? 'border-emerald-800/40' : 'border-amber-800/50'
              }`}
            >
              {status.hasMessaging ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              ) : (
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
              )}
              <div className="min-w-0">
                <div className="text-xs font-semibold text-slate-100">SMS messaging</div>
                <div
                  className={`text-xs ${status.hasMessaging ? 'text-emerald-400' : 'text-amber-400'}`}
                >
                  {status.hasMessaging
                    ? 'Ready'
                    : 'Assign your number to a Messaging Profile'}
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 flex-wrap pt-1 border-t border-slate-800">
            <p className="text-xs text-slate-500 min-w-0">
              {status.connectedAt
                ? `Connected ${new Date(status.connectedAt).toLocaleDateString(undefined, {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  })}`
                : 'Connected'}
              {status.accountCount > 1 && ` · ${status.accountCount} accounts on file`}
            </p>

            {assistants.length > 0 && (
              <div className="flex items-center gap-2 text-xs ml-auto shrink-0">
                <span className="text-slate-400">Editing agent:</span>
                <select
                  value={status.assistantId}
                  onChange={(e) => switchAgent(e.target.value)}
                  disabled={switching}
                  className="bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1 text-white focus:outline-none focus:border-emerald-500 max-w-[220px]"
                >
                  {assistants.map((a) => (
                    <option key={a.id} value={a.id}>{a.name || a.id}</option>
                  ))}
                </select>
                {switching && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />}
              </div>
            )}
          </div>
        </div>

        <PhoneNumberCard status={status} onChange={refreshStatus} />

        {/* Core Persona & Strategy */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-amber-400" />
              AI Voice Persona
            </h3>
            <div className="flex items-center gap-2 text-xs">
              {agentLoading ? (
                <span className="flex items-center gap-1 text-slate-400"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading live agent…</span>
              ) : agentError ? (
                <span className="flex items-center gap-1 text-amber-400" title={agentError}>
                  <AlertTriangle className="w-3.5 h-3.5" /> Agent offline — editing local draft
                </span>
              ) : (
                <span className="flex items-center gap-1 text-emerald-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" /> Live: {assistantName}
                </span>
              )}
              <button type="button" onClick={loadAgent} className="text-slate-500 hover:text-slate-300" title="Reload from agent">
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div>
              <label className="block text-slate-300 font-semibold mb-1">AI Assistant Name</label>
              <input
                type="text"
                value={aiName}
                onChange={(e) => setAiName(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-white focus:outline-none focus:border-emerald-500"
              />
              <span className="text-xs text-slate-500 mt-1 block">Used in voice call greetings & SMS sender IDs</span>
            </div>

            <div>
              <label className="block text-slate-300 font-semibold mb-1">Conversational Tone</label>
              <select
                value={tone}
                onChange={(e) => setTone(e.target.value as any)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-white focus:outline-none focus:border-emerald-500"
              >
                <option value="Conversational">Conversational (Natural, Warm, Human-like)</option>
                <option value="Professional">Professional (Polished, Consultative, Corporate)</option>
                <option value="Friendly">Friendly (Casual, Enthusiastic)</option>
                <option value="Concise">Concise (Fast, Direct, Low-word count)</option>
              </select>
            </div>

            <div>
              <label className="block text-slate-300 font-semibold mb-1">Greeting</label>
              <input
                type="text"
                value={greeting}
                onChange={(e) => setGreeting(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-white focus:outline-none focus:border-emerald-500"
              />
              <span className="text-xs text-slate-500 mt-1 block">First line the agent speaks on a call</span>
            </div>

            <div>
              <label className="block text-slate-300 font-semibold mb-1">Language Model</label>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-white focus:outline-none focus:border-emerald-500"
              >
                {models.length === 0 && <option value={model}>{model || 'Loading…'}</option>}
                {models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <span className="text-xs text-slate-500 mt-1 block">The LLM powering the conversation</span>
            </div>
          </div>

          <div>
            <label className="block text-slate-300 font-semibold mb-1 flex items-center gap-1.5">
              <Wand2 className="w-3.5 h-3.5 text-emerald-400" />
              AI System Prompt
              <span className="text-xs text-slate-500 font-normal">— deployed live to your AI voice agent on save</span>
            </label>
            <textarea
              ref={promptRef}
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={9}
              spellCheck={false}
              placeholder="Describe how the AI agent should behave and what it must collect…"
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-white text-xs leading-relaxed font-mono focus:outline-none focus:border-emerald-500 resize-y"
            />
            <span className="text-xs text-slate-500 mt-1 block">
              The selected <span className="text-slate-300">Conversational Tone</span> is appended to this prompt automatically when deployed.
            </span>

            {/* Variable picker. Every name here is one the backend really sends
                when a call is answered, so nothing offered renders as braces. */}
            <div className="mt-3">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Insert lead details
              </span>
              <p className="text-xs text-slate-500 mt-0.5 mb-1.5">
                Click to drop one in at the cursor. Each is filled with this lead's own details when the call
                connects.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {LEAD_VARIABLES.map((v) => (
                  <button
                    key={v.name}
                    type="button"
                    onClick={() => insertVariable(v.name)}
                    title={`e.g. ${v.example}`}
                    className="px-2 py-1 bg-slate-950 border border-slate-800 hover:border-emerald-600 hover:text-emerald-300 text-slate-400 rounded-md text-xs font-mono cursor-pointer transition"
                  >
                    {`{{${v.name}}}`}
                  </button>
                ))}
              </div>
            </div>

          </div>

        </div>

        {/* Outbound Communication Strategy — its own block */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <Sliders className="w-4 h-4 text-emerald-400" />
            Outbound Communication Strategy
            <span className="text-xs text-slate-500 font-normal">— the voice &amp; SMS sequence run for every new lead</span>
          </h3>
          <StrategyEditor />
        </div>

        {/* Voice & Call Behavior */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <Sliders className="w-4 h-4 text-emerald-400" />
            Voice &amp; Call Behavior
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div className="md:col-span-2">
              <label className="block text-slate-300 font-semibold mb-1">
                Voice ID <span className="text-slate-500 font-normal">— from your voice library</span>
              </label>
              <input
                type="text"
                value={voice}
                onChange={(e) => setVoice(e.target.value)}
                placeholder="Enter a voice ID"
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-white font-mono focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div>
              <label className="block text-slate-300 font-semibold mb-1">Speaking Pace ({voiceSpeed.toFixed(2)}×)</label>
              <input
                type="range" min={0.5} max={2} step={0.05}
                value={voiceSpeed}
                onChange={(e) => setVoiceSpeed(Number(e.target.value))}
                className="w-full accent-emerald-500"
              />
            </div>

            <div>
              <label className="block text-slate-300 font-semibold mb-1">Background Sound</label>
              <select
                value={backgroundAudio}
                onChange={(e) => setBackgroundAudio(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-white focus:outline-none focus:border-emerald-500 capitalize"
              >
                {BACKGROUND_AUDIO_OPTIONS.map((o) => (
                  <option key={o} value={o}>{o.replace('_', ' ')}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-slate-300 font-semibold mb-1">Max Call Length (minutes)</label>
              <input
                type="number" min={1} max={120}
                value={maxCallMins}
                onChange={(e) => setMaxCallMins(Number(e.target.value))}
                className="w-32 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-white focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div className="flex items-end gap-6">
              {[
                { label: 'Record Calls', on: recordCalls, set: setRecordCalls },
                { label: 'Allow Interruptions', on: allowInterruptions, set: setAllowInterruptions },
              ].map(({ label, on, set }) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => set(!on)}
                  className="flex items-center gap-2 text-slate-300"
                >
                  <span className={`w-9 h-5 rounded-full transition-colors relative ${on ? 'bg-emerald-600' : 'bg-slate-700'}`}>
                    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-on-accent transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
                  </span>
                  <span className="font-semibold">{label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Call Quality & Reliability — the settings that decide whether a call
            is worth having at all, rather than how it sounds. */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <PhoneCall className="w-4 h-4 text-sky-400" />
            Call Quality &amp; Reliability
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div>
              <label className="block text-slate-300 font-semibold mb-1">Background Noise Removal</label>
              <select
                value={noiseSuppression}
                onChange={(e) => setNoiseSuppression(e.target.value as NoiseSuppression)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-white focus:outline-none focus:border-emerald-500"
              >
                {NOISE_SUPPRESSION_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <span className="text-xs text-slate-500 mt-1 block">
                Strips road and office noise from the caller's side before the agent hears it.
              </span>
            </div>

            <div>
              <label className="block text-slate-300 font-semibold mb-1">
                If the agent fails, send the call to
              </label>
              <input
                type="tel"
                value={fallbackDestination}
                onChange={(e) => setFallbackDestination(e.target.value)}
                placeholder="+15125550147"
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-white font-mono focus:outline-none focus:border-emerald-500"
              />
              <span className="text-xs text-slate-500 mt-1 block">
                Leave blank to hang up instead. A caller hearing silence is worse than a caller hearing a person.
              </span>
            </div>

            <div>
              <label className="block text-slate-300 font-semibold mb-1">
                Check in after silence (seconds)
              </label>
              <input
                type="number" min={0} max={120}
                value={userIdleReplySecs}
                onChange={(e) => setUserIdleReplySecs(Number(e.target.value))}
                className="w-32 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-white focus:outline-none focus:border-emerald-500"
              />
              <span className="text-xs text-slate-500 mt-1 block">
                How long the agent waits before asking "are you still there?".
              </span>
            </div>

            <div>
              <label className="block text-slate-300 font-semibold mb-1">
                Interruption sensitivity
                <span className="text-slate-500 font-normal ml-1">
                  {interruptThreshold == null ? '— automatic' : interruptThreshold.toFixed(2)}
                </span>
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="range" min={0} max={1} step={0.05}
                  value={interruptThreshold ?? 0.5}
                  onChange={(e) => setInterruptThreshold(Number(e.target.value))}
                  disabled={interruptThreshold == null}
                  className="flex-1 accent-emerald-500 disabled:opacity-40"
                />
                <button
                  type="button"
                  onClick={() => setInterruptThreshold(interruptThreshold == null ? 0.5 : null)}
                  className="text-xs font-semibold text-emerald-400 hover:text-emerald-300 whitespace-nowrap cursor-pointer"
                >
                  {interruptThreshold == null ? 'Set manually' : 'Automatic'}
                </button>
              </div>
              <span className="text-xs text-slate-500 mt-1 block">
                Higher means the agent is more certain before it stops talking. Raise it if it keeps cutting
                itself off on "mm-hmm".
              </span>
            </div>

            <div className="md:col-span-2 flex flex-wrap items-center gap-x-6 gap-y-3 pt-1">
              {[
                {
                  label: 'Detect voicemail',
                  icon: <Voicemail className="w-3.5 h-3.5" />,
                  on: voicemailDetection,
                  set: setVoicemailDetection,
                  hint: 'Stops the agent pitching an answering machine.',
                },
                {
                  label: 'Let callers interrupt the greeting',
                  on: !disableGreetingInterruption,
                  set: (v: boolean) => setDisableGreetingInterruption(!v),
                  hint: '',
                },
                {
                  label: 'Ignore keypad presses',
                  on: disableDtmf,
                  set: setDisableDtmf,
                  hint: '',
                },
              ].map(({ label, icon, on, set, hint }) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => set(!on)}
                  title={hint}
                  className="flex items-center gap-2 text-slate-300 cursor-pointer"
                >
                  <span className={`w-9 h-5 rounded-full transition-colors relative shrink-0 ${on ? 'bg-emerald-600' : 'bg-slate-700'}`}>
                    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-on-accent transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
                  </span>
                  <span className="font-semibold flex items-center gap-1.5">{icon}{label}</span>
                </button>
              ))}
            </div>

            {voicemailDetection && (
              <div className="md:col-span-2">
                <label className="block text-slate-300 font-semibold mb-1">When it reaches voicemail</label>
                <select
                  value={voicemailAction}
                  onChange={(e) => setVoicemailAction(e.target.value as VoicemailAction)}
                  className="w-full md:w-72 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-white focus:outline-none focus:border-emerald-500"
                >
                  <option value="hangup">Hang up without leaving a message</option>
                  <option value="leave_message">Leave a message</option>
                </select>
              </div>
            )}
          </div>
        </div>

        {/* Channels & Data */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-emerald-400" />
            Channels &amp; Data
          </h3>

          <div className="space-y-4 text-xs">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              {[
                {
                  label: 'Let this agent handle SMS too',
                  on: smsEnabled,
                  set: setSmsEnabled,
                },
                {
                  label: 'Keep conversation history at the provider',
                  on: dataRetention,
                  set: setDataRetention,
                },
              ].map(({ label, on, set }) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => set(!on)}
                  className="flex items-center gap-2 text-slate-300 cursor-pointer"
                >
                  <span className={`w-9 h-5 rounded-full transition-colors relative shrink-0 ${on ? 'bg-emerald-600' : 'bg-slate-700'}`}>
                    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-on-accent transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
                  </span>
                  <span className="font-semibold">{label}</span>
                </button>
              ))}
            </div>

            <div>
              <label className="block text-slate-300 font-semibold mb-1">
                Fetch lead details from your own URL
                <span className="text-slate-500 font-normal ml-1">— optional</span>
              </label>
              <input
                type="url"
                value={dynamicVarsWebhook}
                onChange={(e) => setDynamicVarsWebhook(e.target.value)}
                placeholder="https://your-portal.com/api/assistant/context"
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-white font-mono focus:outline-none focus:border-emerald-500"
              />
              <span className="text-xs text-slate-500 mt-1 block">
                Called as each conversation starts, to pull the newest details rather than whatever was true when
                the call was scheduled. The lead's own fields are already sent without this.
              </span>
            </div>
          </div>
        </div>

        {/* Advanced Voice */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-fuchsia-400" />
            Advanced Voice
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div>
              <label className="block text-slate-300 font-semibold mb-1">Similarity / Clarity ({similarityBoost.toFixed(2)})</label>
              <input type="range" min={0} max={1} step={0.05} value={similarityBoost} onChange={(e) => setSimilarityBoost(Number(e.target.value))} className="w-full accent-emerald-500" />
            </div>
            <div>
              <label className="block text-slate-300 font-semibold mb-1">Style / Expressiveness ({style.toFixed(2)})</label>
              <input type="range" min={0} max={1} step={0.05} value={style} onChange={(e) => setStyle(Number(e.target.value))} className="w-full accent-emerald-500" />
            </div>
            <div>
              <label className="block text-slate-300 font-semibold mb-1">Language Boost</label>
              <select value={languageBoost} onChange={(e) => setLanguageBoost(e.target.value)} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-white focus:outline-none focus:border-emerald-500">
                {LANGUAGE_BOOST_OPTIONS.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-slate-300 font-semibold mb-1">Idle Timeout (seconds, 0 = off)</label>
              <input type="number" min={0} max={120} value={userIdleSecs} onChange={(e) => setUserIdleSecs(Number(e.target.value))} className="w-32 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-white focus:outline-none focus:border-emerald-500" />
            </div>
            <div className="flex items-end gap-6 md:col-span-2">
              {[
                { label: 'Speaker Boost', on: useSpeakerBoost, set: setUseSpeakerBoost },
                { label: 'Expressive Mode', on: expressiveMode, set: setExpressiveMode },
              ].map(({ label, on, set }) => (
                <button key={label} type="button" onClick={() => set(!on)} className="flex items-center gap-2 text-slate-300">
                  <span className={`w-9 h-5 rounded-full transition-colors relative ${on ? 'bg-emerald-600' : 'bg-slate-700'}`}>
                    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-on-accent transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
                  </span>
                  <span className="font-semibold">{label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Transcription / STT */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-cyan-400" />
            Transcription (Speech-to-Text)
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div>
              <label className="block text-slate-300 font-semibold mb-1">STT Model</label>
              <input value={sttModel} onChange={(e) => setSttModel(e.target.value)} placeholder="deepgram/flux" className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-white font-mono focus:outline-none focus:border-emerald-500" />
            </div>
            <div>
              <label className="block text-slate-300 font-semibold mb-1">Language</label>
              <input value={sttLanguage} onChange={(e) => setSttLanguage(e.target.value)} placeholder="en" className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-white focus:outline-none focus:border-emerald-500" />
            </div>
            <div>
              <label className="block text-slate-300 font-semibold mb-1">End-of-turn Sensitivity ({eotThreshold.toFixed(2)})</label>
              <input type="range" min={0} max={1} step={0.05} value={eotThreshold} onChange={(e) => setEotThreshold(Number(e.target.value))} className="w-full accent-emerald-500" />
            </div>
            <div>
              <label className="block text-slate-300 font-semibold mb-1">End-of-turn Timeout (ms)</label>
              <input type="number" min={500} max={15000} step={100} value={eotTimeoutMs} onChange={(e) => setEotTimeoutMs(Number(e.target.value))} className="w-40 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-white focus:outline-none focus:border-emerald-500" />
            </div>
          </div>
        </div>

        {/* Post-Call Processing */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-3 shadow-xl">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            Post-Call Processing
          </h3>
          <p className="text-xs text-slate-400">
            When enabled, the agent analyzes each finished call — generating a summary and extracting insights
            (budget, timeline, financing, etc.) automatically.
          </p>
          <button type="button" onClick={() => setPostCall(!postCall)} className="flex items-center gap-2 text-slate-300 text-xs">
            <span className={`w-9 h-5 rounded-full transition-colors relative ${postCall ? 'bg-emerald-600' : 'bg-slate-700'}`}>
              <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-on-accent transition-all ${postCall ? 'left-[18px]' : 'left-0.5'}`} />
            </span>
            <span className="font-semibold">{postCall ? 'Enabled' : 'Disabled'}</span>
          </button>
        </div>

        {/* Tools / Workflows — created, edited and tested here. */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
          <div className="flex items-start justify-between gap-3">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Sliders className="w-4 h-4 text-amber-400" />
              Tools / Workflows <span className="text-xs text-slate-500 font-normal">— what the agent can do during a call</span>
            </h3>
            <button
              onClick={() => { setEditingTool(null); setToolModalOpen(true); }}
              disabled={toolBusy}
              className="shrink-0 px-3 py-1.5 bg-emerald-600/20 border border-emerald-600/40 text-emerald-300 rounded-lg text-xs font-bold hover:bg-emerald-600/30 disabled:opacity-50 flex items-center gap-1 cursor-pointer"
            >
              <Plus className="w-3 h-3" /> Add tool
            </button>
          </div>

          {toolError && (
            <div className="text-xs text-rose-300 bg-rose-950/40 border border-rose-800/40 rounded-lg px-3 py-2">
              {toolError}
            </div>
          )}

          <div className="space-y-2 text-xs">
            {tools.length === 0 && (
              <p className="text-slate-500">
                No tools yet. Without one the agent can only talk — it cannot transfer a call, hang up or tell
                your portal what it learned.
              </p>
            )}
            {tools.map((t, i) => (
              <div key={t.id ?? i} className="p-3 bg-slate-950/60 rounded-xl border border-slate-800 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className="font-semibold text-slate-200 flex items-center gap-1.5">
                    {toolLabel(t)}
                    {t.shared && (
                      <span
                        className="text-2xs uppercase font-mono tracking-wide text-sky-400 bg-sky-950/50 border border-sky-800/50 rounded px-1 py-0.5 flex items-center gap-1"
                        title="Shared across your agents. Edit it in the provider console; removing it here only detaches it."
                      >
                        <Lock className="w-2.5 h-2.5" /> shared
                      </span>
                    )}
                  </span>
                  {t.type === 'transfer' && (
                    <span className="text-slate-500 block mt-0.5">
                      Targets: {(t.transfer?.targets || []).map((x: any) => x.name || x.to).join(', ')}
                    </span>
                  )}
                  {t.type === 'webhook' && (
                    <span className="text-slate-500 block mt-0.5 font-mono break-all">
                      {t.webhook?.method ?? 'POST'} {t.webhook?.url}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {/* A shared tool is edited where it lives, not here: this
                      agent is one of several using it. */}
                  {!t.shared && (
                    <button
                      onClick={() => { setEditingTool(t); setToolModalOpen(true); }}
                      disabled={toolBusy}
                      className="p-1.5 text-slate-400 hover:text-emerald-300 disabled:opacity-50 cursor-pointer"
                      aria-label={`Edit ${toolLabel(t)}`}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    onClick={() => removeTool(t)}
                    disabled={toolBusy}
                    className="p-1.5 text-slate-400 hover:text-rose-400 disabled:opacity-50 cursor-pointer"
                    aria-label={`Remove ${toolLabel(t)}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>

          <p className="text-xs text-slate-500">
            Tools save as soon as you add or edit one — they are not part of the Deploy button above.
            The one worth adding first: a <span className="text-slate-300 font-mono">report_qualification</span> webhook to
            <span className="text-slate-300 font-mono"> /api/leads/&#123;&#123;leadId&#125;&#125;/qualified</span>, so the agent reports
            hot/warm/cold and hands the lead off by itself.
          </p>
        </div>

        {/* Dynamic Variables */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Building2 className="w-4 h-4 text-cyan-400" />
              Dynamic Variables <span className="text-xs text-slate-500 font-normal">— injected into the prompt as {'{{key}}'}</span>
            </h3>
            <button type="button" onClick={addVar} className="text-xs text-emerald-400 font-semibold hover:text-emerald-300">+ Add variable</button>
          </div>

          <div className="space-y-2 text-xs">
            {dynamicVars.length === 0 && <p className="text-slate-500">No variables. Add company name, phone, hours…</p>}
            {dynamicVars.map((v, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  value={v.key}
                  onChange={(e) => setVar(i, { key: e.target.value })}
                  placeholder="company_name"
                  className="w-48 bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-white font-mono focus:outline-none focus:border-emerald-500"
                />
                <input
                  value={v.value}
                  onChange={(e) => setVar(i, { value: e.target.value })}
                  placeholder="Austin Home Advisors"
                  className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-white focus:outline-none focus:border-emerald-500"
                />
                <button type="button" onClick={() => removeVar(i)} className="text-rose-400 hover:text-rose-300 px-2">✕</button>
              </div>
            ))}
          </div>
        </div>

        {/* The real org-wide guardrails, read by BOTH schedulers. The card
            that used to be here bound to the browser's demo store, so editing
            the contact hours changed nothing the engine ever saw. */}
        <ContactWindowCard blurb="When the AI agent may contact a lead, and how hard it may try. The same window governs every follow-up sequence." />

        <LeadTemperatureCard />

        {/* Statements of behaviour, not settings — nothing here is editable. */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-3 shadow-xl">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            Compliance
          </h3>
          <div className="p-2.5 bg-slate-950 rounded-lg border border-slate-800 text-xs text-slate-300 space-y-1">
            <div className="text-emerald-400 font-semibold">Strict TCPA STOP enforcement: active</div>
            <p className="text-slate-400">
              A reply of "STOP", "UNSUBSCRIBE" or similar sets do-not-contact and cancels every
              scheduled step, in the strategy and in every sequence.
            </p>
          </div>
          <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800 text-xs text-slate-400 space-y-1">
            <span className="font-semibold text-slate-200">Strict non-goals enforced in the system prompt:</span>
            <p>The AI agent never gives legal advice, never guarantees mortgage approval, never makes unverified pricing promises, and escalates to a human whenever uncertain.</p>
          </div>
        </div>

        {/* Submit */}
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={deploying}
            className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-on-accent rounded-xl text-xs font-bold shadow-lg shadow-emerald-950 flex items-center gap-2 transition-colors cursor-pointer"
          >
            {deploying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            <span>{deploying ? 'Deploying to AI agent…' : 'Save Configuration'}</span>
          </button>
        </div>

      </form>
      )}

      {/* Outside the form on purpose: the modal saves through its own endpoint,
          and nesting it here would make Enter inside it submit the whole page. */}
      {toolModalOpen && (
        <ToolEditorModal
          tool={editingTool}
          onClose={() => { setToolModalOpen(false); setEditingTool(null); }}
          onSave={saveTool}
        />
      )}

    </div>
  );
};
