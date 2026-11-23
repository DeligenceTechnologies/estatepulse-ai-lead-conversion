import React, { useEffect, useState } from 'react';
import { Loader2, UserRound } from 'lucide-react';
import { toast } from 'react-toastify';
import { messageFor } from '../../lib/api';
import { getTakeoverGreeting, updateTakeoverGreeting, type TakeoverGreeting } from '../../utils/smsConversationApi';
import { Switch } from './VoicemailCard';
import { Button } from '../common/Button';

/** Matches the server's limit: two SMS segments at most. */
const MAX_CHARS = 320;

/**
 * The one place an organization decides what a lead is texted when an agent
 * takes their chat over from the AI: on or off, and its words. It goes out
 * from the agent, on the organization's number, the moment they take over.
 */
export const TakeoverGreetingCard: React.FC = () => {
  const [status, setStatus] = useState<TakeoverGreeting | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = (s: TakeoverGreeting) => {
    setStatus(s);
    setDraft(s.message);
  };

  useEffect(() => {
    getTakeoverGreeting()
      .then(apply)
      .catch((e) => setError(messageFor(e)));
  }, []);

  const save = async (patch: { enabled?: boolean; message?: string }, done: string) => {
    setBusy(true);
    try {
      apply(await updateTakeoverGreeting(patch));
      toast.success(done);
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setBusy(false);
    }
  };

  const changed = !!status && draft.trim() !== status.message;

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
      <div>
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <UserRound className="w-4 h-4 text-emerald-400" />
          When an agent takes over a chat
        </h3>
        <p className="text-[11px] text-slate-400 mt-1">
          An agent can take a lead&apos;s text chat over from the AI in their Conversations. This text tells the lead a person is
          answering now. It is sent from the agent, on your number, the moment they take over.
        </p>
      </div>

      {error && <div className="text-xs text-rose-300 bg-rose-950/40 border border-rose-800/40 rounded-lg px-3 py-2">{error}</div>}

      {!status ? (
        !error && (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Loading…
          </div>
        )
      ) : (
        <fieldset className="space-y-3 text-xs" disabled={busy}>
          <Switch
            id="takeover-greeting"
            on={status.enabled}
            disabled={busy}
            label="Text the lead a greeting from the agent"
            onChange={(on) => void save({ enabled: on }, on ? 'Leads get a greeting when an agent takes over.' : 'No greeting is sent when an agent takes over.')}
          />
          {status.enabled && (
            <div className="space-y-1">
              <label htmlFor="takeover-message" className="block text-slate-300 font-semibold">
                Message{' '}
                <span className="text-slate-500 font-normal">
                  — {'{{firstName}}'}, {'{{brokerage}}'}, {'{{agentFirstName}}'} and {'{{agentName}}'} are filled in
                </span>
              </label>
              <textarea
                id="takeover-message"
                value={draft}
                onChange={(e) => setDraft(e.target.value.slice(0, MAX_CHARS))}
                rows={3}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-600 disabled:opacity-50"
              />
              <div className="flex justify-end text-[11px] text-slate-500">
                {draft.length}/{MAX_CHARS}
              </div>
              <div className="flex items-center justify-end gap-2 pt-2">
                {status.message !== status.defaultMessage && (
                  <Button variant="outline" size="sm" onClick={() => void save({ message: '' }, 'Default greeting restored.')}>
                    Use default
                  </Button>
                )}
                <Button size="sm" onClick={() => void save({ message: draft }, 'Greeting saved.')} disabled={!changed || !draft.trim()} loading={busy}>
                  Save message
                </Button>
              </div>
            </div>
          )}
        </fieldset>
      )}
    </div>
  );
};
