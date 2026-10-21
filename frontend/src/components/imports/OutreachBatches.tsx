import React, { useCallback, useState } from 'react';
import { CalendarClock, Loader2, PhoneCall, RefreshCw, Rocket } from 'lucide-react';
import { toast } from 'react-toastify';
import { useLiveQuery } from '../../lib/useLiveQuery';
import {
  cancelOutreachBatch,
  listOutreachBatches,
  rescheduleOutreachBatch,
  startLabel,
  wallClockNow,
  type OutreachBatch,
  type OutreachBatchStatus,
} from '../../utils/outreachApi';
import { todayIn } from '../calendar/availability/time';
import { TimezoneSelect } from '../common/TimezoneSelect';
import { errorText } from '../sheets/SheetModal';

const BADGE: Record<OutreachBatchStatus, [string, string]> = {
  pending: ['Scheduled', 'bg-sky-500/15 text-sky-300 border-sky-500/30'],
  running: ['Running', 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'],
  completed: ['Completed', 'bg-slate-700/40 text-slate-300 border-slate-600'],
  cancelled: ['Cancelled', 'bg-rose-500/10 text-rose-300 border-rose-500/30'],
};

const btn = 'px-2.5 py-1 rounded-lg text-2xs font-bold transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default flex items-center gap-1';
const field = 'bg-slate-950 border border-slate-800 rounded-lg px-2 py-1 text-2xs text-white focus:outline-none focus:border-emerald-600';

/** Outreach batches launched from Import Review: when each starts, how far it got, and cancelling or moving one. */
export const OutreachBatches: React.FC<{ refreshKey: number }> = ({ refreshKey }) => {
  const fetcher = useCallback(() => listOutreachBatches(), []);
  const { data, error, refresh, refreshing } = useLiveQuery(fetcher, { baseIntervalMs: 10_000, maxIntervalMs: 60_000, refreshKey });

  if (!data && !error) {
    return (
      <div className="flex items-center gap-2 text-xs text-slate-400 py-6 justify-center">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading…
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-2xs text-slate-500">Counts follow the calls on record. Pending includes leads released and waiting for their first call.</p>
        <button type="button" onClick={refresh} className={`${btn} text-slate-400 hover:text-white`} title="Refresh">
          <RefreshCw className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>
      {error && <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2">{error}</div>}
      {data && data.length === 0 && (
        <div className="text-center py-10 space-y-2">
          <Rocket className="w-7 h-7 text-slate-600 mx-auto" />
          <div className="text-xs text-slate-400">No outreach launched yet. Approve leads on “Waiting for review” to call them now or on a schedule.</div>
        </div>
      )}
      {data?.map((b) => <BatchRow key={b.id} batch={b} onChanged={refresh} />)}
    </div>
  );
};

const BatchRow: React.FC<{ batch: OutreachBatch; onChanged: () => void }> = ({ batch: b, onChanged }) => {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState<null | 'cancel' | 'reschedule'>(null);
  const [editing, setEditing] = useState(false);
  const [date, setDate] = useState(() => todayIn(b.timeZone));
  const [time, setTime] = useState('10:00');
  const [timeZone, setTimeZone] = useState(b.timeZone);

  const [label, cls] = BADGE[b.status];
  const p = b.progress;
  const total = Math.max(1, p.called + p.failed + p.pending + p.skipped + p.cancelled);
  const due = b.status === 'pending' && Date.parse(b.startAt) <= Date.now();
  const past = `${date} ${time}` <= wallClockNow(timeZone);

  const cancel = async () => {
    if (!armed) return setArmed(true);
    setArmed(false);
    setBusy('cancel');
    try {
      const r = await cancelOutreachBatch(b.id);
      toast.success(`Batch cancelled. ${r.notStarted + r.repaused} lead${r.notStarted + r.repaused === 1 ? '' : 's'} will not be called.`);
      onChanged();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const reschedule = async () => {
    setBusy('reschedule');
    try {
      const r = await rescheduleOutreachBatch(b.id, { date, time, timeZone });
      toast.success(`Batch moved to ${startLabel(r.startAt, r.timeZone)}.`);
      setEditing(false);
      onChanged();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const parts = [
    { label: 'called', n: p.called, color: 'bg-emerald-500', hint: 'A call to the lead is on record since its release' },
    { label: 'failed', n: p.failed, color: 'bg-rose-500', hint: 'Every call to the lead failed' },
    { label: 'pending', n: p.pending, color: 'bg-amber-400', hint: 'Waiting for the start time, a free call slot, or its first call' },
    { label: 'skipped', n: p.skipped, color: 'bg-slate-500', hint: 'Opted out, no dialable phone, or already being worked — approved but not contacted' },
    { label: 'cancelled', n: p.cancelled, color: 'bg-slate-600', hint: 'Not called because the batch was cancelled' },
    { label: 'removed', n: p.removed, color: 'bg-slate-700', hint: 'Deleted since the batch launched' },
  ];
  const segment = (n: number, color: string, title: string) =>
    n > 0 ? <div key={title} className={color} style={{ width: `${(n / total) * 100}%` }} title={title} /> : null;

  return (
    <div className="rounded-xl border border-slate-800 p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`text-2xs font-bold uppercase px-2 py-0.5 rounded-full border ${cls}`}>{label}</span>
        <span className="text-xs font-bold text-slate-100 flex items-center gap-1.5">
          {b.mode === 'now' ? <PhoneCall className="w-3.5 h-3.5 text-emerald-400" /> : <CalendarClock className="w-3.5 h-3.5 text-sky-400" />}
          {b.total} lead{b.total === 1 ? '' : 's'}
        </span>
        <span className="text-2xs text-slate-500">
          {b.mode === 'now' ? 'Call now' : 'Scheduled'} ·{' '}
          {b.startedAt ? `started ${startLabel(b.startedAt, b.timeZone)}` : `${b.status === 'pending' ? 'starts' : 'was set for'} ${startLabel(b.startAt, b.timeZone)}`}
          {due && ' · waiting for the contact window or a free call slot'}
        </span>
        <div className="flex-1" />
        {b.status === 'pending' && !editing && (
          <button type="button" onClick={() => setEditing(true)} disabled={busy !== null} className={`${btn} bg-slate-800 text-slate-200 hover:bg-slate-700`}>
            Reschedule
          </button>
        )}
        {(b.status === 'pending' || b.status === 'running') && (
          <button
            type="button"
            onClick={() => void cancel()}
            onBlur={() => setArmed(false)}
            disabled={busy !== null}
            className={`${btn} ${armed ? 'bg-amber-500 text-slate-950' : 'bg-slate-800 text-slate-200 hover:bg-rose-600/30'}`}
          >
            {busy === 'cancel' && <Loader2 className="w-3 h-3 animate-spin" />}
            {armed ? 'Click again to cancel' : 'Cancel'}
          </button>
        )}
      </div>

      {editing && (
        <div className="flex flex-wrap items-center gap-2">
          <input type="date" value={date} min={todayIn(timeZone)} onChange={(e) => setDate(e.target.value)} className={field} aria-label="New date" />
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={field} aria-label="New time" />
          <TimezoneSelect value={timeZone} onChange={setTimeZone} className={`${field} max-w-[14rem]`} />
          <button type="button" onClick={() => void reschedule()} disabled={busy !== null || past} className={`${btn} bg-green-600 text-white hover:bg-green-500`}>
            {busy === 'reschedule' && <Loader2 className="w-3 h-3 animate-spin" />}
            Save
          </button>
          <button type="button" onClick={() => setEditing(false)} disabled={busy !== null} className={`${btn} text-slate-400 hover:text-white`}>
            Keep
          </button>
          {past && <span className="text-2xs text-rose-300">That time has already passed.</span>}
        </div>
      )}

      {/* Where every lead of the batch stands: the segments always add up to the whole bar, and each count below wears its segment's colour. */}
      <div className="flex h-1.5 rounded-full overflow-hidden bg-slate-800" role="img" aria-label={parts.map((x) => `${x.n} ${x.label}`).join(', ')}>
        {parts.map((x) => segment(x.n, x.color, `${x.n} ${x.label}`))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-2xs text-slate-400">
        {parts
          .filter((x) => (x.label !== 'cancelled' && x.label !== 'removed') || x.n > 0)
          .map((x) => (
            <span key={x.label} className="flex items-center gap-1.5" title={x.hint}>
              <span className={`w-2 h-2 rounded-full ${x.color}`} aria-hidden="true" />
              <span className="text-slate-100 font-semibold">{x.n}</span> {x.label}
            </span>
          ))}
      </div>
    </div>
  );
};
