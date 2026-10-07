import React, { useEffect, useState } from 'react';
import { Loader2, AlertTriangle, MessageSquare, Phone, Save, Plus, Trash2, ArrowUp, ArrowDown } from 'lucide-react';
import { Strategy, StrategyStep, getStrategy, saveStrategy, emptyStep } from '../../utils/strategiesApi';

// Single editable strategy: the voice + SMS sequence for new leads.
export const StrategyEditor: React.FC = () => {
  const [steps, setSteps] = useState<StrategyStep[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getStrategy()
      .then((s: Strategy) => setSteps(s.steps || []))
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
    setSaved(false);
    try {
      const s = await saveStrategy({ steps });
      setSteps(s.steps || []);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e: any) {
      setError(e.message);
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
      {steps.length === 0 && <p className="text-xs text-slate-500">No steps yet — add at least one call or SMS below.</p>}

      {steps.map((step, i) => (
        <div key={step.id} className="p-3 bg-slate-950/60 rounded-xl border border-slate-800 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-slate-500 font-mono text-2xs w-5">{i + 1}</span>

            <select
              value={step.channel}
              onChange={(e) => setStep(i, { channel: e.target.value as 'sms' | 'voice', action: e.target.value === 'voice' ? 'ai_call' : 'send_sms' })}
              className="bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-white text-xs focus:outline-none focus:border-emerald-500"
            >
              <option value="sms">💬 SMS</option>
              <option value="voice">📞 AI Voice Call</option>
            </select>

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

            <div className="ml-auto flex items-center gap-1">
              <button type="button" onClick={() => move(i, -1)} className="text-slate-500 hover:text-slate-200 p-1"><ArrowUp className="w-3.5 h-3.5" /></button>
              <button type="button" onClick={() => move(i, 1)} className="text-slate-500 hover:text-slate-200 p-1"><ArrowDown className="w-3.5 h-3.5" /></button>
              <button type="button" onClick={() => removeStep(i)} className="text-rose-400 hover:text-rose-300 p-1"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          </div>

          {step.channel === 'sms' ? (
            <textarea
              value={step.message || ''}
              onChange={(e) => setStep(i, { message: e.target.value })}
              rows={2}
              placeholder="Message text… use {{firstName}} and {{brokerage}}"
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-emerald-500 resize-y"
            />
          ) : (
            <p className="text-xs text-slate-500 flex items-center gap-1.5 pl-7">
              <Phone className="w-3 h-3" /> AI voice agent calls the lead and qualifies them.
            </p>
          )}
        </div>
      ))}

      <div className="flex items-center gap-2 pt-1">
        <button type="button" onClick={() => addStep('sms')} className="flex items-center gap-1 text-xs text-emerald-400 font-semibold hover:text-emerald-300">
          <MessageSquare className="w-3.5 h-3.5" /> Add SMS
        </button>
        <button type="button" onClick={() => addStep('voice')} className="flex items-center gap-1 text-xs text-emerald-400 font-semibold hover:text-emerald-300">
          <Phone className="w-3.5 h-3.5" /> Add Call
        </button>
        <div className="ml-auto flex items-center gap-2">
          {saved && <span className="text-xs text-emerald-400 font-semibold">Saved ✓</span>}
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
