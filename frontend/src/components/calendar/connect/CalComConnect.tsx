import React, { useState } from 'react';
import { Check, KeyRound, Link2, User, Users } from 'lucide-react';
import { messageFor } from '../../../lib/api';
import { connectCalCom, listCalComTeams, setCalComWorkspace, type CalComAccountCheck } from '../../../utils/calendarApi';
import { Button } from '../../common/Button';
import { Notice, PROVIDERS, panel } from '../shared/ui';

type Target = 'personal' | number;

export const CalComConnect: React.FC<{ onConnected: () => Promise<boolean>; reconnect?: boolean }> = ({
  onConnected,
  reconnect,
}) => {
  const [checked, setChecked] = useState<CalComAccountCheck | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const account = checked?.account;

  const check = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setChecked(null);
    setTarget(null);
    try {
      // The key is entered in Nango's window and linked as the calendar (personal to start with).
      if (!(await connectCalCom())) return;
      const result = await listCalComTeams();
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
      await setCalComWorkspace(target === 'personal' ? null : target);
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

      <div>
        <p className="text-xs font-semibold text-slate-300 mb-1.5">Cal.com API key</p>
        {!checked && (
          <Button variant="secondary" onClick={() => void check()} loading={busy} icon={<KeyRound />}>
            Enter API key
          </Button>
        )}
        <p className="mt-1.5 text-2xs text-slate-500">
          Find it in Cal.com under Settings → Developer → API keys. You enter it in a secure window; it is stored by our
          credential vault (Nango), never in this browser.
        </p>
      </div>

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

          <Button onClick={() => void connect()} disabled={target === null} loading={busy} icon={<Link2 />}>
            {reconnect ? 'Reconnect Cal.com' : 'Connect Cal.com'}
          </Button>
        </div>
      )}
    </div>
  );
};
