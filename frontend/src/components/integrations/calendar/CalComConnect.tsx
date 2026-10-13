import React, { useState } from 'react';
import { Check, Eye, EyeOff, KeyRound, Link2, Loader2, User, Users } from 'lucide-react';
import { messageFor } from '../../../lib/api';
import { connectCalCom, listCalComTeams, type CalComAccountCheck } from '../../../utils/calendarApi';
import { Notice, PROVIDERS, PrimaryButton, panel } from './ui';

type Target = 'personal' | number;

export const CalComConnect: React.FC<{ onConnected: () => Promise<boolean>; reconnect?: boolean }> = ({
  onConnected,
  reconnect,
}) => {
  const [apiKey, setApiKey] = useState('');
  const [reveal, setReveal] = useState(false);
  const [checked, setChecked] = useState<CalComAccountCheck | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const key = apiKey.trim();
  const account = checked?.account;

  const check = async () => {
    if (!key || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await listCalComTeams(key);
      setChecked(result);
      setTarget(result.teams.length === 0 ? 'personal' : result.teams.length === 1 ? result.teams[0].id : null);
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    if (target === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await connectCalCom(key, target === 'personal' ? null : target);
      await onConnected();
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  };

  const option = (value: Target, title: string, subtitle: string | null, icon: React.ReactNode) => (
    <label
      key={String(value)}
      className={`${panel} px-3 py-2.5 flex items-center gap-3 cursor-pointer transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-indigo-400 ${
        target === value ? PROVIDERS.cal.selected : 'hover:border-slate-700'
      }`}
    >
      <input
        type="radio"
        name="cal-target"
        checked={target === value}
        onChange={() => setTarget(value)}
        disabled={busy}
        className="sr-only"
      />
      <span className="w-8 h-8 rounded-lg bg-slate-800 text-slate-300 flex items-center justify-center shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-semibold text-white truncate">{title}</span>
        {subtitle && <span className="block text-2xs text-slate-500 font-mono truncate">{subtitle}</span>}
      </span>
      <span
        aria-hidden
        className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 ${
          target === value ? 'border-indigo-400 bg-indigo-500' : 'border-slate-600'
        }`}
      >
        {target === value && <Check className="w-2.5 h-2.5 text-white" />}
      </span>
    </label>
  );

  return (
    <div className="space-y-3">
      {error && <Notice tone="error">{error}</Notice>}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void check();
        }}
      >
        <label htmlFor="cal-api-key" className="block text-xs font-semibold text-slate-300 mb-1.5">
          Cal.com API key
        </label>
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <KeyRound className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              id="cal-api-key"
              type={reveal ? 'text' : 'password'}
              value={apiKey}
              autoComplete="off"
              spellCheck={false}
              placeholder="cal_live_…"
              disabled={busy}
              onChange={(e) => {
                setApiKey(e.target.value);
                setChecked(null);
                setTarget(null);
              }}
              className={`w-full h-9 bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-9 text-xs text-white font-mono focus:outline-none disabled:opacity-60 ${PROVIDERS.cal.focus}`}
            />
            <button
              type="button"
              onClick={() => setReveal((value) => !value)}
              aria-label={reveal ? 'Hide API key' : 'Show API key'}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-slate-500 hover:text-slate-300 cursor-pointer"
            >
              {reveal ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </button>
          </div>
          {!checked && (
            <button
              type="submit"
              disabled={busy || !key}
              className="h-9 px-4 rounded-lg text-xs font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 inline-flex items-center justify-center gap-1.5 cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              Verify key
            </button>
          )}
        </div>
        <p className="mt-1.5 text-2xs text-slate-500">
          Find it in Cal.com under Settings → Developer → API keys. It is stored encrypted.
        </p>
      </form>

      {checked && (
        <div className="space-y-2.5">
          <Notice tone="success">
            Key verified for <span className="font-semibold">{account?.email ?? account?.name ?? 'your account'}</span>.
          </Notice>

          <fieldset className="space-y-1.5">
            <legend className="text-xs font-semibold text-slate-300 mb-1.5">Which calendar should EstatePulse use?</legend>
            {option(
              'personal',
              account?.name ? `Personal · ${account.name}` : 'Personal account',
              account?.username ? `cal.com/${account.username}` : null,
              <User className="w-4 h-4" />,
            )}
            {checked.teams.map((team) =>
              option(team.id, team.name, team.slug ? `cal.com/team/${team.slug}` : null, <Users className="w-4 h-4" />),
            )}
          </fieldset>

          <p className="text-2xs text-slate-500 leading-relaxed">
            {target === 'personal'
              ? 'Uses your own meetings. Pick a team to share bookings across agents.'
              : target !== null
                ? 'Uses the team’s members and meetings. You must be an owner or admin of the team.'
                : 'Choose your personal account or one of your teams.'}
          </p>

          <PrimaryButton
            onClick={() => void connect()}
            disabled={target === null}
            busy={busy}
            className={PROVIDERS.cal.button}
            icon={<Link2 className="w-3.5 h-3.5" />}
          >
            {reconnect ? 'Reconnect Cal.com' : 'Connect Cal.com'}
          </PrimaryButton>
        </div>
      )}
    </div>
  );
};
