import React from 'react';
import { Flame, Gauge } from 'lucide-react';
import { SOURCE_LABEL, analysisUnavailableOf, qualificationOf } from '../../utils/leadScoringApi';

/**
 * How this call scored the lead: "HOT — 80" and every point behind it.
 *
 * Scoring is automatic when a call ends — the provider's post-call analysis
 * (Telnyx's Insight, Retell's call analysis) feeds the backend's deterministic
 * scorer, and if that result does not arrive the backend scores the transcript
 * itself where it can. Nothing here is manual; a call that is not scored yet
 * shows nothing, and one whose analysis never came says so.
 */

const TEMP_STYLES: Record<string, string> = {
  hot: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
  warm: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  cold: 'bg-sky-500/20 text-sky-300 border-sky-500/40',
};

export const CallQualificationCard: React.FC<{ extractedIntel: unknown }> = ({ extractedIntel }) => {
  const q = qualificationOf(extractedIntel);
  const unavailable = analysisUnavailableOf(extractedIntel);
  if (!q) {
    return unavailable ? (
      <div className="bg-slate-950/80 border border-slate-800 p-4 rounded-xl space-y-1">
        <div className="text-xs font-bold text-emerald-300 uppercase tracking-wider flex items-center gap-1.5">
          <Gauge className="w-3.5 h-3.5 text-emerald-400" />
          Lead qualification
        </div>
        <p className="text-xs text-amber-300">Not scored: {unavailable}.</p>
      </div>
    ) : null;
  }

  return (
    <div className="bg-slate-950/80 border border-slate-800 p-4 rounded-xl space-y-3">
      <div className="text-xs font-bold text-emerald-300 uppercase tracking-wider flex items-center gap-1.5">
        <Gauge className="w-3.5 h-3.5 text-emerald-400" />
        Lead qualification
      </div>

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
          {SOURCE_LABEL[q.source] ?? 'scored from the transcript'}
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
    </div>
  );
};
