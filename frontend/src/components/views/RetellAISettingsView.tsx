import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Loader2, PhoneCall, Plug, Save, ShieldCheck, Sliders, Sparkles } from 'lucide-react';
import { toast } from 'react-toastify';
import { SMS_UNAVAILABLE_ON_RETELL } from '../../utils/callingProviderApi';
import {
  getRetellAgent,
  retellMessage,
  getRetellCallCapacity,
  listRetellVoices,
  saveRetellCallCapacity,
  updateRetellAgent,
  type RetellAgent,
  type RetellCallCapacity,
  type RetellVoice,
} from '../../utils/retellApi';
import { CallPacingCard } from './CallPacingCard';
import { ContactWindowCard } from './ContactWindowCard';
import { InCallBookingCard } from './InCallBookingCard';
import { LeadTemperatureCard } from './LeadTemperatureCard';
import { StrategyEditor } from './StrategyEditor';

/**
 * AI Agent settings for an organization that calls through Retell. The agent
 * lives in the organization's Retell workspace; this edits its prompt,
 * greeting and voice. The strategy, contact window, pacing, scoring and
 * in-call booking are the same as on Telnyx; SMS steps are not sent.
 */

const card = 'bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl';
const input =
  'w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-600';
const label = 'block text-xs font-semibold text-slate-300 mb-1';
const MAX_CALLS = 500;

/** A link such as /ai-settings#contact-window lands on that card and points it out, once per navigation. */
function useHashLanding(ready: unknown) {
  const { hash, key } = useLocation();
  const landed = useRef<string | null>(null);
  useEffect(() => {
    if (!hash || landed.current === key) return;
    const el = document.getElementById(hash.slice(1));
    if (!el) return;
    const mark = ['ring-2', 'ring-emerald-500/70'];
    let unmark: ReturnType<typeof setTimeout> | undefined;
    const land = setTimeout(() => {
      landed.current = key;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el.classList.add(...mark);
      unmark = setTimeout(() => el.classList.remove(...mark), 2000);
    }, 400);
    return () => {
      clearTimeout(land);
      if (unmark) clearTimeout(unmark);
    };
  }, [hash, key, ready]);
}

const Toggle: React.FC<{ checked: boolean; onChange: (v: boolean) => void; title: string; hint: string }> = ({ checked, onChange, title, hint }) => (
  <label className="flex items-start gap-2.5 cursor-pointer">
    <input type="checkbox" className="mt-0.5 accent-emerald-500" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    <span>
      <span className="block text-xs font-semibold text-slate-200">{title}</span>
      <span className="block text-2xs text-slate-500 leading-relaxed">{hint}</span>
    </span>
  </label>
);

