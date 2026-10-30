import React, { useEffect, useState } from 'react';
import { Flame, Loader2 } from 'lucide-react';
import { toast } from 'react-toastify';
import { messageFor } from '../../lib/api';
import { POINT_FIELDS, getScoringSettings, saveScoringSettings, type Points } from '../../utils/leadScoringApi';

/**
 * How the office scores a lead: what each thing the caller says is worth, and
 * where hot and warm begin.
 *
 * After every AI call the assistant scores the lead 0–100 by these points
 * (using its judgement on partial or mixed answers) and rates it by these two
 * lines, all of which it is told. Stored on the organization; the defaults
 * are the built-in chart, 75 and 45.
 */
export const LeadTemperatureCard: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hot, setHot] = useState(75);
  const [warm, setWarm] = useState(45);
  const [points, setPoints] = useState<Points | null>(null);

  useEffect(() => {
    getScoringSettings()
      .then((s) => {
        setHot(s.hotThreshold);
        setWarm(s.warmThreshold);
        setPoints(s.points);
      })
      .catch((e) => setError(messageFor(e)))
      .finally(() => setLoading(false));
  }, []);

  const whole = (n: number) => Number.isInteger(n);
  const thresholdsValid = whole(hot) && whole(warm) && warm >= 1 && hot <= 100 && warm < hot;
  const pointsValid = !!points && POINT_FIELDS.every(({ key }) => whole(points[key]) && points[key] >= -100 && points[key] <= 100);
  const valid = thresholdsValid && pointsValid;

  const save = async () => {
    if (!points) return;
    setSaving(true);
    setError(null);
    try {
      const s = await saveScoringSettings({ hotThreshold: hot, warmThreshold: warm, points });
      setHot(s.hotThreshold);
      setWarm(s.warmThreshold);
      setPoints(s.points);
      toast.success('Lead scoring saved.');
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    'w-24 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-600';

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
                Points <span className="text-slate-500 font-normal">— for what the caller says, −100 to 100</span>
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 text-xs">
                {POINT_FIELDS.map(({ key, label }) => (
                  <label
                    key={key}
                    className="flex items-center justify-between gap-3 bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2"
                  >
                    <span className="text-slate-300">{label}</span>
                    <input
                      type="number"
                      min={-100}
                      max={100}
                      value={points[key]}
                      onChange={(e) => setPoints({ ...points, [key]: Number(e.target.value) })}
                      className="w-20 bg-slate-950 border border-slate-800 rounded-lg px-2 py-1 text-white text-right focus:outline-none focus:border-emerald-600"
                    />
                  </label>
                ))}
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
                  ? `${hot}–100 hot • ${warm}–${hot - 1} warm • 0–${warm - 1} cold`
                  : !thresholdsValid
                    ? 'Warm must be lower than hot, both whole numbers 1–100.'
                    : 'Every points value must be a whole number from −100 to 100.'}
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
