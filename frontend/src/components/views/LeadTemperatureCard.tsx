import React, { useEffect, useState } from 'react';
import { Flame, Loader2, Plus, RotateCcw, X } from 'lucide-react';
import { toast } from 'react-toastify';
import { messageFor } from '../../lib/api';
import {
  MAX_CRITERIA,
  MAX_CRITERION_LABEL,
  getScoringSettings,
  saveScoringSettings,
  type Criterion,
} from '../../utils/leadScoringApi';

/**
 * How the office scores a lead: its points chart (what each thing the caller
 * says is worth, lines of its own included) and where hot and warm begin.
 *
 * After every AI call the assistant scores the lead 0–100 by this chart
 * (using its judgement on partial or mixed answers) and rates it by the two
 * lines, all of which it is told. Stored on the organization; the defaults
 * are the built-in chart, 75 and 45.
 */
export const LeadTemperatureCard: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hot, setHot] = useState(75);
  const [warm, setWarm] = useState(45);
  const [points, setPoints] = useState<Criterion[] | null>(null);
  const [defaults, setDefaults] = useState<Criterion[]>([]);

  useEffect(() => {
    getScoringSettings()
      .then((s) => {
        setHot(s.hotThreshold);
        setWarm(s.warmThreshold);
        setPoints(s.points);
        setDefaults(s.defaultPoints);
      })
      .catch((e) => setError(messageFor(e)))
      .finally(() => setLoading(false));
  }, []);

  const whole = (n: number) => Number.isInteger(n);
  const thresholdsValid = whole(hot) && whole(warm) && warm >= 1 && hot <= 100 && warm < hot;
  const lineValid = (c: Criterion) =>
    c.label.trim().length > 0 && c.label.length <= MAX_CRITERION_LABEL && whole(c.points) && c.points >= -100 && c.points <= 100;
  const pointsValid = !!points && points.length >= 1 && points.length <= MAX_CRITERIA && points.every(lineValid);
  const valid = thresholdsValid && pointsValid;
  const positive = (points ?? []).reduce((sum, c) => sum + Math.max(0, c.points), 0);

  const update = (i: number, change: Partial<Criterion>) =>
    setPoints((list) => list && list.map((c, j) => (j === i ? { ...c, ...change } : c)));
  const remove = (i: number) => setPoints((list) => list && list.filter((_, j) => j !== i));
  const add = () => setPoints((list) => [...(list ?? []), { label: '', points: 10 }]);

  const save = async () => {
    if (!points) return;
    setSaving(true);
    setError(null);
    try {
      const s = await saveScoringSettings({ hotThreshold: hot, warmThreshold: warm, points });
      setHot(s.hotThreshold);
      setWarm(s.warmThreshold);
      setPoints(s.points);
      if (s.warning) toast.warn(s.warning);
      else toast.success('Lead scoring saved.');
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    'w-24 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-600';
  const linkClass = 'flex items-center gap-1 text-xs disabled:opacity-40 cursor-pointer';

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
      <div>
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <Flame className="w-4 h-4 text-rose-400" />
          Lead Scoring
        </h3>
        <p className="text-xs text-slate-400 mt-1">
          After each AI call the assistant scores the lead 0–100 by these points, using its judgement on partial
          answers, and rates it by the lines below. Hot leads wait for an agent; warm and cold leads go to nurture. A
          caller who asks for a person is always hot.
        </p>
      </div>

      {error && (
        <div className="text-xs text-rose-300 bg-rose-950/40 border border-rose-800/40 rounded-lg px-3 py-2">{error}</div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Loading lead scoring…
        </div>
      ) : (
        points && (
          <>
            <div>
              <h4 className="text-xs font-semibold text-slate-300 mb-2">
                Points{' '}
                <span className="text-slate-500 font-normal">
                  — what the caller says and what it is worth, −100 to 100. Add lines of your own; the assistant weighs
                  them like the built-in ones.
                </span>
              </h4>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-2 text-xs">
                {points.map((c, i) => (
                  <div key={i} className="flex items-center gap-2 bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2">
                    <input
                      type="text"
                      maxLength={MAX_CRITERION_LABEL}
                      value={c.label}
                      placeholder="What the caller says, e.g. Has a home to sell"
                      onChange={(e) => update(i, { label: e.target.value })}
                      className="flex-1 min-w-0 bg-transparent text-slate-200 placeholder:text-slate-600 focus:outline-none"
                    />
                    <input
                      type="number"
                      min={-100}
                      max={100}
                      value={c.points}
                      onChange={(e) => update(i, { points: Number(e.target.value) })}
                      className="w-20 bg-slate-950 border border-slate-800 rounded-lg px-2 py-1 text-white text-right focus:outline-none focus:border-emerald-600"
                    />
                    <button
                      type="button"
                      onClick={() => remove(i)}
                      aria-label={`Remove ${c.label || 'this line'}`}
                      className="text-slate-500 hover:text-rose-400 cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-4 mt-2">
                <button
                  type="button"
                  onClick={add}
                  disabled={points.length >= MAX_CRITERIA}
                  className={`${linkClass} text-emerald-400 hover:text-emerald-300`}
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add criterion
                </button>
                <button type="button" onClick={() => setPoints(defaults)} className={`${linkClass} text-slate-400 hover:text-white`}>
                  <RotateCcw className="w-3.5 h-3.5" />
                  Reset to defaults
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
              <div>
                <label className="block text-slate-300 font-semibold mb-1">
                  Hot from <span className="text-slate-500 font-normal">— score at or above</span>
                </label>
                <input type="number" min={2} max={100} value={hot} onChange={(e) => setHot(Number(e.target.value))} className={inputClass} />
              </div>
              <div>
                <label className="block text-slate-300 font-semibold mb-1">
                  Warm from <span className="text-slate-500 font-normal">— below that is cold</span>
                </label>
                <input type="number" min={1} max={99} value={warm} onChange={(e) => setWarm(Number(e.target.value))} className={inputClass} />
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 pt-1 border-t border-slate-800">
              <p className="text-xs text-slate-500 min-w-0 truncate">
                {valid
                  ? `${hot}–100 hot • ${warm}–${hot - 1} warm • 0–${warm - 1} cold • positive points add up to ${positive}`
                  : !thresholdsValid
                    ? 'Warm must be lower than hot, both whole numbers 1–100.'
                    : `Every line needs a label of up to ${MAX_CRITERION_LABEL} characters and whole-number points from −100 to 100, up to ${MAX_CRITERIA} lines.`}
              </p>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={saving || !valid}
                  className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-on-accent text-xs font-semibold cursor-pointer"
                >
                  {saving ? 'Saving…' : 'Save scoring'}
                </button>
              </div>
            </div>
          </>
        )
      )}
    </div>
  );
};
