import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Building2, CheckCircle2, Loader2, Lock, MessageSquare, Pencil, Phone, PhoneCall, Plug, Save, ShieldCheck, Sliders, SlidersHorizontal, Sparkles, Trash2 } from 'lucide-react';
import { toast } from 'react-toastify';
import { confirmToast } from '../../lib/toast';
import { toolLabel, type AssistantTool } from '../../utils/assistantApi';
import { ToolEditorModal } from '../modals/ToolEditorModal';
import { formatDate } from '../../lib/datetime';
import { smsDisabledReasonOf, useCallingProvider, type CallingProviderState } from '../../utils/callingProviderApi';
import {
  getRetellAgent,
  getRetellSmsAgent,
  getRetellStatus,
  retellMessage,
  getRetellCallCapacity,
  listRetellVoices,
  saveRetellCallCapacity,
  setRetellAgentTools,
  updateRetellAgent,
  updateRetellSmsAgent,
  type RetellAgent,
  type RetellTool,
  type RetellCallCapacity,
  type RetellSmsAgent,
  type RetellStatus,
  type RetellVoice,
} from '../../utils/retellApi';
import { RetellAgentSelect, RetellNumbers, RetellSmsSection } from '../integrations/RetellConnect';
import { CallPacingCard } from './CallPacingCard';
import { CallToolsCard } from './CallToolsCard';
import { ContactWindowCard } from './ContactWindowCard';
import { InCallBookingCard } from './InCallBookingCard';
import { LeadTemperatureCard } from './LeadTemperatureCard';
import { StrategyEditor } from './StrategyEditor';

/**
 * AI Agent settings for an organization that calls through Retell. The agent
 * lives in the organization's Retell workspace; this edits its prompt,
 * greeting and voice, and the SMS agent's prompt once SMS is set up in
 * Settings → Calling. The strategy, contact window, pacing, scoring, callbacks
 * and in-call booking are the same as on Telnyx; SMS steps go through the SMS
 * agent, or are shown as not sent with the reason until it is set up.
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

/**
 * A Retell LLM tool as the shared tool editor knows it, and back. Retell's
 * end_call is the editor's hang-up, transfer_call its transfer (one number;
 * several become an inferred destination the model picks from), custom its
 * webhook. Anything else is shown by name and edited in the Retell dashboard.
 */
function toEditorTool(t: RetellTool): AssistantTool {
  if (t.type === 'end_call') return { type: 'hangup', hangup: { description: t.description } };
  if (t.type === 'transfer_call') {
    const d = t.transfer_destination;
    const to = d?.type === 'predefined' ? d.number : '';
    return { type: 'transfer', transfer: { targets: [{ name: t.name, to }] } };
  }
  if (t.type === 'custom') {
    const headers = Object.entries(t.headers ?? {}).map(([name, value]) => ({ name, value }));
    const useQuery = (t.method ?? 'POST') === 'GET';
    return {
      type: 'webhook',
      webhook: {
        name: t.name,
        description: t.description ?? '',
        url: t.url ?? '',
        method: (t.method as 'GET' | 'POST' | 'PUT' | 'DELETE' | undefined) ?? 'POST',
        headers,
        ...(useQuery ? { query_parameters: t.parameters } : { body_parameters: t.parameters }),
        ...(t.timeout_ms ? { timeout_ms: t.timeout_ms } : {}),
      },
    };
  }
  return { type: t.type, name: t.name };
}

