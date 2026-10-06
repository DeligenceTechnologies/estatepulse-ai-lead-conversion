import React, { useEffect, useState } from 'react';
import { Flame, Loader2 } from 'lucide-react';
import { messageFor } from '../../lib/api';
import { getThresholds, saveThresholds } from '../../utils/leadScoringApi';

/**
 * Where the office draws the line between hot, warm and cold.
 *
 * After every AI call the backend scores the lead 0–100 from what the caller
 * said (timeline, budget, location, pre-approval, appointment, engagement).
 * These two numbers turn that score into a temperature. Stored on the
 * organization; the defaults are 75 and 45.
 */
export const LeadTemperatureCard: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [hot, setHot] = useState(75);
  const [warm, setWarm] = useState(45);

  useEffect(() => {
    getThresholds()
      .then((t) => {
        setHot(t.hotThreshold);
        setWarm(t.warmThreshold);
      })
      .catch((e) => setError(messageFor(e)))
      .finally(() => setLoading(false));
  }, []);

  const whole = (n: number) => Number.isInteger(n);
  const valid = whole(hot) && whole(warm) && warm >= 1 && hot <= 100 && warm < hot;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const t = await saveThresholds({ hotThreshold: hot, warmThreshold: warm });
      setHot(t.hotThreshold);
      setWarm(t.warmThreshold);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError(messageFor(e));
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
          Lead Temperature Thresholds
        </h3>
        <p className="text-[11px] text-slate-400 mt-1">
          After each AI call the lead is scored 0–100 from what the caller said. Hot leads wait for an agent; warm and
          cold leads go to nurture. A caller who asks for a person is always hot.
        </p>
      </div>

      {error && (
        <div className="text-xs text-rose-300 bg-rose-950/40 border border-rose-800/40 rounded-lg px-3 py-2">{error}</div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Loading thresholds…
        </div>
      ) : (
        <>
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
            <p className="text-[11px] text-slate-500 min-w-0 truncate">
              {valid ? `${hot}–100 hot • ${warm}–${hot - 1} warm • 0–${warm - 1} cold` : 'Warm must be lower than hot, both whole numbers 1–100.'}
            </p>
            <div className="flex items-center gap-2 shrink-0">
              {saved && <span className="text-[11px] text-emerald-400 font-semibold">Saved</span>}
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving || !valid}
                className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-semibold cursor-pointer"
              >
                {saving ? 'Saving…' : 'Save thresholds'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
