import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, Copy, ExternalLink, Loader2, Play, Zap } from 'lucide-react';
import { toast } from 'react-toastify';
import {
  activateFormSource,
  formScript,
  testFormSource,
  type FormSource,
  type FormTest,
} from '../../utils/googleFormsApi';
import { SheetError, SheetModal, errorText, timeAgo } from '../sheets/SheetModal';

/**
 * Getting the owner's form to send us its responses.
 *
 * Google Forms has no webhook field, so the owner pastes a short script into
 * their form once. That is the entire difference from Tally or Typeform, and
 * the four steps below are written for someone who has never opened Apps
 * Script — which is most owners.
 *
 * The script carries this form's own delivery key, so the dialog says so
 * plainly rather than hoping nobody pastes it somewhere public.
 */

const Step: React.FC<{ n: number; title: string; children?: React.ReactNode }> = ({ n, title, children }) => (
  <div className="flex gap-3">
    <span className="shrink-0 w-5 h-5 rounded-full bg-slate-800 text-slate-300 text-2xs font-bold flex items-center justify-center mt-0.5">
      {n}
    </span>
    <div className="min-w-0 flex-1 space-y-1.5">
      <div className="text-xs font-semibold text-slate-100">{title}</div>
      {children}
    </div>
  </div>
);

