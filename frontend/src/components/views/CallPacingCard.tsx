import React, { useEffect, useState } from 'react';
import { Gauge, Loader2 } from 'lucide-react';
import { toast } from 'react-toastify';
import { getOrgSettings, updateOrgSettings } from '../../utils/orgSettingsApi';
import { getOutreachConfig } from '../../utils/outreachApi';

const input = 'bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white w-24 text-center focus:outline-none focus:border-emerald-600';

/**
 * How many AI calls an outreach batch may keep live at once, and how many of
 * those stay free for calls outside a batch. Only with outreach scheduling on
 * (the card hides itself otherwise): nothing else reads these limits.
 */
export const CallPacingCard: React.FC = () => {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [max, setMax] = useState(5);
  const [reserved, setReserved] = useState(1);

  useEffect(() => {
    getOutreachConfig()
      .then(async (config) => {
        if (!config) return;
        setEnabled(true);
        const s = await getOrgSettings();
        setMax(s.maxConcurrentAiCalls);
        setReserved(s.reservedCallSlots);
      })
      .catch((e) => setError(e?.message || 'Could not load your call limits.'))
      .finally(() => setLoading(false));
  }, []);

  if (!enabled && !error) return null;

  const invalid = !Number.isInteger(max) || max < 1 || max > 50 || !Number.isInteger(reserved) || reserved < 0 || reserved >= max;

  const save = async () => {
    setSaving(true);
    try {
      const s = await updateOrgSettings({ maxConcurrentAiCalls: max, reservedCallSlots: reserved });
      setMax(s.maxConcurrentAiCalls);
      setReserved(s.reservedCallSlots);
      toast.success('Call limits saved.');
    } catch (e: any) {
      toast.error(e?.message || 'Could not save your call limits.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
      <div>
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <Gauge className="w-4 h-4 text-emerald-400" />
          Call Pacing for Launched Imports
        </h3>
        <p className="text-xs text-slate-400 mt-1">
          A batch you launch from Import Review is released a few leads at a time, so your AI agent never runs more calls at once than this.
          New form leads and follow-ups are never held back; the reserved slots keep room for them.
        </p>
      </div>
      {error && <div className="text-xs text-rose-300 bg-rose-950/40 border border-rose-800/40 rounded-lg px-3 py-2">{error}</div>}
      {loading ? (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Loading your call limits…
        </div>
      ) : (
        enabled && (
          <>
            <div className="flex flex-wrap gap-6 text-xs">
              <label className="space-y-1">
                <span className="block text-slate-300 font-semibold">Max AI calls at once</span>
                <input type="number" min={1} max={50} value={max} onChange={(e) => setMax(Number(e.target.value))} className={input} />
              </label>
              <label className="space-y-1">
                <span className="block text-slate-300 font-semibold">Kept free</span>
                <input type="number" min={0} max={49} value={reserved} onChange={(e) => setReserved(Number(e.target.value))} className={input} />
              </label>
            </div>
            {invalid && <p className="text-2xs text-rose-300">Use 1–50 calls at once, and keep fewer slots free than that.</p>}
            <p className="text-2xs text-slate-500">
              A batch may use {invalid ? '—' : max - reserved} call slot{max - reserved === 1 ? '' : 's'} at a time.
            </p>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || invalid}
              className="px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-600 text-white hover:bg-emerald-500 cursor-pointer disabled:opacity-40 disabled:cursor-default flex items-center gap-1.5"
            >
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Save call limits
            </button>
          </>
        )
      )}
    </div>
  );
};
