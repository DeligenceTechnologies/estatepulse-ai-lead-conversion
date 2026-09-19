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
  ArrowRight
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
  AssistantTool,
  toolLabel,
} from '../../utils/assistantApi';
import { StrategyEditor } from './StrategyEditor';
import { PhoneNumberCard } from './PhoneNumberCard';

export const AISettingsView: React.FC = () => {
  const { orgSettings, updateOrgSettings, setActiveView } = useApp();

  const [aiName, setAiName] = useState(orgSettings.aiAgentName);
  const [tone, setTone] = useState(orgSettings.aiTone);
  const [systemPrompt, setSystemPrompt] = useState(orgSettings.aiSystemPrompt);
  const [startHour, setStartHour] = useState(orgSettings.businessHours.start);
  const [endHour, setEndHour] = useState(orgSettings.businessHours.end);
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
  // Tools / Workflows
  const [tools, setTools] = useState<AssistantTool[]>([]);

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
      businessHours: {
        ...orgSettings.businessHours,
        start: startHour,
        end: endHour,
      }
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
        post_call_processing: postCall,
        dynamic_variables,
        // NOTE: `tools` is intentionally NOT sent — the agent uses provider-managed shared tools
        // (attached by reference), which can't be safely replaced via a full inline array.
        // Manage tools in the provider console; this card is view-only.
      });
      setSavedSuccess(true);
      setTimeout(() => setSavedSuccess(false), 3000);
    } catch (err: any) {
      setDeployError(err.message || 'Failed to deploy to AI agent');
    } finally {
      setDeploying(false);
    }
  };

  const qualificationChecklist = [
    { label: 'Buying Intent (Move-in vs Investment vs Relocation)', required: true },
    { label: 'Timeline to Purchase (<30 days, 1-3 mos, 3-6 mos)', required: true },
    { label: 'Target Location & Submarkets (North Austin, Round Rock)', required: true },
    { label: 'Budget Range (Min & Max)', required: true },
    { label: 'Property Type & Minimum Bedrooms (e.g. 4 beds, Single Family)', required: false },
    { label: 'Financing Status & Lender Pre-approval Letter', required: false },
    { label: 'Primary Motivation (Schools, backyard, lease expiration)', required: false },
  ];

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto text-slate-100">
      
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight">AI Agent & Qualification Rules</h2>
          <p className="text-xs text-slate-400">
            Configure system prompts, voice persona, deterministic scoring rubric, and business hours (PRD Section 44)
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
                <p className="text-[11px] text-slate-400">
                  {status.accountCount > 1
                    ? `This agent runs on the active one of your ${status.accountCount} Telnyx accounts.`
                    : 'This agent calls and texts from your own Telnyx account.'}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setActiveView('integrations')}
              className="text-[11px] font-semibold text-slate-400 hover:text-slate-200 border border-slate-800 hover:border-slate-600 rounded-lg px-2.5 py-1 flex items-center gap-1.5 transition-colors cursor-pointer shrink-0"
            >
              Manage connection
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-[11px]">
            <div className="bg-slate-950 border border-slate-800/80 rounded-xl px-3 py-2 min-w-0">
              <div className="text-slate-500">API key</div>
              <div className="text-slate-200 font-mono truncate">{status.apiKeyMasked || '—'}</div>
            </div>
            <div className="bg-slate-950 border border-slate-800/80 rounded-xl px-3 py-2 min-w-0">
              <div className="text-slate-500">From number</div>
              <div className="text-slate-200 font-mono truncate">{status.fromNumber || 'none assigned'}</div>
            </div>
            <div className="bg-slate-950 border border-slate-800/80 rounded-xl px-3 py-2 min-w-0">
              <div className="text-slate-500">Assistant ID</div>
              <div className="text-slate-200 font-mono truncate" title={status.assistantId}>
                {status.assistantId || '—'}
              </div>
            </div>
            <div className="bg-slate-950 border border-slate-800/80 rounded-xl px-3 py-2 min-w-0">
              <div className="text-slate-500">Connected</div>
              <div className="text-slate-200 truncate">
                {status.connectedAt ? new Date(status.connectedAt).toLocaleDateString() : '—'}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex flex-wrap items-center gap-3 text-[11px]">
              <span className="flex items-center gap-1 text-emerald-400">
                <CheckCircle2 className="w-3.5 h-3.5" /> Voice calling ready
              </span>
              {status.hasMessaging ? (
                <span className="flex items-center gap-1 text-emerald-400">
                  <CheckCircle2 className="w-3.5 h-3.5" /> SMS messaging ready
                </span>
              ) : (
                <span className="flex items-center gap-1 text-amber-400">
                  <AlertTriangle className="w-3.5 h-3.5" /> SMS unavailable — assign your number to a
                  Telnyx Messaging Profile
                </span>
              )}
            </div>

            {assistants.length > 0 && (
              <div className="flex items-center gap-2 text-[11px] ml-auto">
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
            <div className="flex items-center gap-2 text-[11px]">
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
              <span className="text-[11px] text-slate-500 mt-1 block">Used in voice call greetings & SMS sender IDs</span>
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
              <span className="text-[11px] text-slate-500 mt-1 block">First line the agent speaks on a call</span>
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
              <span className="text-[11px] text-slate-500 mt-1 block">The LLM powering the conversation</span>
            </div>
          </div>

          <div>
            <label className="block text-slate-300 font-semibold mb-1 flex items-center gap-1.5">
              <Wand2 className="w-3.5 h-3.5 text-emerald-400" />
              AI System Prompt
              <span className="text-[11px] text-slate-500 font-normal">— deployed live to your AI voice agent on save</span>
            </label>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={9}
              spellCheck={false}
              placeholder="Describe how the AI agent should behave and what it must collect…"
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-white text-xs leading-relaxed font-mono focus:outline-none focus:border-emerald-500 resize-y"
            />
            <span className="text-[11px] text-slate-500 mt-1 block">
              The selected <span className="text-slate-300">Conversational Tone</span> is appended to this prompt automatically when deployed.
            </span>
          </div>

        </div>

        {/* Outbound Communication Strategy — its own block */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <Sliders className="w-4 h-4 text-emerald-400" />
            Outbound Communication Strategy
            <span className="text-[11px] text-slate-500 font-normal">— the voice &amp; SMS sequence run for every new lead</span>
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
                    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
                  </span>
                  <span className="font-semibold">{label}</span>
                </button>
              ))}
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
                    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
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
              <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${postCall ? 'left-[18px]' : 'left-0.5'}`} />
            </span>
            <span className="font-semibold">{postCall ? 'Enabled' : 'Disabled'}</span>
          </button>
        </div>

        {/* Tools / Workflows (view-only — shared tools managed in provider console) */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <Sliders className="w-4 h-4 text-amber-400" />
            Tools / Workflows <span className="text-[11px] text-slate-500 font-normal">— what the agent can do during a call</span>
          </h3>

          <div className="space-y-2 text-xs">
            {tools.length === 0 && <p className="text-slate-500">No tools attached.</p>}
            {tools.map((t, i) => (
              <div key={i} className="p-3 bg-slate-950/60 rounded-xl border border-slate-800 flex items-center justify-between gap-3">
                <div>
                  <span className="font-semibold text-slate-200">{toolLabel(t)}</span>
                  {t.type === 'transfer' && (
                    <span className="text-slate-500 block mt-0.5">
                      Targets: {(t.transfer?.targets || []).map((x: any) => x.name || x.to).join(', ')}
                    </span>
                  )}
                  {t.type === 'webhook' && <span className="text-slate-500 block mt-0.5 font-mono break-all">{t.webhook?.url}</span>}
                </div>
                <span className="text-[9px] uppercase font-mono tracking-wide text-slate-600 shrink-0">{t.type}</span>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-slate-500">
            These tools are managed in your AI agent console.
            The high-value one to add there: a <span className="text-slate-300 font-mono">report_qualification</span> webhook to
            <span className="text-slate-300 font-mono"> /api/leads/&#123;&#123;lead_id&#125;&#125;/qualified</span> so the agent reports hot/warm/cold and auto-hands off the lead.
          </p>
        </div>

        {/* Dynamic Variables */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Building2 className="w-4 h-4 text-cyan-400" />
              Dynamic Variables <span className="text-[11px] text-slate-500 font-normal">— injected into the prompt as {'{{key}}'}</span>
            </h3>
            <button type="button" onClick={addVar} className="text-[11px] text-emerald-400 font-semibold hover:text-emerald-300">+ Add variable</button>
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

        {/* Qualification Rubric (PRD Section 22) */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-cyan-400" />
            Active Qualification Rubric (Extracted by AI)
          </h3>
          <p className="text-xs text-slate-400">
            The voice agent conversationally gathers these fields without reading off a rigid checklist:
          </p>

          <div className="space-y-2 text-xs">
            {qualificationChecklist.map((item, idx) => (
              <div key={idx} className="flex items-center justify-between p-2.5 bg-slate-950/60 rounded-xl border border-slate-800/80">
                <span className="text-slate-200 flex items-center gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                  <span>{item.label}</span>
                </span>
                <span className={`text-[10px] uppercase font-bold font-mono px-2 py-0.5 rounded ${
                  item.required ? 'bg-rose-950 text-rose-300' : 'bg-slate-800 text-slate-400'
                }`}>
                  {item.required ? 'Required for Score' : 'Recommended'}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Business Hours & Compliance Guardrails (PRD Section 23 & 54) */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <Clock className="w-4 h-4 text-amber-400" />
            Contact Window & Safety Guardrails
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div>
              <label className="block text-slate-300 font-semibold mb-1">Permitted Contact Hours (CST)</label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={startHour}
                  onChange={(e) => setStartHour(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white w-28 text-center"
                />
                <span className="text-slate-400">to</span>
                <input
                  type="text"
                  value={endHour}
                  onChange={(e) => setEndHour(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white w-28 text-center"
                />
              </div>
              <span className="text-[10px] text-slate-500 mt-1 block">Voice calls outside these hours queue until next window</span>
            </div>

            <div>
              <label className="block text-slate-300 font-semibold mb-1">DNC & Opt-Out Handling</label>
              <div className="p-2.5 bg-slate-950 rounded-lg border border-slate-800 text-[11px] text-slate-300 space-y-1">
                <div className="text-emerald-400 font-semibold">Strict TCPA STOP Enforcement: Active</div>
                <p className="text-slate-400">Any text containing "STOP", "UNSUBSCRIBE", or verbal DNC request immediately cancels all follow-ups.</p>
              </div>
            </div>
          </div>

          <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800 text-[11px] text-slate-400 space-y-1">
            <span className="font-semibold text-slate-200">Strict Non-Goals Enforced in System Prompt (PRD Section 4 & 23):</span>
            <p>AI agent never gives legal advice, never guarantees mortgage approval, never makes unverified pricing promises, and escalates to a human agent whenever uncertain.</p>
          </div>
        </div>

        {/* Submit */}
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={deploying}
            className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white rounded-xl text-xs font-bold shadow-lg shadow-emerald-950 flex items-center gap-2 transition-colors cursor-pointer"
          >
            {deploying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            <span>{deploying ? 'Deploying to AI agent…' : 'Save Configuration'}</span>
          </button>
        </div>

      </form>
      )}

    </div>
  );
};
