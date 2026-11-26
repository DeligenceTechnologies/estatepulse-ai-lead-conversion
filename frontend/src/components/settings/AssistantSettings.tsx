import React, { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, Mic, ScrollText, Sparkles, Wallet } from 'lucide-react';
import { toast } from 'react-toastify';
import { messageFor } from '../../lib/api';
import { formatDateTime } from '../../lib/datetime';
import {
  getAssistantLog,
  getAssistantSettings,
  updateAssistantSettings,
  usd,
  type AssistantLogEntry,
  type AssistantSettings as Settings,
  type AssistantSettingsView,
} from '../../utils/assistantSettingsApi';
import { Button } from '../common/Button';
import { Switch } from '../views/VoicemailCard';

const STATUS: Record<AssistantLogEntry['status'], { label: string; className: string }> = {
  executed: { label: 'Done', className: 'text-emerald-300' },
  proposed: { label: 'Waiting', className: 'text-amber-300' },
  executing: { label: 'Running', className: 'text-slate-300' },
  rejected: { label: 'Declined', className: 'text-slate-400' },
  expired: { label: 'Expired', className: 'text-slate-400' },
  failed: { label: 'Failed', className: 'text-rose-300' },
};

const Section: React.FC<{ title: string; hint: string; icon: React.ReactNode; aside?: React.ReactNode; children?: React.ReactNode }> = ({
  title,
  hint,
  icon,
  aside,
  children,
}) => (
  <section className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 sm:p-6 shadow-lg">
    <div className={`flex items-start justify-between gap-3 ${children ? 'mb-4' : ''}`}>
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 text-emerald-400">{icon}</span>
        <div>
          <h4 className="text-sm font-bold text-white">{title}</h4>
          <p className="text-xs text-slate-400 mt-0.5">{hint}</p>
        </div>
      </div>
      {aside}
    </div>
    {children}
  </section>
);

/**
 * Settings > Ask EstatePulse: the owner's switch for the whole office, a monthly spending limit
 * under the plan's allowance (with what was spent this month), the microphone, and a log of
 * everything the assistant did. Anyone with organization.read can look; changing needs
 * organization.update, which the server checks.
 */
export const AssistantSettings: React.FC = () => {
  const [view, setView] = useState<AssistantSettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<keyof Settings | null>(null);
  const [limit, setLimit] = useState('');

  useEffect(() => {
    getAssistantSettings()
      .then((v) => {
        setView(v);
        setLimit(v.settings.monthlyLimitUsd === null ? '' : String(v.settings.monthlyLimitUsd));
      })
      .catch((e) => setError(messageFor(e)));
  }, []);

  if (error) return <p className="text-sm text-rose-300">{error}</p>;
  if (!view) return <Loader2 className="w-5 h-5 animate-spin text-slate-500" aria-label="Loading" />;

  const save = async (key: keyof Settings, patch: Partial<Settings>, done: string): Promise<void> => {
    setSaving(key);
    try {
      const next = await updateAssistantSettings(patch);
      setView(next);
      setLimit(next.settings.monthlyLimitUsd === null ? '' : String(next.settings.monthlyLimitUsd));
      toast.success(done);
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setSaving(null);
    }
  };

  const { settings, usage, canEdit } = view;
  const limitValue = limit.trim() === '' ? null : Number(limit);
  const limitValid = limitValue === null || (Number.isFinite(limitValue) && limitValue >= 1);
  const limitChanged = limitValue !== settings.monthlyLimitUsd;

  return (
    <div className="space-y-5">
      {!view.serverEnabled && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden />
          The assistant is not switched on for this server yet, so these settings take effect once it is.
        </div>
      )}

      <Section
        title="Ask EstatePulse for your office"
        hint="When off, nobody in the office can use the assistant. Past chats are kept."
        icon={<Sparkles className="w-4 h-4" />}
        aside={
          <Switch
            id="assistant-enabled"
            on={settings.enabled}
            disabled={!canEdit || saving !== null}
            onChange={(on) => void save('enabled', { enabled: on }, on ? 'The assistant is on for your office.' : 'The assistant is off for your office.')}
            label={settings.enabled ? 'On' : 'Off'}
          />
        }
      />

      <AssistantSpend view={view} />

      <Section title="Monthly limit" hint="Stop the assistant for the month once this much is spent. Leave it empty to use your plan's allowance." icon={<Wallet className="w-4 h-4" />}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-slate-400">$</span>
          <input
            type="number"
            min={1}
            step="1"
            inputMode="decimal"
            value={limit}
            disabled={!canEdit}
            onChange={(e) => setLimit(e.target.value)}
            placeholder={(usage.planBudgetMicros / 1_000_000).toFixed(0)}
            aria-label="Monthly limit in US dollars"
            className="w-32 rounded-lg bg-slate-950 border border-slate-700 px-2.5 py-1.5 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-emerald-500 disabled:opacity-60"
          />
          <span className="text-xs text-slate-500">a month · plan allows {usd(usage.planBudgetMicros)}</span>
          {canEdit && (
            <Button size="sm" disabled={!limitChanged || !limitValid} loading={saving === 'monthlyLimitUsd'} onClick={() => void save('monthlyLimitUsd', { monthlyLimitUsd: limitValue }, 'Monthly limit saved.')}>
              Save
            </Button>
          )}
        </div>
        {!limitValid && <p className="mt-2 text-xs text-rose-300">Enter at least $1, or leave it empty.</p>}
        {limitValue !== null && limitValid && limitValue * 1_000_000 > usage.planBudgetMicros && (
          <p className="mt-2 text-xs text-slate-400">This is above your plan's allowance, so the plan's {usd(usage.planBudgetMicros)} still applies.</p>
        )}
      </Section>

      <Section
        title="Microphone"
        hint="A mic button in the chat box lets people speak instead of typing."
        icon={<Mic className="w-4 h-4" />}
        aside={
          <Switch
            id="assistant-voice"
            on={settings.voiceEnabled}
            disabled={!canEdit || saving !== null}
            onChange={(on) => void save('voiceEnabled', { voiceEnabled: on }, on ? 'Microphone on.' : 'Microphone off.')}
            label={settings.voiceEnabled ? 'On' : 'Off'}
          />
        }
      >
        <p className="text-xs leading-relaxed text-slate-400">
          The person's browser turns their speech into text, and only the text reaches us; no audio is stored. The browser's own speech
          service may receive the audio, though: Chrome sends it to Google, and Safari may send it to Apple. Firefox has no speech input, so
          the mic is hidden there.
        </p>
      </Section>

      <AssistantLog />
    </div>
  );
};