function fromEditorTool(t: AssistantTool, previous?: RetellTool): Omit<RetellTool, 'managed'> {
  if (t.type === 'hangup') return { type: 'end_call', name: previous?.name ?? 'end_call', description: t.hangup?.description || 'End the call once the conversation is complete or the caller asks to.' };
  if (t.type === 'transfer') {
    const targets = (t.transfer?.targets ?? []).filter((x) => x.to.trim());
    const destination =
      targets.length === 1
        ? { type: 'predefined' as const, number: targets[0].to.trim() }
        : { type: 'inferred' as const, prompt: `Transfer to the right person: ${targets.map((x) => `${x.name || 'agent'} at ${x.to.trim()}`).join('; ')}` };
    return { type: 'transfer_call', name: previous?.name ?? 'transfer_call', description: 'Transfer the call to a person on the team when the caller asks for one.', transfer_destination: destination, transfer_option: { type: 'cold_transfer' } };
  }
  const w = t.webhook!;
  return {
    type: 'custom',
    name: w.name,
    description: w.description,
    url: w.url,
    method: w.method ?? 'POST',
    headers: Object.fromEntries((w.headers ?? []).filter((h) => h.name.trim()).map((h) => [h.name.trim(), h.value])),
    ...(w.body_parameters || w.query_parameters ? { parameters: w.body_parameters ?? w.query_parameters } : {}),
    ...(w.timeout_ms ? { timeout_ms: w.timeout_ms } : {}),
  };
}

const retellToolLabel = (t: RetellTool): string => (t.type === 'custom' ? `Webhook: ${t.name}` : t.type === 'end_call' ? 'Hang up' : t.type === 'transfer_call' ? `Transfer${t.transfer_destination?.type === 'predefined' ? ` → ${t.transfer_destination.number}` : ''}` : `${t.name} (${t.type})`);
const EDITABLE_TOOL_TYPES = new Set(['end_call', 'transfer_call', 'custom']);

