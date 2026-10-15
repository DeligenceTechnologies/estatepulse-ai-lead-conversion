import React, { useEffect, useState } from 'react';
import { CheckCircle2, History, Loader2, XCircle } from 'lucide-react';
import { sheetRuns, type SheetRun, type SheetSource } from '../../utils/googleSheetsApi';
import { ISSUE_TEXT, skippedLine } from '../../utils/sheetMapping';
import { SheetError, SheetModal, errorText, timeAgo } from './SheetModal';

/** One run's counters as a sentence, leaving out the zeros. */
function countsLine(s: SheetRun['summary']): string {
  const parts: [number | undefined, string][] = [
    [s.inserted, 'imported'],
    [s.updated, 'refreshed'],
    [s.flagged, 'changed after review'],
    [s.flagsCleared, 'changes reverted'],
    [s.missingMarked, 'removed from the sheet'],
    [s.reappeared, 'back in the sheet'],
    [s.dncInherited, 'previously opted out'],
    [s.possibleDuplicates, 'possible duplicates'],
  ];
  return parts
    .filter(([n]) => (n ?? 0) > 0)
    .map(([n, label]) => `${n} ${label}`)
    .join(' · ');
}

/**
 * What each sync did. Runs that changed nothing are not recorded — the audit
 * log is permanent — so a quiet sheet shows its last check time instead.
 * Row-level problems are row numbers and reasons only, never cell values.
 */
export const SheetRunsModal: React.FC<{ source: SheetSource; onClose: () => void }> = ({ source, onClose }) => {
  const [runs, setRuns] = useState<SheetRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    sheetRuns(source.id)
      .then((r) => live && setRuns(r))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [source.id]);

  return (
    <SheetModal
      title={`Sync history — ${source.name}`}
      subtitle={`Last successful check ${timeAgo(source.lastSuccessAt)}`}
      icon={<History className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />}
      onClose={onClose}
    >
      {!runs && !error && (
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
        </div>
      )}
      {error && <SheetError message={error} />}
      {runs && runs.length === 0 && (
        <p className="text-xs text-slate-400">No recorded runs yet. Syncs that change nothing are not recorded.</p>
      )}
      {runs && runs.length > 0 && (
        <div className="space-y-2 max-h-[60vh] overflow-y-auto">
          {runs.map((r, i) => {
            const s = r.summary;
            const skipped = skippedLine(s.skipped);
            return (
              <div key={i} className="rounded-xl border border-slate-800 p-3 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className={`flex items-center gap-1.5 text-xs font-bold ${r.ok ? 'text-emerald-300' : 'text-rose-300'}`}>
                    {r.ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                    {r.ok ? 'Synced' : `Failed: ${s.code ?? 'error'}`}
                  </span>
                  <span className="text-2xs text-slate-500">
                    {new Date(r.at).toLocaleString()}
                    {r.durationMs !== null ? ` · ${(r.durationMs / 1000).toFixed(1)}s` : ''}
                  </span>
                </div>
                {countsLine(s) && <div className="text-xs text-slate-300">{countsLine(s)}</div>}
                {skipped && <div className="text-2xs text-amber-300">Not imported: {skipped}</div>}
                {!r.ok && (
                  <div className="text-2xs text-slate-400">
                    {s.permanent
                      ? 'Paused until you fix this — then switch the sheet back on.'
                      : s.retryAt
                        ? `Will retry automatically around ${new Date(s.retryAt).toLocaleTimeString()}.`
                        : 'Will retry on the next sync.'}
                  </div>
                )}
                {s.errorSample && s.errorSample.length > 0 && (
                  <details className="text-2xs text-slate-400">
                    <summary className="cursor-pointer text-slate-500">Rows not imported</summary>
                    <ul className="mt-1 space-y-0.5">
                      {s.errorSample.map((e) => (
                        <li key={`${e.row}-${e.code}`}>
                          Row {e.row}: {ISSUE_TEXT[e.code] ?? e.code}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}
    </SheetModal>
  );
};
