import React, { useEffect, useState } from 'react';
import { Info, Loader2, Voicemail } from 'lucide-react';
import { toast } from 'react-toastify';
import { messageFor } from '../../lib/api';
import { getVoicemail, updateVoicemail, type VoicemailStatus } from '../../utils/voicemailApi';

/** Matches the server's limit: about 30 seconds spoken. */
const MAX_CHARS = 500;

const Switch: React.FC<{ id: string; on: boolean; disabled?: boolean; onChange: (on: boolean) => void; label: string }> = ({ id, on, disabled, onChange, label }) => (
  <button
    id={id}
    type="button"
    role="switch"
    aria-checked={on}
    disabled={disabled}
    onClick={() => onChange(!on)}
    className="flex items-center gap-2 text-xs text-slate-200 font-semibold cursor-pointer disabled:cursor-wait disabled:opacity-60 w-fit"
  >
    <span className={`w-9 h-5 rounded-full transition-colors relative shrink-0 ${on ? 'bg-emerald-600' : 'bg-slate-700'}`}>
      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-on-accent transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
    </span>
    {label}
  </button>
);

/**
 * The one place an organization decides how AI calls treat answering
 * machines: whether to detect them at all (a per-call charge on its Telnyx
 * account), and when one answers, whether to leave a message or hang up.
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

  const save = async (patch: { detect?: boolean; enabled?: boolean; message?: string }, done: string) => {
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
  const price = status ? `$${status.detectionPricePerCall}` : '';

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
      <div>
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <Voicemail className="w-4 h-4 text-emerald-400" />
          Voicemail and answering machines
        </h3>
        <p className="text-[11px] text-slate-400 mt-1">
          Decide whether AI calls check for an answering machine, and what happens when one picks up. Each call step in
          your strategy and follow-ups can still choose to leave the message or hang up.
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
          <div className="space-y-2">
            <Switch
              id="voicemail-detect"
              on={status.detect}
              disabled={busy}
              label="Detect answering machines"
              onChange={(on) =>
                void save({ detect: on }, on ? 'Answering-machine detection is on.' : 'Answering-machine detection is off. No detection charge from now on.')
              }
            />
            {status.detect ? (
              <p className="text-[11px] text-amber-200/90 bg-amber-950/30 border border-amber-800/40 rounded-lg px-3 py-2 flex items-start gap-2">
                <Info className="w-3.5 h-3.5 mt-px shrink-0 text-amber-300" />
                <span>
                  Every AI call checks whether a person or a machine picked up, and the AI only ever talks to a person.
                  Telnyx charges <strong className="font-semibold">{price} per call</strong> for this on your Telnyx account
                  (their pay-as-you-go list price), on top of the call&apos;s per-minute rate. Turn it off to stop the charge.
                </span>
              </p>
            ) : (
              <p className="text-[11px] text-slate-300 bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 flex items-start gap-2">
                <Info className="w-3.5 h-3.5 mt-px shrink-0 text-slate-400" />
                <span>
                  Off: no detection charge. The AI starts talking as soon as a call connects, so it may speak to a voicemail
                  greeting. The call analysis still marks such a call as not answered, so the next step of your strategy runs as
                  usual. A voicemail message can only be left with detection on.
                </span>
              </p>
            )}
          </div>

          {status.detect && (
            <fieldset className="space-y-3 text-xs" disabled={busy}>
              <legend className="text-slate-300 font-semibold mb-2">When a machine answers</legend>
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                  <input
                    id="voicemail-leave"
                    type="radio"
                    name="voicemail-action"
                    checked={status.enabled}
                    onChange={() => void save({ enabled: true }, 'The AI will leave the message after the beep.')}
                    className="accent-emerald-500"
                  />
                  Leave this message after the beep
                </label>
                <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                  <input
                    id="voicemail-hangup"
                    type="radio"
                    name="voicemail-action"
                    checked={!status.enabled}
                    onChange={() => void save({ enabled: false }, 'The AI will hang up without a message.')}
                    className="accent-emerald-500"
                  />
                  Hang up without a message
                </label>
              </div>

              {status.enabled && (
                <div className="space-y-1">
                  <label htmlFor="voicemail-message" className="block text-slate-300 font-semibold">
                    Message <span className="text-slate-500 font-normal">— {'{{firstName}}'} and {'{{brokerage}}'} are filled in for each lead</span>
                  </label>
                  <textarea
                    id="voicemail-message"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value.slice(0, MAX_CHARS))}
                    rows={3}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-600 disabled:opacity-50"
                  />
                  <div className="flex justify-between text-[11px] text-slate-500">
                    <span>Keep it under about 30 seconds. Don&apos;t promise a callback the strategy won&apos;t make.</span>
                    <span>
                      {draft.length}/{MAX_CHARS}
                    </span>
                  </div>
                  <div className="flex items-center justify-end gap-2 pt-2">
                    {status.message !== status.defaultMessage && (
                      <button
                        type="button"
                        onClick={() => void save({ message: '' }, 'Default voicemail message restored.')}
                        className="px-4 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:text-white hover:border-slate-600 text-xs font-semibold cursor-pointer disabled:opacity-40"
                      >
                        Use default
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void save({ message: draft }, 'Voicemail message saved.')}
                      disabled={!changed || !draft.trim()}
                      className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-semibold cursor-pointer flex items-center gap-1.5"
                    >
                      {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                      Save message
                    </button>
                  </div>
                </div>
              )}
            </fieldset>
          )}
        </>
      )}
    </div>
  );
};
