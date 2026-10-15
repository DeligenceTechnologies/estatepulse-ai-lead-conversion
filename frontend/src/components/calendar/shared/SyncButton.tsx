import React, { useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { messageFor } from '../../../lib/api';
import { syncCalendarAvailability } from '../../../utils/calendarApi';

const TICK_MS = 30_000;

/** "just now", "4 min ago", "2 hrs ago", "3 days ago". */
export const syncedAgo = (iso: string, now: number): string => {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
};

/**
 * The one Sync button on each Calendar page: pulls the latest from the
 * provider, then tells the page to reload. Shows when it last synced, and why
 * the last sync failed, right next to it.
 */
export const SyncButton: React.FC<{
  providerLabel: string;
  initialSyncedAt: string | null;
  onSynced: () => void;
}> = ({ providerLabel, initialSyncedAt, onSynced }) => {
  const [syncing, setSyncing] = useState(false);
  const [syncedAt, setSyncedAt] = useState(initialSyncedAt);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => setSyncedAt(initialSyncedAt), [initialSyncedAt]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const sync = async () => {
    if (syncing) return;
    setSyncing(true);
    setError(null);
    try {
      const { sync: state } = await syncCalendarAvailability();
      if (state.syncedAt) setSyncedAt(state.syncedAt);
      if (state.error) setError(state.error);
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setNow(Date.now());
      setSyncing(false);
      // Reload even after a failure: the page then shows what is saved and why.
      onSynced();
    }
  };

  const status = syncing
    ? `Syncing with ${providerLabel}…`
    : syncedAt
      ? `Synced ${syncedAgo(syncedAt, now)}`
      : 'Not synced yet';

  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <span
        className={`hidden sm:inline-flex items-center gap-1.5 text-2xs tabular-nums truncate ${error ? 'text-amber-300' : 'text-slate-500'}`}
        aria-live="polite"
        title={error ?? (syncedAt ? new Date(syncedAt).toLocaleString() : undefined)}
      >
        {error && !syncing && <AlertTriangle className="w-3 h-3 shrink-0" />}
        {error && !syncing ? 'Last sync failed' : status}
      </span>
      <button
        type="button"
        onClick={() => void sync()}
        disabled={syncing}
        aria-busy={syncing || undefined}
        title={error ?? `Pull the latest from ${providerLabel}`}
        className="h-10 px-3.5 rounded-full border border-slate-800 bg-slate-900 text-xs font-semibold text-slate-200 hover:text-white hover:border-slate-700 inline-flex items-center gap-1.5 shrink-0 cursor-pointer transition-colors disabled:opacity-60 disabled:cursor-wait focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50"
      >
        <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
        {syncing ? 'Syncing…' : 'Sync'}
      </button>
    </div>
  );
};
