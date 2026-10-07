import React, { useState } from 'react';
import { Flame, Gauge, Loader2 } from 'lucide-react';
import { messageFor } from '../../lib/api';
import { classifyCall, qualificationOf } from '../../utils/leadScoringApi';

/**
 * How this call scored the lead: "HOT — 80" and every point behind it.
 *
 * Scoring is automatic when a call ends (Telnyx's post-call Insight feeds the
 * backend's deterministic scorer). A call recorded before that existed has a
 * transcript but no score, so an owner can classify it on demand.
 */

const TEMP_STYLES: Record<string, string> = {
  hot: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
  warm: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  cold: 'bg-sky-500/20 text-sky-300 border-sky-500/40',
};

interface Props {
  callId: string;
  extractedIntel: unknown;
  hasTranscript: boolean;
  isOwner: boolean;
  onClassified: () => void;
}

export const CallQualificationCard: React.FC<Props> = ({ callId, extractedIntel, hasTranscript, isOwner, onClassified }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = qualificationOf(extractedIntel);

  // Nothing to show and nothing anyone here can do about it.
  if (!q && !(hasTranscript && isOwner)) return null;

  const classify = async () => {
    setBusy(true);
    setError(null);
    try {
      await classifyCall(callId);
      onClassified();
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-slate-950/80 border border-slate-800 p-4 rounded-xl space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs font-bold text-emerald-300 uppercase tracking-wider flex items-center gap-1.5">
          <Gauge className="w-3.5 h-3.5 text-emerald-400" />
          Lead qualification
        </div>
        {isOwner && hasTranscript && (
          <button
            onClick={() => void classify()}
            disabled={busy}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium border border-slate-700 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-wait"
          >
            {busy && <Loader2 className="w-3 h-3 animate-spin" />}
            {busy ? 'Classifying…' : q ? 'Re-classify from transcript' : 'Classify from transcript'}
          </button>
        )}
      </div>

      {error && <p className="text-xs text-rose-300">{error}</p>}

      {q ? (
        <>
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1 text-xs font-bold font-mono px-2 py-0.5 rounded border ${
                TEMP_STYLES[q.temperature] ?? 'bg-slate-800 text-slate-300 border-slate-700'
              }`}
            >
              {q.temperature === 'hot' && <Flame className="w-3.5 h-3.5 text-rose-400" />}
              {q.temperature.toUpperCase()} — {q.score}
            </span>
            <span className="text-xs text-slate-500">
              Hot from {q.thresholds.hot}, warm from {q.thresholds.warm} •{' '}
              {q.source === 'telnyx_insights' ? 'scored when the call ended' : 'classified from the transcript'}
            </span>
          </div>

          {q.override && <p className="text-xs text-amber-300">{q.override}</p>}

          {q.reasons.length > 0 ? (
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {q.reasons.map((r) => (
                <li
                  key={r.label}
                  className="bg-slate-900 border border-slate-800/80 px-2 py-1.5 rounded-lg flex items-center justify-between text-xs"
                >
                  <span className="text-slate-300 truncate pr-2">{r.label}</span>
                  <span className={`font-bold font-mono shrink-0 ${r.points < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                    {r.points > 0 ? '+' : ''}
                    {r.points}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-slate-500">The caller gave none of the qualifying details.</p>
          )}
        </>
      ) : (
        <p className="text-xs text-slate-500">
          Not scored yet. Calls are scored automatically when they end; this one was recorded before that was set up.
        </p>
      )}
    </div>
  );
};
