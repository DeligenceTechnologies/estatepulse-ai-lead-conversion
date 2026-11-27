import React, { useEffect, useState } from 'react';
import { Loader2, Square } from 'lucide-react';
import { messageFor } from '../../lib/api';
import { assistantChatApi, type BulkJobStatus, type BulkProgress } from '../../utils/assistantChatApi';

/** Matches the server: above this many leads, approving needs the count typed. */
export const TYPED_CONFIRM_ABOVE = 10;
const POLL_MS = 2_000;

const ENDED: Record<Exclude<BulkJobStatus, 'queued' | 'running'>, string> = {
  done: 'Finished',
  cancelled: 'Stopped by you',
  stopped: 'Stopped early',
};

const isLive = (s: BulkJobStatus | null) => s === 'queued' || s === 'running';

/**
 * A bulk card after approval: its background job's progress, polled while it runs, with Stop; then
 * the totals and the first leads that were skipped or failed, with why.
 */
export const BulkProgressPanel: React.FC<{ actionId: string; initialStatus: BulkJobStatus | null; total: number }> = ({ actionId, initialStatus, total }) => {
  const [progress, setProgress] = useState<BulkProgress | null>(null);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = progress?.status ?? initialStatus;

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const p = await assistantChatApi.bulkProgress(actionId);
        if (!alive) return;
        setProgress(p);
        if (isLive(p.status)) timer = setTimeout(() => void tick(), POLL_MS);
      } catch (e) {
        if (alive) setError(messageFor(e));
      }
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [actionId]);

  const stop = async (): Promise<void> => {
    setStopping(true);
    try {
      setProgress(await assistantChatApi.stopBulk(actionId));
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setStopping(false);
    }
  };

  return <BulkProgressView progress={progress} status={status} total={total} error={error} stopping={stopping} onStop={() => void stop()} />;
};

/** The panel from progress already loaded. */
export const BulkProgressView: React.FC<{
  progress: BulkProgress | null;
  status: BulkJobStatus | null;
  total: number;
  error?: string | null;
  stopping?: boolean;
  onStop?: () => void;
}> = ({ progress, status, total, error, stopping, onStop }) => {
  const handled = progress ? progress.done + progress.failed + progress.skipped + progress.notAttempted : 0;
  const share = total > 0 ? Math.min(1, handled / total) : 0;
  return (
    <div className="space-y-2 pt-1">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="inline-flex items-center gap-1.5 font-semibold text-slate-200">
          {isLive(status) ? <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-400" aria-hidden /> : null}
          {isLive(status) ? `Working… ${handled} of ${total}` : status ? ENDED[status as keyof typeof ENDED] : 'Starting…'}
        </span>
        {isLive(status) && onStop && (
          <button type="button" onClick={onStop} disabled={stopping} className="cursor-pointer inline-flex items-center gap-1 text-2xs font-bold text-rose-300 hover:text-rose-200 disabled:opacity-50">
            <Square className="w-3 h-3" aria-hidden />
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
        )}
      </div>
      <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden" role="progressbar" aria-valuenow={Math.round(share * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Leads handled">
        <div className="h-full rounded-full bg-emerald-500 transition-[width]" style={{ width: `${share * 100}%` }} />
      </div>
      {progress && (
        <p className="text-2xs text-slate-400">
          {progress.done} done · {progress.skipped} skipped · {progress.failed} failed
          {progress.notAttempted ? ` · ${progress.notAttempted} not attempted` : ''}
        </p>
      )}
      {progress && progress.problems.length > 0 && (
        <ul className="space-y-0.5 text-2xs text-slate-400">
          {progress.problems.map((p) => (
            <li key={p.leadId}>
              <span className="font-semibold text-slate-300">{p.name}</span> {p.status === 'failed' ? 'failed' : 'skipped'}
              {p.reason ? `: ${p.reason}` : ''}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-2xs text-rose-300">{error}</p>}
    </div>
  );
};
