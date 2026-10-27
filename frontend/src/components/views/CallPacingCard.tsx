import React, { useEffect, useState } from 'react';
import { Gauge, Loader2 } from 'lucide-react';
import { toast } from 'react-toastify';
import { getOrgSettings, updateOrgSettings } from '../../utils/orgSettingsApi';
import { getOutreachConfig } from '../../utils/outreachApi';

const input = 'bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white w-24 text-center focus:outline-none focus:border-emerald-600';

/**
 * How many of the organization's concurrent calls (set on the Call Capacity
 * card) an outreach batch leaves free for calls outside it. Only with outreach
 * scheduling on (the card hides itself otherwise): nothing else reads this.
 */
export const CallPacingCard: React.FC<{ limit?: number }> = ({ limit: saved }) => {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLimit] = useState(5);
  /** A limit just saved on the Call Capacity card beats the one read on load. */
  const limit = saved ?? loaded;
  const [reserved, setReserved] = useState(1);

  useEffect(() => {
    getOutreachConfig()
      .then(async (config) => {
        if (!config) return;
        setEnabled(true);
        setLimit(config.maxConcurrentCalls);
        setReserved((await getOrgSettings()).reservedCallSlots);
      })
      .catch((e) => setError(e?.message || 'Could not load your call pacing.'))
      .finally(() => setLoading(false));
  }, []);

  if (!enabled && !error) return null;

  const invalid = !Number.isInteger(reserved) || reserved < 0 || reserved >= limit;

  const save = async () => {
    setSaving(true);
    try {
      setReserved((await updateOrgSettings({ reservedCallSlots: reserved })).reservedCallSlots);
      toast.success('Call pacing saved.');
    } catch (e: any) {
      toast.error(e?.message || 'Could not save your call pacing.');
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
          A batch you launch from Import Review is released a few leads at a time, within your concurrent call limit (Call Capacity, above).
          New form leads and follow-ups are never held back; the slots kept free are room for them.
        </p>
      </div>
      {error && <div className="text-xs text-rose-300 bg-rose-950/40 border border-rose-800/40 rounded-lg px-3 py-2">{error}</div>}
      {loading ? (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Loading your call pacing…
        </div>
      ) : (
        enabled && (
          <>
            <label className="space-y-1 text-xs block">
              <span className="block text-slate-300 font-semibold">Call slots kept free</span>
              <input type="number" min={0} max={Math.max(0, limit - 1)} value={reserved} onChange={(e) => setReserved(Number(e.target.value))} className={input} />
            </label>
            {invalid ? (
              <p className="text-2xs text-rose-300">Keep fewer slots free than your concurrent call limit ({limit}).</p>
            ) : (
              <p className="text-2xs text-slate-500">
                Of your {limit} concurrent call{limit === 1 ? '' : 's'}, a batch may use {limit - reserved} at a time.
              </p>
            )}
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || invalid}
              className="px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-600 text-white hover:bg-emerald-500 cursor-pointer disabled:opacity-40 disabled:cursor-default flex items-center gap-1.5"
            >
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Save call pacing
            </button>
          </>
        )
      )}
    </div>
  );
};
