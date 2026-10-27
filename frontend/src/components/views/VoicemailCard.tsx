import React, { useEffect, useState } from 'react';
import { Loader2, Voicemail } from 'lucide-react';
import { toast } from 'react-toastify';
import { messageFor } from '../../lib/api';
import { getVoicemail, updateVoicemail, type VoicemailStatus } from '../../utils/voicemailApi';

/** Matches the server's limit: about 30 seconds spoken. */
const MAX_CHARS = 500;

/**
 * Voicemail: answering-machine detection tells a person from a machine on
 * every AI call. The assistant only ever talks to a person; a machine gets
 * this message after its beep (or nothing, when off), and the call counts as
 * not answered, so the strategy's next step runs as usual.
 */
export const VoicemailCard: React.FC = () => {
  const [status, setStatus] = useState<VoicemailStatus | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = (s: VoicemailStatus) => {
    setStatus(s);
    setDraft(s.message);
  };

  useEffect(() => {
    getVoicemail()
      .then(apply)
      .catch((e) => setError(messageFor(e)));
  }, []);

  const save = async (patch: { enabled?: boolean; message?: string }, done: string) => {
    setBusy(true);
    try {
      apply(await updateVoicemail(patch));
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
          <Voicemail className="w-4 h-4 text-emerald-400" />
          Voicemail
        </h3>
        <p className="text-[11px] text-slate-400 mt-1">
          Every AI call checks whether a person or an answering machine picked up. The AI only ever talks to a person.
          When a machine answers, this message is left after the beep in the assistant&apos;s voice, and the call counts
          as not answered, so the next step of your strategy runs as usual.
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
          <label className="flex items-center gap-2 text-xs text-slate-300 font-semibold cursor-pointer w-fit">
            <input
              type="checkbox"
              checked={status.enabled}
              disabled={busy}
              onChange={(e) =>
                void save({ enabled: e.target.checked }, e.target.checked ? 'Voicemail message is on.' : 'Voicemail message is off.')
              }
              className="accent-emerald-500"
            />
            Leave a message on voicemail
          </label>

          <div className="text-xs space-y-1">
            <label className="block text-slate-300 font-semibold">
              Message <span className="text-slate-500 font-normal">— {'{{firstName}}'} and {'{{brokerage}}'} are filled in for each lead</span>
            </label>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value.slice(0, MAX_CHARS))}
              disabled={!status.enabled || busy}
              rows={3}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-600 disabled:opacity-50"
            />
            <div className="flex justify-between text-[11px] text-slate-500">
              <span>Keep it under about 30 seconds. Don&apos;t promise a callback the strategy won&apos;t make.</span>
              <span>
                {draft.length}/{MAX_CHARS}
              </span>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-1 border-t border-slate-800">
            {status.message !== status.defaultMessage && (
              <button
                type="button"
                onClick={() => void save({ message: '' }, 'Default voicemail message restored.')}
                disabled={busy || !status.enabled}
                className="px-4 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:text-white hover:border-slate-600 text-xs font-semibold cursor-pointer disabled:opacity-40"
              >
                Use default
              </button>
            )}
            <button
              type="button"
              onClick={() => void save({ message: draft }, 'Voicemail message saved.')}
              disabled={busy || !changed || !status.enabled || !draft.trim()}
              className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-semibold cursor-pointer flex items-center gap-1.5"
            >
              {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Save message
            </button>
          </div>
        </>
      )}
    </div>
  );
};
