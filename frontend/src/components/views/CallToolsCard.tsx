import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, PhoneForwarded } from 'lucide-react';
import { toast } from 'react-toastify';
import { messageFor } from '../../lib/api';
import { getCallTools, updateCallTools, type CallToolsStatus } from '../../utils/callToolsApi';

/** Matches the server's limit: two SMS segments at most. */
const MAX_CHARS = 320;

/**
 * Callbacks and outcomes: on a call or in a text chat, the AI can book a call
 * back at the exact time the lead asks for, and record a clear "no", "stop
 * contacting me" or wrong number the moment it hears it.
 */
export const CallToolsCard: React.FC = () => {
  const [status, setStatus] = useState<CallToolsStatus | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = (s: CallToolsStatus) => {
    setStatus(s);
    setDraft(s.confirmMessage);
  };

  useEffect(() => {
    getCallTools()
      .then(apply)
      .catch((e) => setError(messageFor(e)));
  }, []);

  const save = async (patch: { enabled?: boolean; confirmSms?: boolean; confirmMessage?: string }, done: string) => {
    setBusy(true);
    try {
      apply(await updateCallTools(patch));
      toast.success(done);
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setBusy(false);
    }
  };

  const changed = !!status && draft.trim() !== status.confirmMessage;
  const editable = !!status?.enabled && status.confirmSms && !busy;

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
      <div>
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <PhoneForwarded className="w-4 h-4 text-emerald-400" />
          Callbacks and outcomes
        </h3>
        <p className="text-[11px] text-slate-400 mt-1">
          When a lead says &ldquo;call me tomorrow at 5&rdquo;, the AI books the callback for that exact time, in your
          calling hours, and nothing else is sent to them before it. A missed callback is tried once more 15 minutes
          later, then the lead goes to your no-answer follow-up. When a lead clearly says they are not interested,
          asks not to be contacted, or it is the wrong number, the AI records it straight away and all outreach to them
          stops; &ldquo;don&apos;t contact me&rdquo; also sets do-not-contact.
        </p>
        <p className="text-[11px] text-slate-500 mt-1">
          This adds two tools and a marked &ldquo;callbacks and outcomes&rdquo; section to the end of your AI prompt.
          Turning it off removes just those; the rest of your prompt is never changed.
        </p>
      </div>

      {error && (
        <div className="text-xs text-rose-300 bg-rose-950/40 border border-rose-800/40 rounded-lg px-3 py-2">{error}</div>
      )}

      {!status ? (
        !error && (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Loading…
          </div>
        )
      ) : (
        <>
          {status.problem ? (
            <p className="text-[11px] text-amber-300 flex items-start gap-1.5 leading-relaxed">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              {status.problem}
            </p>
          ) : (
            status.enabled && (
              <p className={`text-xs flex items-center gap-1.5 ${status.active ? 'text-emerald-300' : 'text-slate-400'}`}>
                <CheckCircle2 className="w-3.5 h-3.5" />
                {status.active ? 'On — the tools are on your assistant.' : 'On — the tools are added on the next call.'}
              </p>
            )
          )}

          <label className="flex items-center gap-2 text-xs text-slate-300 font-semibold cursor-pointer w-fit">
            <input
              type="checkbox"
              checked={status.enabled}
              disabled={busy || (!!status.problem && !status.enabled)}
              onChange={(e) =>
                void save({ enabled: e.target.checked }, e.target.checked ? 'Callbacks and outcomes are on.' : 'Callbacks and outcomes are off.')
              }
              className="accent-emerald-500"
            />
            Let the AI schedule callbacks and record outcomes
          </label>

          <label className="flex items-center gap-2 text-xs text-slate-300 font-semibold cursor-pointer w-fit">
            <input
              type="checkbox"
              checked={status.confirmSms}
              disabled={busy || !status.enabled}
              onChange={(e) =>
                void save({ confirmSms: e.target.checked }, e.target.checked ? 'Callback confirmation SMS is on.' : 'Callback confirmation SMS is off.')
              }
              className="accent-emerald-500"
            />
            Text the lead the callback time after the call
          </label>

          <div className="text-xs space-y-1">
            <label className="block text-slate-300 font-semibold">
              Confirmation text{' '}
              <span className="text-slate-500 font-normal">
                — {'{{firstName}}'} and {'{{callbackTime}}'} are filled in for each lead
              </span>
            </label>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value.slice(0, MAX_CHARS))}
              disabled={!editable}
              rows={2}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-600 disabled:opacity-50"
            />
            <div className="text-right text-[11px] text-slate-500">
              {draft.length}/{MAX_CHARS}
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-1 border-t border-slate-800">
            {status.confirmMessage !== status.defaultConfirmMessage && (
              <button
                type="button"
                onClick={() => void save({ confirmMessage: '' }, 'Default confirmation text restored.')}
                disabled={!editable}
                className="px-4 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:text-white hover:border-slate-600 text-xs font-semibold cursor-pointer disabled:opacity-40"
              >
                Use default
              </button>
            )}
            <button
              type="button"
              onClick={() => void save({ confirmMessage: draft }, 'Confirmation text saved.')}
              disabled={!editable || !changed || !draft.trim()}
              className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-semibold cursor-pointer flex items-center gap-1.5"
            >
              {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Save text
            </button>
          </div>
        </>
      )}
    </div>
  );
};