const AgentCard: React.FC<{ agent: RetellAgent; voices: RetellVoice[]; onSaved: (a: RetellAgent) => void }> = ({ agent, voices, onSaved }) => {
  const [prompt, setPrompt] = useState(agent.prompt);
  const [greeting, setGreeting] = useState(agent.greeting);
  const [voiceId, setVoiceId] = useState(agent.voiceId);
  const [language, setLanguage] = useState(agent.language);
  const [maxMins, setMaxMins] = useState(Math.round(agent.maxCallSeconds / 60));
  const [voicemailHangup, setVoicemailHangup] = useState(agent.voicemailHangup);
  const [recordCalls, setRecordCalls] = useState(agent.recordCalls);
  const [saving, setSaving] = useState(false);

  const validMins = Number.isInteger(maxMins) && maxMins >= 1 && maxMins <= 120;

  const save = async () => {
    setSaving(true);
    try {
      const saved = await updateRetellAgent({
        prompt,
        greeting,
        voiceId,
        language: language.trim() || 'en-US',
        maxCallSeconds: maxMins * 60,
        voicemailHangup,
        recordCalls,
      });
      onSaved(saved);
      toast.success('Retell agent saved.');
    } catch (e) {
      toast.error(retellMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className={card}>
      <h3 className="text-sm font-bold text-white flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-amber-400" /> AI Voice Persona
      </h3>
      <div>
        <label className={label}>Prompt</label>
        <textarea className={`${input} h-56 resize-y font-mono`} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        <p className="text-2xs text-slate-500 mt-1">
          {'Lead details are available as {{firstName}}, {{fullName}}, {{location}}, {{budget}}, {{timeline}} and {{brokerage}}.'}
        </p>
      </div>
      <div>
        <label className={label}>Greeting</label>
        <textarea className={`${input} h-16 resize-y`} value={greeting} onChange={(e) => setGreeting(e.target.value)} />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label className={label}>Voice</label>
          <select className={input} value={voiceId} onChange={(e) => setVoiceId(e.target.value)}>
            {!voices.some((v) => v.id === voiceId) && <option value={voiceId}>{voiceId}</option>}
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
                {v.gender || v.accent ? ` (${[v.gender, v.accent].filter(Boolean).join(', ')})` : ''}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={label}>Language</label>
          <input className={input} value={language} placeholder="en-US" onChange={(e) => setLanguage(e.target.value)} />
        </div>
        <div>
          <label className={label}>Max call length (minutes)</label>
          <input type="number" min={1} max={120} className={input} value={maxMins} onChange={(e) => setMaxMins(Number(e.target.value))} />
        </div>
      </div>
      <div className="space-y-2">
        <Toggle checked={voicemailHangup} onChange={setVoicemailHangup} title="Hang up on voicemail" hint="Retell detects voicemail in the first minutes of a call and ends it." />
        <Toggle
          checked={recordCalls}
          onChange={setRecordCalls}
          title="Record calls"
          hint="Off: EstatePulse keeps no recording or transcript, and Retell keeps only basic call details. The call is still scored."
        />
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !validMins || !prompt.trim()}
          className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-on-accent rounded-xl text-xs font-bold flex items-center gap-2 cursor-pointer"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {saving ? 'Saving to Retell…' : 'Save agent'}
        </button>
      </div>
    </section>
  );
};

/** Our own call limit, never above the Retell workspace's, which only Retell can raise. */
const RetellCallCapacityCard: React.FC = () => {
  const [status, setStatus] = useState<RetellCallCapacity | null>(null);
  const [limit, setLimit] = useState(5);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getRetellCallCapacity()
      .then((s) => {
        setStatus(s);
        setLimit(s.appLimit);
      })
      .catch((e) => setError(retellMessage(e)));
  }, []);

  const ceiling = Math.min(MAX_CALLS, status?.retellLimit ?? MAX_CALLS);
  const valid = Number.isInteger(limit) && limit >= 1 && limit <= ceiling;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const s = await saveRetellCallCapacity(limit);
      setStatus(s);
      setLimit(s.appLimit);
      toast.success('Call limit saved.');
    } catch (e) {
      setError(retellMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className={card}>
      <div>
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <PhoneCall className="w-4 h-4 text-emerald-400" /> Call Capacity
        </h3>
        <p className="text-xs text-slate-400 mt-1">
          How many AI calls may run at the same time. Extra calls wait in a queue and dial as soon as a line frees up.
        </p>
      </div>
      {error && <div className="text-xs text-rose-300 bg-rose-950/40 border border-rose-800/40 rounded-lg px-3 py-2">{error}</div>}
      {!status && !error ? (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading call capacity…
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-6 text-xs">
          <div>
            <label className={label}>Max concurrent AI calls</label>
            <input type="number" min={1} max={ceiling} value={limit} onChange={(e) => setLimit(Number(e.target.value))} className={`${input} w-24`} />
          </div>
          {status && (
            <div className="space-y-1 pb-1">
              <p className="text-slate-300">
                In use now: <span className="font-semibold text-white">{status.inUse}</span> / {status.appLimit}
              </p>
              {status.retellLimit != null ? (
                <p className="text-slate-500">Your Retell workspace allows {status.retellLimit}. Buy more concurrency in the Retell dashboard.</p>
              ) : (
                <p className="flex items-center gap-1 text-amber-300">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> Could not read Retell{status.retellError ? `: ${status.retellError}` : ''}
                </p>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || !valid || !status}
            className="ml-auto px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-on-accent text-xs font-semibold cursor-pointer"
          >
            {saving ? 'Saving…' : 'Save limit'}
          </button>
        </div>
      )}
    </section>
  );
};

export const RetellAISettingsView: React.FC = () => {
  const navigate = useNavigate();
  const [agent, setAgent] = useState<RetellAgent | null | undefined>(undefined);
  const [voices, setVoices] = useState<RetellVoice[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    getRetellAgent()
      .then(setAgent)
      .catch((e) => {
        setAgent(null);
        setLoadError(retellMessage(e));
      });
    listRetellVoices()
      .then(setVoices)
      .catch(() => setVoices([]));
  }, []);
  useHashLanding(agent);

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto text-slate-100">
      <div>
        <h2 className="text-xl font-bold text-white tracking-tight">AI Assistant</h2>
        <p className="text-xs text-slate-400">The prompt, voice and outreach strategy your Retell AI agent uses on every lead.</p>
      </div>

      {agent === undefined ? (
        <div className={`${card} text-xs text-slate-400 flex items-center gap-2`}>
          <Loader2 className="w-4 h-4 animate-spin" /> Loading your Retell agent…
        </div>
      ) : agent === null ? (
        <div className="bg-slate-900/90 border border-amber-500/40 rounded-2xl p-5 shadow-xl flex flex-col md:flex-row md:items-center gap-4">
          <div className="w-10 h-10 rounded-xl bg-amber-500/20 text-amber-300 flex items-center justify-center border border-amber-500/30 shrink-0">
            <Plug className="w-5 h-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-bold text-white">{loadError ? 'Could not load your Retell agent' : 'No Retell agent yet'}</h3>
            <p className="text-xs text-slate-400 mt-1 leading-relaxed">{loadError ?? 'Create the agent and choose its number in Settings → Calling → Retell, then edit it here.'}</p>
          </div>
          <button
            type="button"
            onClick={() => navigate('/settings?tab=retell')}
            className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-on-accent text-xs font-bold flex items-center gap-1.5 cursor-pointer shrink-0"
          >
            Open Settings → Calling <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      ) : (
        <AgentCard key={agent.agentId} agent={agent} voices={voices} onSaved={setAgent} />
      )}

      <section className={card}>
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <Sliders className="w-4 h-4 text-emerald-400" />
          Outbound Communication Strategy
          <span className="text-xs text-slate-500 font-normal">— the call sequence run for every new lead</span>
        </h3>
        <StrategyEditor smsDisabledReason={SMS_UNAVAILABLE_ON_RETELL} />
      </section>

      {/* The ids are link targets (OutreachPicker's "Change" links): /ai-settings#<id>. */}
      <div id="contact-window" className="scroll-mt-6 rounded-2xl transition-shadow">
        <ContactWindowCard blurb="When the AI agent may call a lead, and how hard it may try. The same window governs every follow-up sequence." />
      </div>

      <div id="call-capacity" className="scroll-mt-6 rounded-2xl transition-shadow">
        <RetellCallCapacityCard />
      </div>

      <div id="call-pacing" className="scroll-mt-6 rounded-2xl transition-shadow">
        <CallPacingCard />
      </div>

      <LeadTemperatureCard />

      <InCallBookingCard />

      <section className={card}>
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-emerald-400" /> Compliance
        </h3>
        <div className="p-2.5 bg-slate-950 rounded-lg border border-slate-800 text-xs text-slate-300 space-y-1">
          <div className="text-emerald-400 font-semibold">Do-not-call on request: active</div>
          <p className="text-slate-400">
            A lead who asks on the call not to be contacted again is set to do-not-contact, and every scheduled call in the
            strategy and in every sequence is cancelled.
          </p>
        </div>
        <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800 text-xs text-slate-400">
          {SMS_UNAVAILABLE_ON_RETELL} Texts and SMS STOP replies are handled only when your organization calls through Telnyx.
        </div>
      </section>
    </div>
  );
};