/** This month's spend against the limit, and what a question costs on average. */
export const AssistantSpend: React.FC<{ view: AssistantSettingsView }> = ({ view }) => {
  const { usage } = view;
  const share = usage.budgetMicros > 0 ? Math.min(1, usage.usedMicros / usage.budgetMicros) : 0;
  const average = usage.requests > 0 ? usage.usedMicros / usage.requests : null;
  return (
    <Section title="This month" hint={`Spending resets on the 1st. ${usage.officeLimitMicros === null ? "Your plan's allowance applies." : 'Your office limit applies.'}`} icon={<Wallet className="w-4 h-4" />}>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-bold text-white">
          {usd(usage.usedMicros)} <span className="font-normal text-slate-400">of {usd(usage.budgetMicros)}</span>
        </span>
        <span className="text-xs text-slate-500">
          {usage.requests} question{usage.requests === 1 ? '' : 's'}
          {average !== null ? ` · about ${usd(average)} each` : ''}
        </span>
      </div>
      <div className="mt-2 h-2 rounded-full bg-slate-800 overflow-hidden" role="progressbar" aria-valuenow={Math.round(share * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Share of the monthly limit spent">
        <div className={`h-full rounded-full ${share >= 1 ? 'bg-rose-500' : share >= 0.8 ? 'bg-amber-400' : 'bg-emerald-500'}`} style={{ width: `${share * 100}%` }} />
      </div>
    </Section>
  );
};

/** Everything the assistant looked up or changed, newest first. */
const AssistantLog: React.FC = () => {
  const [entries, setEntries] = useState<AssistantLogEntry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    getAssistantLog()
      .then((r) => {
        setEntries(r.entries);
        setCursor(r.nextCursor);
      })
      .catch(() => setEntries([]));
  }, []);

  const more = async (): Promise<void> => {
    if (!cursor) return;
    setLoading(true);
    try {
      const r = await getAssistantLog(cursor);
      setEntries((e) => [...(e ?? []), ...r.entries]);
      setCursor(r.nextCursor);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Section title="Activity log" hint="Every look-up and every change the assistant made, and who asked for it." icon={<ScrollText className="w-4 h-4" />}>
      {entries === null ? (
        <Loader2 className="w-4 h-4 animate-spin text-slate-500" aria-label="Loading" />
      ) : entries.length === 0 ? (
        <p className="text-xs text-slate-500">Nothing yet.</p>
      ) : (
        <AssistantLogTable entries={entries} />
      )}
      {cursor && (
        <Button variant="link" onClick={() => void more()} disabled={loading}>
          {loading ? 'Loading…' : 'Show more'}
        </Button>
      )}
    </Section>
  );
};

export const AssistantLogTable: React.FC<{ entries: AssistantLogEntry[] }> = ({ entries }) => (
  <div className="overflow-x-auto -mx-1">
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left text-2xs uppercase tracking-wide text-slate-500">
          <th className="px-1 py-1.5 font-bold">When</th>
          <th className="px-1 py-1.5 font-bold">Who</th>
          <th className="px-1 py-1.5 font-bold">What</th>
          <th className="px-1 py-1.5 font-bold">Result</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-800">
        {entries.map((e) => (
          <tr key={e.id} className="align-top">
            <td className="px-1 py-1.5 whitespace-nowrap text-slate-400">{formatDateTime(e.at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
            <td className="px-1 py-1.5 whitespace-nowrap text-slate-300">{e.user ?? 'Former member'}</td>
            <td className="px-1 py-1.5 text-slate-200">
              {e.what}
              {e.tier === 'write' && <span className="ml-1.5 text-2xs text-slate-500">change</span>}
              {e.error && e.status === 'failed' && <span className="block text-2xs text-slate-500">{e.error}</span>}
            </td>
            <td className={`px-1 py-1.5 whitespace-nowrap font-semibold ${STATUS[e.status].className}`}>{STATUS[e.status].label}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);
