import React, { useEffect, useState } from 'react';
import { Loader2, AlertTriangle, MessageSquare, Phone, Save, Trash2, ArrowUp, ArrowDown, LayoutTemplate } from 'lucide-react';
import { toast } from 'react-toastify';
import { CALL_CONTEXT_MAX_CHARS, STRATEGY_PRESETS, fitSteps } from '../../utils/journey';
import { Strategy, StrategyStep, getStrategy, saveStrategy, emptyStep } from '../../utils/strategiesApi';
import { AlwaysOnRules, StepRules } from '../journey/StepRules';

/** A step's condition depends on the step before it, so every change refits them all. */
const fit = (steps: StrategyStep[]) => fitSteps(steps, (s) => s.channel);

// Single editable strategy: the voice + SMS sequence for new leads.
// smsDisabledReason: the calling provider sends no SMS (Retell) — SMS steps stay
// visible, marked as not sent with the reason, and no new ones can be added.
export const StrategyEditor: React.FC<{ smsDisabledReason?: string }> = ({ smsDisabledReason }) => {
  const [steps, setStepsRaw] = useState<StrategyStep[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const setSteps = (next: (ss: StrategyStep[]) => StrategyStep[]) => setStepsRaw((ss) => fit(next(ss)));

  useEffect(() => {
    getStrategy()
      .then((s: Strategy) => setStepsRaw(fit(s.steps || [])))
      .catch(() => setLoadFailed(true))
      .finally(() => setLoading(false));
  }, []);

  const setStep = (i: number, patch: Partial<StrategyStep>) =>
    setSteps((ss) => ss.map((s, k) => (k === i ? { ...s, ...patch } : s)));
  const move = (i: number, dir: number) =>
    setSteps((ss) => {
      const j = i + dir;
      if (j < 0 || j >= ss.length) return ss;
      const copy = ss.slice();
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
  const addStep = (channel: 'sms' | 'voice') => {
    setError(null);
    setSteps((ss) => [...ss, { ...emptyStep(), channel, action: channel === 'voice' ? 'ai_call' : 'send_sms' }]);
  };
  const removeStep = (i: number) => setSteps((ss) => ss.filter((_, k) => k !== i));
  const applyPreset = (key: string) => {
    const preset = STRATEGY_PRESETS.find((p) => p.key === key);
    if (!preset) return;
    if (steps.length > 0 && !window.confirm(`Replace your ${steps.length} step(s) with the "${preset.name}" template? Nothing changes until you save.`)) return;
    setError(null);
    setSteps(() => preset.steps());
  };

  const save = async () => {
    // Require at least one step.
    if (steps.length === 0) {
      setError('At least one call or SMS is required.');
      return;
    }
    // Every SMS step needs a message.
    if (steps.some((s) => s.channel === 'sms' && !(s.message || '').trim())) {
      setError('Every SMS step needs a message.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const s = await saveStrategy({ steps });
      setStepsRaw(fit(s.steps || []));
      toast.success('Strategy saved.');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-slate-400 pt-1">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading strategy…
      </div>
    );
  }
  if (loadFailed) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-amber-400 pt-1">
        <AlertTriangle className="w-3.5 h-3.5" /> Strategy engine offline — start the backend
      </div>
    );
  }

  return (
    <div className="space-y-2 pt-1">
      {error && (
        <div className="flex items-center gap-1.5 text-xs text-rose-300 bg-rose-950/40 border border-rose-900/40 rounded-lg px-3 py-1.5">
          <AlertTriangle className="w-3.5 h-3.5" /> {error}
        </div>
      )}
      <div className="flex items-center gap-2 text-xs">
        <LayoutTemplate className="w-3.5 h-3.5 text-slate-500" />
        <select
          value=""
          onChange={(e) => applyPreset(e.target.value)}
          className="bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-slate-300 text-xs focus:outline-none focus:border-emerald-500"
        >
          <option value="">Start from a template…</option>
          {STRATEGY_PRESETS.map((p) => (
            <option key={p.key} value={p.key} title={p.description}>
              {p.name}
            </option>
          ))}
        </select>
        <span className="text-2xs text-slate-500 truncate">Templates fill the steps below; edit anything before saving.</span>
      </div>

      {steps.length === 0 && <p className="text-xs text-slate-500">No steps yet — add at least one call or SMS below.</p>}

      {smsDisabledReason && steps.some((s) => s.channel === 'sms') && (
        <div className="flex items-center gap-1.5 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {smsDisabledReason} SMS steps below are kept but not sent.
        </div>
      )}

      {steps.map((step, i) => (
        <div
          key={step.id}
          className={`p-3 bg-slate-950/60 rounded-xl border border-slate-800 space-y-2 ${smsDisabledReason && step.channel === 'sms' ? 'opacity-60' : ''}`}
        >
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-slate-500 font-mono text-2xs w-5">{i + 1}</span>

            <select
              value={step.channel}
              onChange={(e) => setStep(i, { channel: e.target.value as 'sms' | 'voice', action: e.target.value === 'voice' ? 'ai_call' : 'send_sms' })}
              className="bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-white text-xs focus:outline-none focus:border-emerald-500"
            >
              <option value="sms" disabled={!!smsDisabledReason && step.channel !== 'sms'}>💬 SMS</option>
              <option value="voice">📞 AI Voice Call</option>
            </select>
            {smsDisabledReason && step.channel === 'sms' && (
              <span className="text-2xs font-bold uppercase text-amber-300" title={smsDisabledReason}>Not sent</span>
            )}

            <span className="text-slate-400 text-xs">wait</span>
            <input
              type="number" min={0}
              value={step.after.value}
              onChange={(e) => setStep(i, { after: { ...step.after, value: Number(e.target.value) } })}
              className="w-16 bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-white text-xs focus:outline-none focus:border-emerald-500"
            />
            <select
              value={step.after.unit}
              onChange={(e) => setStep(i, { after: { ...step.after, unit: e.target.value as any } })}
              className="bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-white text-xs focus:outline-none focus:border-emerald-500"
            >
              <option value="seconds">sec</option>
              <option value="minutes">min</option>
              <option value="hours">hr</option>
              <option value="days">days</option>
            </select>
            <span className="text-slate-500 text-xs">{i === 0 ? 'after the lead comes in' : 'after the step before'}</span>

            <div className="ml-auto flex items-center gap-1">
              <button type="button" onClick={() => move(i, -1)} className="text-slate-500 hover:text-slate-200 p-1"><ArrowUp className="w-3.5 h-3.5" /></button>
              <button type="button" onClick={() => move(i, 1)} className="text-slate-500 hover:text-slate-200 p-1"><ArrowDown className="w-3.5 h-3.5" /></button>
              <button type="button" onClick={() => removeStep(i)} className="text-rose-400 hover:text-rose-300 p-1"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          </div>

          <StepRules
            channel={step.channel}
            onlyIf={step.onlyIf}
            voicemail={step.voicemail}
            previous={steps[i - 1]?.channel}
            onChange={(patch) => setStep(i, patch)}
          />

          {step.channel === 'sms' ? (
            <textarea
              value={step.message || ''}
              onChange={(e) => setStep(i, { message: e.target.value })}
              rows={2}
              readOnly={!!smsDisabledReason}
              title={smsDisabledReason}
              placeholder="Message text… use {{firstName}}, {{brokerage}}, {{location}}"
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-emerald-500 resize-y"
            />
          ) : (
            <div className="space-y-1">
              <textarea
                value={step.context || ''}
                onChange={(e) => setStep(i, { context: e.target.value.slice(0, CALL_CONTEXT_MAX_CHARS) })}
                rows={1}
                placeholder="Optional: why the AI is calling this time (e.g. second try, ask about financing)"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-emerald-500 resize-y"
              />
              <p className="text-2xs text-slate-500 flex items-center gap-1.5">
                <Phone className="w-3 h-3" /> The AI calls and qualifies the lead, with this as its reason for calling. The next step waits until the call has ended.
              </p>
            </div>
          )}
        </div>
      ))}

      <AlwaysOnRules />

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={() => addStep('sms')}
          disabled={!!smsDisabledReason}
          title={smsDisabledReason}
          className="flex items-center gap-1 text-xs text-emerald-400 font-semibold hover:text-emerald-300 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-emerald-400"
        >
          <MessageSquare className="w-3.5 h-3.5" /> Add SMS
        </button>
        <button type="button" onClick={() => addStep('voice')} className="flex items-center gap-1 text-xs text-emerald-400 font-semibold hover:text-emerald-300">
          <Phone className="w-3.5 h-3.5" /> Add Call
        </button>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-on-accent rounded-lg text-xs font-bold flex items-center gap-1.5"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            {saving ? 'Saving…' : 'Save Strategy'}
          </button>
        </div>
      </div>
    </div>
  );
};
