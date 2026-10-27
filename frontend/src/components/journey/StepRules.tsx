import React from 'react';
import { Filter, ShieldCheck, Voicemail } from 'lucide-react';
import { ALWAYS_ON_RULES, allowedConditions, type StepChannel, type StepConditions, type StepVoicemail } from '../../utils/journey';

interface Props {
  channel: StepChannel;
  onlyIf?: StepConditions;
  voicemail?: StepVoicemail;
  /** The channel of the step right before; unset on the first step, which always runs. */
  previous?: StepChannel;
  onChange: (patch: { onlyIf?: StepConditions; voicemail?: StepVoicemail }) => void;
}

const chip = (on: boolean, enabled: boolean) =>
  `flex items-center gap-1.5 px-2 py-1 rounded-lg border text-2xs font-semibold select-none ${
    !enabled
      ? 'border-slate-800/60 text-slate-600 opacity-50 cursor-not-allowed'
      : on
        ? 'border-emerald-600/60 bg-emerald-600/15 text-emerald-300 cursor-pointer'
        : 'border-slate-800 text-slate-400 hover:border-slate-700 cursor-pointer'
  }`;

/**
 * A step's own rules, the same in the strategy and in a sequence: when it runs
 * at all, and, for a call, what it leaves on an answering machine. Its
 * condition can only be about the step right before it.
 */
export const StepRules: React.FC<Props> = ({ channel, onlyIf, voicemail, previous, onChange }) => {
  const allowed = allowedConditions(previous);
  const set = (key: keyof StepConditions, value: boolean) => {
    const next = { ...(onlyIf ?? {}), [key]: value || undefined };
    onChange({ onlyIf: next.lastCallMissed || next.noReply ? next : undefined });
  };
  const why = (needs: StepChannel) =>
    !previous ? 'The first step always runs: there is nothing before it to check.' : `Only after ${needs === 'voice' ? 'a call' : 'a text'}: the step before this one is ${previous === 'voice' ? 'a call' : 'a text'}.`;

  return (
    <div className="flex items-center gap-2 flex-wrap text-2xs">
      <span className="text-slate-500 flex items-center gap-1">
        <Filter className="w-3 h-3" /> Only if
      </span>
      <label
        className={chip(!!onlyIf?.lastCallMissed, allowed.lastCallMissed)}
        title={allowed.lastCallMissed ? "The call in the step before went unanswered: no answer, voicemail, busy, declined, hung up at once, or failed." : why('voice')}
      >
        <input
          type="checkbox"
          className="accent-emerald-500 disabled:cursor-not-allowed"
          checked={!!onlyIf?.lastCallMissed}
          disabled={!allowed.lastCallMissed}
          onChange={(e) => set('lastCallMissed', e.target.checked)}
        />
        the last call wasn&apos;t answered
      </label>
      <label
        className={chip(!!onlyIf?.noReply, allowed.noReply)}
        title={allowed.noReply ? 'The lead has not texted back. Skipped once they have.' : why('sms')}
      >
        <input
          type="checkbox"
          className="accent-emerald-500 disabled:cursor-not-allowed"
          checked={!!onlyIf?.noReply}
          disabled={!allowed.noReply}
          onChange={(e) => set('noReply', e.target.checked)}
        />
        they haven&apos;t replied
      </label>
      {!previous ? (
        <span className="text-slate-600">— the first step always runs</span>
      ) : (
        !onlyIf?.lastCallMissed && !onlyIf?.noReply && <span className="text-slate-600">— always</span>
      )}

      {channel === 'voice' && (
        <span className="flex items-center gap-1.5 ml-auto">
          <Voicemail className="w-3 h-3 text-slate-500" />
          <span className="text-slate-500">On voicemail</span>
          <select
            value={voicemail ?? 'default'}
            onChange={(e) => onChange({ voicemail: e.target.value as StepVoicemail })}
            className="bg-slate-950 border border-slate-800 rounded-lg px-2 py-1 text-white text-2xs focus:outline-none focus:border-emerald-500"
          >
            <option value="default">AI Settings default</option>
            <option value="leave">Leave the message</option>
            <option value="skip">Hang up, no message</option>
          </select>
        </span>
      )}
    </div>
  );
};

/** The rules every step obeys, said plainly so the step list is never mistaken for the whole story. */
export const AlwaysOnRules: React.FC<{ className?: string }> = ({ className }) => (
  <details className={`group text-2xs text-slate-400 bg-slate-950/40 border border-slate-800 rounded-xl px-3 py-2 ${className ?? ''}`}>
    <summary className="cursor-pointer select-none flex items-center gap-1.5 text-slate-300 font-semibold">
      <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
      Always on, for every step
    </summary>
    <ul className="mt-2 space-y-1 list-disc pl-5">
      {ALWAYS_ON_RULES.map((rule) => (
        <li key={rule}>{rule}</li>
      ))}
    </ul>
  </details>
);
