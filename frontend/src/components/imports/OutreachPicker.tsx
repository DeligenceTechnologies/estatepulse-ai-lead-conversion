import React from 'react';
import { CalendarClock, Clock, PhoneCall } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { pathForView } from '../../context/AppContext';
import { earliestStart, upcoming, wallClockNow, type OutreachChoice, type OutreachConfig, type OutreachMode } from '../../utils/outreachApi';
import { TimezoneSelect } from '../common/TimezoneSelect';

const field = 'bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-600';

export interface Launch {
  mode: OutreachMode;
  date: string;
  time: string;
  timeZone: string;
}

export const initialLaunch = (config: OutreachConfig): Launch => ({ mode: 'now', timeZone: config.timeZone, ...earliestStart(config.timeZone) });

export const launchChoice = (l: Launch): OutreachChoice =>
  l.mode === 'now' ? { mode: 'now' } : { mode: 'scheduled', date: l.date, time: l.time, timeZone: l.timeZone };

/** Why this launch cannot be sent as it is, or null. The server checks the time again. */
export function launchProblem(l: Launch): string | null {
  if (l.mode === 'now') return null;
  if (!l.date || !l.time) return 'Pick a date and a time.';
  if (`${l.date} ${l.time}` <= wallClockNow(l.timeZone)) return `That time has already passed in ${l.timeZone}. Pick a later one.`;
  return null;
}

/**
 * "When to send the calls" for leads being approved: now, or at a date and
 * time in a chosen zone. Below it, read-only, when calls may run (the
 * organization's contact window), how many run at once and how many slots a
 * batch leaves free, each with a link to the very card on AI Settings where it
 * is changed.
 */
export const OutreachPicker: React.FC<{ config: OutreachConfig; value: Launch; onChange: (l: Launch) => void }> = ({ config, value, onChange }) => {
  const navigate = useNavigate();
  /** A "Change" link to one AI Settings card: the page scrolls to it and points it out. */
  const change = (card: 'contact-window' | 'call-capacity' | 'call-pacing', where: string) => (
    <button
      type="button"
      onClick={() => navigate({ pathname: pathForView('ai_settings'), hash: card })}
      title={`Change in AI Settings → ${where}`}
      className="font-bold text-emerald-300 hover:text-emerald-200 cursor-pointer"
    >
      Change
    </button>
  );
  const set = (patch: Partial<Launch>) => onChange({ ...value, ...patch });
  /** Clicks, zones and today picked as the date also move a past time up to now. A typed time stays as typed (snapping mid-keystroke fights the input) and is flagged. */
  const move = (patch: Partial<Launch>) => onChange(upcoming({ ...value, ...patch }));
  const now = wallClockNow(value.timeZone);
  const today = now.slice(0, 10);
  const problem = launchProblem(value);

  const option = (mode: OutreachMode, icon: React.ReactNode, label: string, hint: string) => (
    <button
      type="button"
      onClick={() => move({ mode })}
      aria-pressed={value.mode === mode}
      className={`flex-1 text-left rounded-xl border p-3 transition-colors cursor-pointer ${
        value.mode === mode ? 'border-emerald-500/60 bg-emerald-500/10' : 'border-slate-800 hover:border-slate-700'
      }`}
    >
      <div className="flex items-center gap-2 text-xs font-bold text-white">
        {icon}
        {label}
        <span className={`ml-auto w-3 h-3 rounded-full border-2 ${value.mode === mode ? 'border-emerald-400 bg-emerald-400' : 'border-slate-600'}`} />
      </div>
      <div className="text-2xs text-slate-400 mt-1">{hint}</div>
    </button>
  );

  return (
    <div className="space-y-3">
      <div className="text-xs font-bold text-slate-200">When to send the calls</div>
      <div className="flex gap-2">
        {option('now', <PhoneCall className="w-3.5 h-3.5 text-emerald-400" />, 'Send now', 'Starts right away, a few calls at a time.')}
        {option('scheduled', <CalendarClock className="w-3.5 h-3.5 text-sky-400" />, 'Schedule', 'Starts at a date and time you pick.')}
      </div>

      {value.mode === 'scheduled' && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <label className="text-2xs text-slate-400 space-y-1">
              <span className="block font-semibold text-slate-300">Date</span>
              <input
                type="date"
                value={value.date}
                min={today}
                onChange={(e) => (e.target.value === today ? move : set)({ date: e.target.value })}
                className={`${field} w-full`}
              />
            </label>
            <label className="text-2xs text-slate-400 space-y-1">
              <span className="block font-semibold text-slate-300">Time</span>
              <input
                type="time"
                value={value.time}
                min={value.date === today ? now.slice(11) : undefined}
                onChange={(e) => set({ time: e.target.value })}
                className={`${field} w-full`}
              />
            </label>
          </div>
          <label className="text-2xs text-slate-400 space-y-1 block">
            <span className="block font-semibold text-slate-300">Time zone</span>
            <TimezoneSelect value={value.timeZone} onChange={(timeZone) => move({ timeZone })} className={`${field} w-full`} />
          </label>
          {problem && <div className="text-2xs text-rose-300">{problem}</div>}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2 text-2xs text-slate-400">
        <span className="font-semibold text-slate-300">When calls can run</span>
        <span className="flex flex-wrap items-center gap-1.5">
          <Clock className="w-3 h-3 text-amber-400" />
          {config.quietHours ? `${config.quietHours.end}–${config.quietHours.start} daily (${config.timeZone})` : 'Any time'}
          {change('contact-window', 'Contact Window')}
          <span className="text-slate-600">·</span>
          up to {config.maxConcurrentCalls} at once
          {change('call-capacity', 'Call Capacity')}
        </span>
      </div>
      <p className="text-2xs text-slate-500 flex flex-wrap items-center gap-1">
        {config.quietHours && <span>A start outside these hours waits for them.</span>}
        <span>
          {config.reservedCallSlots} call slot{config.reservedCallSlots === 1 ? ' stays' : 's stay'} free for new leads and follow-ups.
        </span>
        {change('call-pacing', 'Call Pacing')}
      </p>
    </div>
  );
};