export const FormSetupModal: React.FC<{
  source: FormSource;
  onClose: () => void;
  onChanged: () => void;
}> = ({ source, onClose, onChanged }) => {
  const [script, setScript] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<null | 'copy' | 'test' | 'activate'>(null);
  const [result, setResult] = useState<FormTest | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setScript((await formScript(source.id)).script);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [source.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const copy = async () => {
    if (!script) return;
    setBusy('copy');
    try {
      await navigator.clipboard.writeText(script);
      toast.success('Script copied. Paste it into Apps Script on your form.');
    } catch {
      toast.error('Could not copy. Select the script below and copy it by hand.');
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy('test');
    try {
      setResult(await testFormSource(source.id));
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const activate = async () => {
    setBusy('activate');
    try {
      const updated = await activateFormSource(source.id);
      toast.success(
        updated.released > 0
          ? `Form switched on. ${updated.released} response(s) received during setup are waiting for your review.`
          : 'Form switched on. New responses will create leads.',
      );
      onChanged();
      onClose();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const mapped = source.mappingStatus === 'CONFIGURED';

  return (
    <SheetModal
      wide
      title={`Set up ${source.name}`}
      subtitle="One script, pasted into your form once. After that every response arrives here automatically."
      icon={<Zap className="w-4 h-4 text-green-400 mt-0.5 shrink-0" />}
      onClose={onClose}
    >
      {loading ? (
        <div className="flex items-center gap-2 text-xs text-slate-400 py-6 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Preparing your script…
        </div>
      ) : error ? (
        <SheetError message={error} />
      ) : (
        <div className="space-y-4">
          <div className="space-y-3">
            <Step n={1} title="Copy the script">
              <button
                type="button"
                onClick={copy}
                disabled={busy === 'copy'}
                className="px-3 py-1.5 rounded-lg text-xs font-bold bg-green-600 hover:bg-green-500 text-white flex items-center gap-1.5 cursor-pointer disabled:opacity-40"
              >
                <Copy className="w-3.5 h-3.5" /> Copy script
              </button>
              <p className="text-2xs text-amber-300/90 flex items-start gap-1.5">
                <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                It contains this form’s private delivery key. Keep it in your form only — don’t post it anywhere shared.
              </p>
            </Step>

            <Step n={2} title="Open Apps Script on your form">
              <p className="text-2xs text-slate-400 leading-relaxed">
                In your form choose the three dots menu (⋮) → <strong className="text-slate-200">Apps Script</strong>. Delete whatever is
                in the editor, paste the script, and save.
              </p>
              {source.formUrl && (
                <a
                  href={source.formUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-2xs font-bold text-green-300 hover:text-green-200 inline-flex items-center gap-1 cursor-pointer"
                >
                  Open the form <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </Step>

            <Step n={3} title="Run “estatePulseSetup” once">
              <p className="text-2xs text-slate-400 leading-relaxed">
                In the Apps Script toolbar pick <strong className="text-slate-200">estatePulseSetup</strong> and press Run. This is what
                starts the sending.
              </p>
              {/* Every owner meets this screen, and its only visible button is the wrong one. */}
              <p className="mt-2 px-2.5 py-2 rounded-lg bg-amber-500/10 border border-amber-500/25 text-2xs text-amber-200/90 leading-relaxed">
                Google will warn you that it <strong>“hasn’t verified this app”</strong>. That is expected — the script is your own, in
                your own account. Click <strong className="text-amber-100">Advanced</strong>, then{' '}
                <strong className="text-amber-100">Go to … (unsafe)</strong>, then <strong className="text-amber-100">Allow</strong>. The
                Allow button stays hidden until you click Advanced.
              </p>
            </Step>

            <Step n={4} title="Send one test response">
              <p className="text-2xs text-slate-400 leading-relaxed">
                Fill in your own form once, then check below. Responses that arrive before you switch the form on are kept and wait for
                your review — nothing is contacted.
              </p>
              <button
                type="button"
                onClick={test}
                disabled={busy === 'test'}
                className="px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-800 hover:bg-slate-700 text-slate-100 flex items-center gap-1.5 cursor-pointer disabled:opacity-40"
              >
                {busy === 'test' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                Test connection
              </button>
            </Step>
          </div>

          {result && (
            <div
              className={`rounded-xl border px-3 py-2.5 space-y-1 text-2xs ${
                result.scriptInstalled && result.formReadable
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                  : 'border-amber-500/40 bg-amber-500/10 text-amber-200'
              }`}
            >
              <div className="flex items-center gap-1.5 font-bold">
                {result.scriptInstalled && result.formReadable ? <Check className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
                {result.scriptInstalled
                  ? `We have received ${result.pushDeliveries} response(s) from the script — it is working.`
                  : result.recoveredDeliveries > 0
                    ? `${result.recoveredDeliveries} response(s) arrived, but only through the backup check — not the script.`
                    : 'Nothing has arrived from your form yet.'}
              </div>
              {!result.formReadable && (
                <div>
                  We can no longer read this form with your Google account{result.googleError ? `: ${result.googleError}` : '.'}
                </div>
              )}
              {result.scriptInstalled && <div>Last response {timeAgo(result.lastDeliveryAt)}.</div>}
              {!result.scriptInstalled && result.recoveredDeliveries > 0 && (
                <div>
                  Your responses still reach EstatePulse, but up to 15 minutes late instead of instantly. Re-copy the script in step 2 —
                  the address it sends to has usually changed — then run <strong>estatePulseSetup</strong> again. Apps Script →
                  Executions shows what each attempt reported.
                </div>
              )}
              {!result.scriptInstalled && result.recoveredDeliveries === 0 && (
                <div>
                  Finish steps 1–3, then submit a response in your form. If you already have, open Apps Script → Executions to see what
                  it reported.
                </div>
              )}
              {result.lastErrorMessage && <div>Last problem: {result.lastErrorMessage}</div>}
            </div>
          )}

          <details className="rounded-xl border border-slate-800 bg-slate-950/60">
            <summary className="px-3 py-2 text-2xs font-bold text-slate-400 cursor-pointer hover:text-slate-200">
              Show the script
            </summary>
            <pre className="px-3 pb-3 pt-1 text-2xs text-slate-400 overflow-x-auto max-h-60 whitespace-pre">{script}</pre>
          </details>

          <div className="flex items-center justify-between gap-3 pt-1 border-t border-slate-800">
            <span className="text-2xs text-slate-500">
              {mapped ? 'Questions are mapped.' : 'Map the questions before switching this form on.'}
            </span>
            <button
              type="button"
              onClick={activate}
              disabled={busy === 'activate' || !mapped || source.live}
              className="px-3 py-1.5 rounded-lg text-xs font-bold bg-green-600 hover:bg-green-500 text-white flex items-center gap-1.5 cursor-pointer disabled:opacity-40"
            >
              {busy === 'activate' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              {source.live ? 'Already on' : 'Switch this form on'}
            </button>
          </div>
        </div>
      )}
    </SheetModal>
  );
};