/** Tools on the agent's Retell LLM: what it can do during a call. Saved as soon as one is added, edited or removed. */
const RetellToolsCard: React.FC<{ agent: RetellAgent; onSaved: (a: RetellAgent) => void }> = ({ agent, onSaved }) => {
  const [editing, setEditing] = useState<RetellTool | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const own = agent.tools.filter((t) => !t.managed);

  /** Saves the agent's own tools on Retell; false, with the reason toasted, when Retell refused. */
  const persist = async (next: Omit<RetellTool, 'managed'>[], done: string): Promise<boolean> => {
    setBusy(true);
    try {
      onSaved(await setRetellAgentTools(next));
      toast.success(done);
      return true;
    } catch (e) {
      toast.error(retellMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = (edited: AssistantTool) => {
    const built = fromEditorTool(edited, editing ?? undefined);
    const next = editing ? own.map((t) => (t === editing ? built : t)) : [...own, built];
    return persist(next, 'Tool saved on Retell.');
  };

  const remove = async (t: RetellTool) => {
    if (await confirmToast(`Remove "${retellToolLabel(t)}" from this agent?`, 'Remove')) await persist(own.filter((x) => x !== t), 'Tool removed.');
  };

  return (
    <section className={card}>
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <SlidersHorizontal className="w-4 h-4 text-amber-400" />
          Tools / Workflows <span className="text-xs text-slate-500 font-normal">— what the agent can do during a call</span>
        </h3>
        <button type="button" onClick={() => setEditing(null)} disabled={busy} className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-on-accent rounded-lg text-xs font-bold flex items-center gap-1.5 cursor-pointer">
          + Add tool
        </button>
      </div>
      <div className="space-y-2 text-xs">
        {agent.tools.length === 0 && <p className="text-slate-500">No tools yet. Without one the agent can only talk — it cannot transfer a call, hang up or tell another system what it learned.</p>}
        {agent.tools.map((t, i) => (
          <div key={`${t.name}-${i}`} className="p-3 bg-slate-950/60 rounded-xl border border-slate-800 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <span className="font-semibold text-slate-200 flex items-center gap-1.5">
                {retellToolLabel(t)}
                {t.managed && (
                  <span className="text-2xs uppercase font-mono tracking-wide text-sky-400 bg-sky-950/50 border border-sky-800/50 rounded px-1 py-0.5 flex items-center gap-1" title="Added by EstatePulse (booking, callbacks, outcomes); switched on and off from its own card.">
                    <Lock className="w-2.5 h-2.5" /> EstatePulse
                  </span>
                )}
              </span>
              {t.type === 'custom' && !t.managed && <span className="text-slate-500 block mt-0.5 font-mono break-all">{t.method ?? 'POST'} {t.url}</span>}
            </div>
            {!t.managed && (
              <div className="flex items-center gap-1 shrink-0">
                {EDITABLE_TOOL_TYPES.has(t.type) && (
                  <button type="button" onClick={() => setEditing(t)} disabled={busy} className="p-1.5 text-slate-400 hover:text-emerald-300 disabled:opacity-50 cursor-pointer" aria-label={`Edit ${retellToolLabel(t)}`}>
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                )}
                <button type="button" onClick={() => void remove(t)} disabled={busy} className="p-1.5 text-slate-400 hover:text-rose-400 disabled:opacity-50 cursor-pointer" aria-label={`Remove ${retellToolLabel(t)}`}>
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      <p className="text-xs text-slate-500">Tools save on Retell as soon as you add or edit one — they are not part of Save Configuration. Booking, callbacks and outcomes are added by their own cards.</p>
      {editing !== undefined && (
        <ToolEditorModal tool={editing ? toEditorTool(editing) : null} types={['webhook', 'transfer', 'hangup']} onClose={() => setEditing(undefined)} onSave={save} />
      )}
    </section>
  );
};

const AgentCard: React.FC<{ agent: RetellAgent; voices: RetellVoice[]; onSaved: (a: RetellAgent) => void }> = ({ agent, voices, onSaved }) => {
  const [name, setName] = useState(agent.name);
  const [postCall, setPostCall] = useState(agent.postCallProcessing);
  const [vars, setVars] = useState<{ key: string; value: string }[]>(Object.entries(agent.dynamicVariables).map(([key, value]) => ({ key, value })));
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
      const dynamicVariables = Object.fromEntries(vars.filter((v) => v.key.trim()).map((v) => [v.key.trim(), v.value]));
      const saved = await updateRetellAgent({
        ...(name.trim() ? { name: name.trim() } : {}),
        prompt,
        greeting,
        postCallProcessing: postCall,
        dynamicVariables,
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
        <label className={label}>Agent name</label>
        <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Austin Home Advisors" maxLength={100} />
        <p className="text-2xs text-slate-500 mt-1">As shown in your Retell dashboard.</p>
      </div>
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
        <Toggle
          checked={postCall}
          onChange={setPostCall}
          title="Post-call processing"
          hint="Retell analyses each finished call — a summary and the lead details (budget, timeline, financing…) that score the lead. Off, calls are not scored."
        />
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
            <Building2 className="w-3.5 h-3.5 text-cyan-400" /> Dynamic variables <span className="text-slate-500 font-normal">— injected into the prompt as {'{{key}}'}</span>
          </span>
          <button type="button" onClick={() => setVars((v) => [...v, { key: '', value: '' }])} className="text-xs text-emerald-400 font-semibold hover:text-emerald-300 cursor-pointer">
            + Add variable
          </button>
        </div>
        {vars.length === 0 && <p className="text-xs text-slate-500">No variables. Add company name, phone, hours… The lead’s own details ({'{{firstName}}'}, {'{{budget}}'}…) are filled on every call anyway.</p>}
        {vars.map((v, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <input value={v.key} onChange={(e) => setVars((all) => all.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} placeholder="company_name" className={`${input} w-48 font-mono`} />
            <input value={v.value} onChange={(e) => setVars((all) => all.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} placeholder="Austin Home Advisors" className={input} />
            <button type="button" onClick={() => setVars((all) => all.filter((_, j) => j !== i))} className="text-rose-400 hover:text-rose-300 px-2 cursor-pointer">
              ✕
            </button>
          </div>
        ))}
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !validMins || !prompt.trim()}
          className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-on-accent rounded-xl text-xs font-bold flex items-center gap-2 cursor-pointer"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {saving ? 'Saving to Retell…' : 'Save Configuration'}
        </button>
      </div>
    </section>
  );
};

/**
 * The Telnyx-style header: can this agent call and text right now, where the
 * connection is managed, and which of the workspace's agents is being edited.
 */
const RetellConnectedCard: React.FC<{ status: RetellStatus; calling: CallingProviderState | null; onChange: () => void; onManage: () => void }> = ({ status, calling, onChange, onManage }) => {
  const voiceReady = !!status.agentId && !!status.fromNumber;
  const sms = calling?.sms ?? null;
  const smsReady = !!sms?.available;
  return (
    <div className="bg-slate-900/90 border border-emerald-500/40 rounded-2xl p-5 shadow-xl space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-sky-600/20 text-sky-300 flex items-center justify-center border border-sky-500/30 shrink-0">
            <PhoneCall className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              Retell connected <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            </h3>
            <p className="text-xs text-slate-400">{smsReady ? 'This agent calls and texts from your own Retell workspace.' : 'This agent calls from your own Retell workspace; SMS is set up in the SMS card below.'}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onManage}
          className="text-xs font-semibold text-slate-400 hover:text-slate-200 border border-slate-800 hover:border-slate-600 rounded-lg px-2.5 py-1 flex items-center gap-1.5 transition-colors cursor-pointer shrink-0"
        >
          Manage connection <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className={`flex items-center gap-2.5 bg-slate-950 rounded-xl px-3.5 py-2.5 border ${voiceReady ? 'border-emerald-800/40' : 'border-amber-800/50'}`}>
          {voiceReady ? <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" /> : <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />}
          <div className="min-w-0">
            <div className="text-xs font-semibold text-slate-100">Voice calls</div>
            <div className={`text-xs ${voiceReady ? 'text-emerald-400' : 'text-amber-400'}`}>{voiceReady ? 'Ready' : status.agentId ? 'Choose the number calls come from' : 'Create or pick an agent'}</div>
          </div>
        </div>
        <div className={`flex items-center gap-2.5 bg-slate-950 rounded-xl px-3.5 py-2.5 border ${smsReady ? 'border-emerald-800/40' : 'border-amber-800/50'}`}>
          {smsReady ? <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" /> : <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />}
          <div className="min-w-0">
            <div className="text-xs font-semibold text-slate-100">SMS messaging</div>
            <div className={`text-xs ${smsReady ? 'text-emerald-400' : 'text-amber-400'}`} title={sms?.reason ?? undefined}>
              {!calling ? 'Checking…' : smsReady ? (sms?.state === 'unverified' ? 'Ready (registration not verifiable through Retell)' : 'Ready') : (sms?.reason ?? 'Not set up')}
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap pt-1 border-t border-slate-800">
        <p className="text-xs text-slate-500 min-w-0">{status.connectedAt ? `Connected ${formatDate(status.connectedAt, { day: 'numeric', month: 'short', year: 'numeric' })}` : 'Connected'}</p>
        <div className="flex items-center gap-2 text-xs ml-auto shrink-0">
          <span className="text-slate-400">Editing agent:</span>
          <RetellAgentSelect status={status} onChange={onChange} autoSwitch />
        </div>
      </div>
    </div>
  );
};

/** Numbers on the workspace: pick, buy or bring in the one calls come from, without leaving AI settings. */
const RetellPhoneNumberCard: React.FC<{ status: RetellStatus; onChange: () => void }> = ({ status, onChange }) => (
  <section className={card}>
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-sm font-bold text-white flex items-center gap-2">
        <Phone className="w-4 h-4 text-emerald-400" /> Phone Number
      </h3>
      <span className="text-xs text-slate-400 flex items-center gap-1">
        {status.fromNumber ? (
          <span className="text-emerald-400 flex items-center gap-1">
            <CheckCircle2 className="w-3.5 h-3.5" /> Active: {status.fromNumber}
          </span>
        ) : (
          'No number assigned yet'
        )}
      </span>
    </div>
    <RetellNumbers status={status} onChange={onChange} />
  </section>
);

/** The SMS agent's prompt: how the AI texts. Its opening message is always the strategy or sequence text, as written. */
const SmsAgentCard: React.FC<{ agent: RetellSmsAgent; onSaved: (a: RetellSmsAgent) => void }> = ({ agent, onSaved }) => {
  const [prompt, setPrompt] = useState(agent.prompt);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      onSaved(await updateRetellSmsAgent(prompt));
      toast.success('SMS agent saved.');
    } catch (e) {
      toast.error(retellMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className={card}>
      <div>
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-cyan-400" /> SMS Agent
        </h3>
        <p className="text-xs text-slate-400 mt-1 leading-relaxed">
          How the AI texts with a lead. The first text of every conversation is the strategy or sequence message exactly as
          you wrote it; this prompt guides the replies that follow. The same lead details as on calls are available.
        </p>
      </div>
      <div>
        <label className={label}>Prompt</label>
        <textarea className={`${input} h-48 resize-y font-mono`} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !prompt.trim()}
          className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-on-accent rounded-xl text-xs font-bold flex items-center gap-2 cursor-pointer"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {saving ? 'Saving to Retell…' : 'Save SMS agent'}
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
  const [smsAgent, setSmsAgent] = useState<RetellSmsAgent | null>(null);
  const [status, setStatus] = useState<RetellStatus | null>(null);
  const [voices, setVoices] = useState<RetellVoice[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const calling = useCallingProvider();
  const smsDisabledReason = smsDisabledReasonOf(calling);

  // The agent lives on Retell: every read here is the live one, and a change of agent or number re-reads it.
  const load = useCallback(() => {
    getRetellStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
    getRetellAgent()
      .then((a) => {
        setAgent(a);
        setLoadError(null);
      })
      .catch((e) => {
        setAgent(null);
        setLoadError(retellMessage(e));
      });
    getRetellSmsAgent()
      .then(setSmsAgent)
      .catch(() => setSmsAgent(null));
  }, []);
  useEffect(() => {
    load();
    listRetellVoices()
      .then(setVoices)
      .catch(() => setVoices([]));
  }, [load]);
  useHashLanding(agent);

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto text-slate-100">
      <div>
        <h2 className="text-xl font-bold text-white tracking-tight">AI Assistant</h2>
        <p className="text-xs text-slate-400">The prompt, voice and outreach strategy your Retell AI agent uses on every lead.</p>
      </div>

      {status?.connected && <RetellConnectedCard status={status} calling={calling} onChange={load} onManage={() => navigate('/settings?tab=retell')} />}
      {status?.connected && <RetellPhoneNumberCard status={status} onChange={load} />}

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
            <p className="text-xs text-slate-400 mt-1 leading-relaxed">{loadError ?? 'Create the agent and choose its number under Settings → Calling → Retell → Manage connection, then edit it here.'}</p>
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
        <>
          <AgentCard key={agent.agentId} agent={agent} voices={voices} onSaved={setAgent} />
          <RetellToolsCard agent={agent} onSaved={setAgent} />
        </>
      )}

      {status?.connected && (
        <section className={card}>
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-cyan-400" /> SMS
            </h3>
            <p className="text-xs text-slate-400 mt-1">Texts go through a Retell SMS agent on the number calls come from. Set it up once; the SMS agent’s prompt is edited below.</p>
          </div>
          <RetellSmsSection status={status} onChange={load} />
        </section>
      )}

      {smsAgent && <SmsAgentCard key={smsAgent.agentId} agent={smsAgent} onSaved={setSmsAgent} />}

      <section className={card}>
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <Sliders className="w-4 h-4 text-emerald-400" />
          Outbound Communication Strategy
          <span className="text-xs text-slate-500 font-normal">— the call sequence run for every new lead</span>
        </h3>
        {smsDisabledReason && (
          <p className="text-2xs text-slate-500 leading-relaxed">Set SMS up in the SMS card above to send the SMS steps through Retell.</p>
        )}
        <StrategyEditor smsDisabledReason={smsDisabledReason} />
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

      <CallToolsCard />

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
          {smsDisabledReason
            ? `SMS steps are not sent: ${smsDisabledReason}`
            : 'A lead who texts STOP is set to do-not-contact and the SMS conversation is ended; one who asks the AI not to be contacted, on a call or by text, is recorded the same way.'}
        </div>
      </section>
    </div>
  );
};
