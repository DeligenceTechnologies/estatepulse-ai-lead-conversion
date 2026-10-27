import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, PhoneCall } from 'lucide-react';
import { toast } from 'react-toastify';
import { messageFor } from '../../lib/api';
import { getCallCapacity, saveCallCapacity, type CallCapacity } from '../../utils/callCapacityApi';

const MAX = 500;

export const CallCapacityCard: React.FC<{ onSaved?: (limit: number) => void }> = ({ onSaved }) => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<CallCapacity | null>(null);
  const [limit, setLimit] = useState(5);

  useEffect(() => {
    getCallCapacity()
      .then((s) => {
        setStatus(s);
        setLimit(s.appLimit);
      })
      .catch((e) => setError(messageFor(e)))
      .finally(() => setLoading(false));
  }, []);

  const valid = Number.isInteger(limit) && limit >= 1 && limit <= MAX;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const s = await saveCallCapacity(limit);
      setStatus(s);
      setLimit(s.appLimit);
      onSaved?.(s.appLimit);
      toast.success('Call limit saved and synced with Telnyx.');
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
          <PhoneCall className="w-4 h-4 text-emerald-400" />
          Call Capacity
        </h3>
        <p className="text-xs text-slate-400 mt-1">
          How many AI calls may run at the same time. Extra calls wait in a queue and dial as soon as a line frees up. The
          same limit is set on your Telnyx account.
        </p>
      </div>

      {error && (
        <div className="text-xs text-rose-300 bg-rose-950/40 border border-rose-800/40 rounded-lg px-3 py-2">{error}</div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Loading call capacity…
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-6 text-xs">
            <div>
              <label className="block text-slate-300 font-semibold mb-1">Max concurrent AI calls</label>
              <input
                type="number"
                min={1}
                max={MAX}
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
                className={inputClass}
              />
            </div>
            {status && (
              <div className="space-y-1 pb-1">
                <p className="text-slate-300">
                  In use now: <span className="font-semibold text-white">{status.inUse}</span> / {status.appLimit}
                </p>
                <SyncBadge status={status} />
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 pt-1 border-t border-slate-800">
            <p className="text-xs text-slate-500 min-w-0">
              {valid
                ? 'Telnyx allows 2 concurrent calls on a free (unverified) account and 10 on a verified account by default. To go higher, ask Telnyx support to raise your account limit first.'
                : `Enter a whole number from 1 to ${MAX}.`}
            </p>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || !valid || !status?.connected}
              className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-on-accent text-xs font-semibold cursor-pointer shrink-0"
            >
              {saving ? 'Saving…' : 'Save limit'}
            </button>
          </div>
        </>
      )}
    </div>
  );
};

const SyncBadge: React.FC<{ status: CallCapacity }> = ({ status }) => {
  if (!status.connected) return <p className="text-slate-500">Connect a Telnyx account to set the limit.</p>;
  if (status.telnyxError) {
    return (
      <p className="flex items-center gap-1 text-amber-300">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
        Could not read Telnyx: {status.telnyxError}
      </p>
    );
  }
  if (status.inSync) {
    return (
      <p className="flex items-center gap-1 text-emerald-400">
        <CheckCircle2 className="w-3.5 h-3.5" />
        Synced with Telnyx{status.profileName ? ` (${status.profileName})` : ''}
      </p>
    );
  }
  return (
    <p className="flex items-center gap-1 text-amber-300">
      <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
      Telnyx {status.telnyxLimit == null ? 'has no limit set' : `shows ${status.telnyxLimit}`}. Save to sync.
    </p>
  );
};
