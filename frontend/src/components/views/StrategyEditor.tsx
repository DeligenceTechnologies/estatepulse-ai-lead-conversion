import React, { useEffect, useState } from 'react';
import { Loader2, AlertTriangle, MessageSquare, Phone, Save, ArrowUpDown, Info } from 'lucide-react';
import { toast } from 'react-toastify';
import { ConditionSelect } from '../outreach/ConditionSelect';
import { SafetyRulesList } from '../outreach/SafetyRulesList';
import {
  SafetyRule,
  StrategyStep,
  callFirst,
  channelLabel,
  getStrategyEditor,
  saveStrategySteps,
  stepSummary,
  stepsError,
  swapOrder,
} from '../../utils/strategiesApi';

interface Props {
  /** Set when the office's calling provider has no SMS: the call goes first and the SMS card shows why it is off. */
  smsUnavailableReason?: string;
}

const field = 'bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-white text-xs focus:outline-none focus:border-emerald-500';

const WaitInput: React.FC<{ after: StrategyStep['after']; disabled?: boolean; onChange: (a: StrategyStep['after']) => void }> = ({ after, disabled, onChange }) => (
  <>
    <input
      type="number"
      min={0}
      disabled={disabled}
      value={after.value}
      onChange={(e) => onChange({ ...after, value: Number(e.target.value) })}
      className={`w-16 ${field}`}
    />
    <select disabled={disabled} value={after.unit} onChange={(e) => onChange({ ...after, unit: e.target.value as StrategyStep['after']['unit'] })} className={field}>
      <option value="minutes">min</option>
      <option value="hours">hr</option>
      <option value="seconds">sec</option>
      <option value="days">days</option>
    </select>
  </>
);

// The outreach strategy for new leads: one AI call and one SMS, in the order the owner picks.
export const StrategyEditor: React.FC<Props> = ({ smsUnavailableReason }) => {
  const [steps, setSteps] = useState<StrategyStep[]>([]);
  // The saved strategy's step count while the editor shows its two-step form instead.
  const [olderCount, setOlderCount] = useState<number | null>(null);
  const [safetyRules, setSafetyRules] = useState<SafetyRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const shown = (s: StrategyStep[]) => (smsUnavailableReason ? callFirst(s) : s);

  useEffect(() => {
    getStrategyEditor()
      .then(({ strategy, editor, safetyRules: rules }) => {
        setSteps(shown(editor.steps));
        setOlderCount(editor.converted ? strategy.steps.length : null);
        setSafetyRules(rules ?? []);
      })
      .catch(() => setLoadFailed(true))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [smsUnavailableReason]);

  const setStep = (i: number, patch: Partial<StrategyStep>) => {
    setError(null);
    setSteps((ss) => ss.map((s, k) => (k === i ? { ...s, ...patch } : s)));
  };

  const save = async () => {
    const problem = stepsError(steps);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { editor } = await saveStrategySteps(steps);
      setSteps(shown(editor.steps));
      setOlderCount(null);
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

  const card = (step: StrategyStep, i: number) => {
    const off = step.channel === 'sms' && !!smsUnavailableReason;
    const Icon = step.channel === 'voice' ? Phone : MessageSquare;
    const context = steps[0]?.channel === 'voice' ? 'after_call' : 'after_sms';
    return (
      <div key={step.id} className={`p-3 bg-slate-950/60 rounded-xl border border-slate-800 space-y-2 ${off ? 'opacity-60' : ''}`}>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-slate-500 font-mono text-2xs w-5">{i + 1}</span>
          <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-100">
            <Icon className="w-3.5 h-3.5 text-emerald-400" /> {channelLabel(step.channel)}
          </span>
          {i === 0 ? (
            <>
              <span className="text-slate-400 text-xs">start after</span>
              <WaitInput after={step.after} disabled={off} onChange={(after) => setStep(i, { after })} />
            </>
          ) : (
            <>
              <span className="text-slate-400 text-xs">wait</span>
              <WaitInput after={step.after} disabled={off} onChange={(after) => setStep(i, { after })} />
              <span className="text-slate-400 text-xs">after {steps[0]?.channel === 'voice' ? 'the call ends' : 'the SMS is sent'}</span>
            </>
          )}
        </div>

        {i === 1 && !off && (
          <div className="flex items-start gap-2 flex-wrap pl-7">
            <span className="text-slate-400 text-xs py-1.5">send</span>
            <ConditionSelect value={step.onlyIf} onChange={(onlyIf) => setStep(i, { onlyIf })} context={context} className={field} />
          </div>
        )}

        {off && (
          <p className="text-xs text-amber-300 flex items-center gap-1.5 pl-7">
            <AlertTriangle className="w-3 h-3" /> {smsUnavailableReason}
          </p>
        )}

        {step.channel === 'sms' ? (
          <textarea
            value={step.message || ''}
            disabled={off}
            onChange={(e) => setStep(i, { message: e.target.value })}
            rows={2}
            placeholder="Message text… use {{firstName}} and {{brokerage}}"
            className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-emerald-500 resize-y disabled:cursor-not-allowed"
          />
        ) : (
          <p className="text-xs text-slate-500 flex items-center gap-1.5 pl-7">
            <Phone className="w-3 h-3" /> AI voice agent calls the lead and qualifies them.
          </p>
        )}

        {!off && <p className="text-xs text-emerald-300/90 italic pl-7">{stepSummary(steps, i)}</p>}
        <SafetyRulesList rules={safetyRules} scope="strategy" />
      </div>
    );
  };

  return (
    <div className="space-y-2 pt-1">
      {olderCount !== null && (
        <div className="flex items-start gap-1.5 text-xs text-amber-200 bg-amber-950/40 border border-amber-900/40 rounded-lg px-3 py-2">
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            Your saved strategy has {olderCount} step{olderCount === 1 ? '' : 's'} and keeps running as it is until you save. A strategy is now
            one AI call and one SMS: below are its first call and first SMS, in the order they went out. Check them, then save to switch.
          </span>
        </div>
      )}
      {error && (
        <div className="flex items-center gap-1.5 text-xs text-rose-300 bg-rose-950/40 border border-rose-900/40 rounded-lg px-3 py-1.5">
          <AlertTriangle className="w-3.5 h-3.5" /> {error}
        </div>
      )}

      {steps[0] && card(steps[0], 0)}
      <div className="flex justify-center">
        <button
          type="button"
          onClick={() => setSteps((s) => swapOrder(s))}
          disabled={!!smsUnavailableReason}
          title={smsUnavailableReason ? 'Without SMS the call always goes first' : 'Send the other one first'}
          className="flex items-center gap-1 text-xs text-emerald-400 font-semibold hover:text-emerald-300 disabled:text-slate-600 disabled:cursor-not-allowed"
        >
          <ArrowUpDown className="w-3.5 h-3.5" /> Swap order
        </button>
      </div>
      {steps[1] && card(steps[1], 1)}

      <div className="flex items-center justify-end pt-1">
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
  );
};
