import React, { useEffect, useState } from 'react';
import { CheckCircle2, History, Loader2, MinusCircle, XCircle } from 'lucide-react';
import { crmRuns, type CrmCounts, type CrmProvider, type CrmRun } from '../../utils/crmApi';
import { SheetError, SheetModal, errorText } from '../sheets/SheetModal';

/** One run's counters as a sentence, leaving out the zeros. */
export function crmCountsLine(c: CrmCounts): string {
  const parts: [number, string][] = [
    [c.fetched, 'read'],
    [c.created, 'new'],
    [c.linked, 'matched to existing leads'],
    [c.updated, 'updated'],
    [c.conflicts, 'held for your review'],
    [c.duplicates, 'possible duplicates'],
    [c.missing, 'no longer in the CRM'],
    [c.skipped, 'skipped (no phone or email)'],
    [c.failed, 'failed'],
  ];
  return parts
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n.toLocaleString()} ${label}`)
    .join(' · ');
}

const STATUS: Record<CrmRun['status'], { label: string; cls: string; icon: React.ReactNode }> = {
  succeeded: { label: 'Completed', cls: 'text-emerald-300', icon: <CheckCircle2 className="w-3.5 h-3.5" /> },
  failed: { label: 'Failed', cls: 'text-rose-300', icon: <XCircle className="w-3.5 h-3.5" /> },
  cancelled: { label: 'Cancelled', cls: 'text-slate-400', icon: <MinusCircle className="w-3.5 h-3.5" /> },
  running: { label: 'Running', cls: 'text-cyan-300', icon: <Loader2 className="w-3.5 h-3.5 animate-spin" /> },
  queued: { label: 'Queued', cls: 'text-cyan-300', icon: <Loader2 className="w-3.5 h-3.5 animate-spin" /> },
};

/** Every full read of the CRM: what it found and did. Never a record's values. */
export const CrmRunsModal: React.FC<{ provider: CrmProvider; displayName: string; onClose: () => void }> = ({ provider, displayName, onClose }) => {
  const [runs, setRuns] = useState<CrmRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    crmRuns(provider)
      .then((r) => live && setRuns(r))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [provider]);

  return (
    <SheetModal
      title={`Sync history — ${displayName}`}
      subtitle="Each complete read of your contacts. Day-to-day changes arrive through webhooks in between."
      icon={<History className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />}
      onClose={onClose}
    >
      {!runs && !error && (
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
        </div>
      )}
      {error && <SheetError message={error} />}
      {runs && runs.length === 0 && <p className="text-xs text-slate-400">No imports yet.</p>}
      {runs && runs.length > 0 && (
        <div className="space-y-2 max-h-[60vh] overflow-y-auto">
          {runs.map((r) => {
            const st = STATUS[r.status];
            const ended = r.finishedAt && r.startedAt ? (new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 1000 : null;
            return (
              <div key={r.id} className="rounded-xl border border-slate-800 p-3 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className={`flex items-center gap-1.5 text-xs font-bold ${st.cls}`}>
                    {st.icon}
                    {r.kind === 'initial' ? 'First import' : 'Full sync'} · {st.label}
                  </span>
                  <span className="text-2xs text-slate-500">
                    {new Date(r.startedAt ?? r.createdAt).toLocaleString()}
                    {ended !== null ? ` · ${ended < 60 ? `${ended.toFixed(0)}s` : `${(ended / 60).toFixed(1)} min`}` : ''}
                  </span>
                </div>
                {crmCountsLine(r.counts) && <div className="text-xs text-slate-300">{crmCountsLine(r.counts)}</div>}
                {r.error && (
                  <div className={`text-2xs ${r.status === 'failed' ? 'text-rose-300' : 'text-amber-300'}`}>
                    {r.error.message ?? r.error.code}
                    {r.nextAttemptAt && ` Retrying around ${new Date(r.nextAttemptAt).toLocaleTimeString()}.`}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </SheetModal>
  );
};
