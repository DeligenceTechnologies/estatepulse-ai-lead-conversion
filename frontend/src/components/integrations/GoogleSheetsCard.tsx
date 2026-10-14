import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, FileSpreadsheet, Loader2, Plus, RefreshCw, X } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { useLiveEvents } from '../../lib/liveEvents';
import {
  connectGoogle,
  disconnectGoogle,
  getGoogleSheetsConfig,
  isSheetsDisabled,
  listGoogleConnections,
  listSheetSources,
  loadPickerLibraries,
  pauseSheetSource,
  enableSheetSource,
  pickSpreadsheet,
  pickerReady,
  removeSheetSource,
  syncSheetSource,
  type GoogleConnection,
  type GoogleSheetsConfig,
  type SheetSource,
} from '../../utils/googleSheetsApi';
import { SheetMappingModal } from '../sheets/SheetMappingModal';
import { SheetRunsModal } from '../sheets/SheetRunsModal';
import { SheetTabPickerModal } from '../sheets/SheetTabPickerModal';
import { errorText, timeAgo } from '../sheets/SheetModal';
import { IntegrationCard } from './IntegrationCard';

/**
 * Google Sheets — connect a Google account, add spreadsheet tabs, map them, and
 * watch them sync. Imported leads are reviewed on Import Review.
 */

const Fact: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-baseline justify-between gap-3">
    <span className="text-xs text-slate-500 shrink-0">{label}</span>
    <span className="text-xs text-slate-200 truncate">{value}</span>
  </div>
);

/** One honest word for where a sheet stands. */
function statusOf(s: SheetSource): { label: string; cls: string } {
  if (s.syncing || s.syncQueued) return { label: 'syncing', cls: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30' };
  if (s.status === 'NEEDS_MAPPING' || s.mappingStatus === 'NEEDS_REVIEW') {
    return { label: 'needs mapping', cls: 'bg-amber-500/20 text-amber-300 border-amber-500/40' };
  }
  if (s.status === 'PAUSED' && s.lastErrorCode) return { label: 'needs attention', cls: 'bg-rose-500/20 text-rose-300 border-rose-500/40' };
  if (s.status === 'PAUSED') return { label: 'paused', cls: 'bg-slate-800 text-slate-400 border-slate-700' };
  if (s.lastErrorCode) return { label: 'retrying', cls: 'bg-amber-500/20 text-amber-300 border-amber-500/40' };
  return { label: 'active', cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' };
}

const link = 'text-2xs font-bold text-slate-400 hover:text-white transition-colors cursor-pointer disabled:opacity-40';

const SourceRow: React.FC<{
  source: SheetSource;
  onMap: () => void;
  onRuns: () => void;
  onReview: () => void;
  onChanged: () => void;
}> = ({ source, onMap, onRuns, onReview, onChanged }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const st = statusOf(source);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3 space-y-1.5">
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-bold text-slate-100 truncate" title={source.name}>
          {source.name}
        </span>
        <span className={`text-2xs font-bold uppercase px-2 py-0.5 rounded-full border shrink-0 ${st.cls}`}>{st.label}</span>
      </div>
      <div className="text-2xs text-slate-500">
        Last check {timeAgo(source.lastSuccessAt)}
        {source.pendingReview > 0 && (
          <>
            {' · '}
            <button type="button" onClick={onReview} className="text-green-300 hover:text-green-200 font-bold cursor-pointer">
              {source.pendingReview} waiting for review
            </button>
          </>
        )}
      </div>
      {source.lastErrorMessage && (
        <div className="flex items-start gap-1.5 text-2xs text-amber-300">
          <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
          <span>{source.lastErrorMessage}</span>
        </div>
      )}
      {error && <div className="text-2xs text-rose-300">{error}</div>}
      <div className="flex flex-wrap gap-x-3 gap-y-1 pt-0.5">
        <button type="button" className={link} onClick={onMap} disabled={busy}>
          {source.mappingStatus === 'CONFIGURED' ? 'Edit mapping' : 'Map columns'}
        </button>
        {source.status === 'ACTIVE' ? (
          <>
            <button type="button" className={link} disabled={busy} onClick={() => act(() => syncSheetSource(source.id))}>
              Sync now
            </button>
            <button type="button" className={link} disabled={busy} onClick={() => act(() => pauseSheetSource(source.id))}>
              Pause
            </button>
          </>
        ) : (
          source.mappingStatus === 'CONFIGURED' && (
            <button type="button" className={link} disabled={busy} onClick={() => act(() => enableSheetSource(source.id, []))}>
              Switch on
            </button>
          )
        )}
        <button type="button" className={link} onClick={onRuns}>
          History
        </button>
        <button type="button" className={`${link} hover:text-rose-300`} disabled={busy} onClick={() => setConfirmRemove(true)}>
          Remove
        </button>
        {busy && <Loader2 className="w-3 h-3 animate-spin text-slate-500" />}
      </div>
      {confirmRemove && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-2.5 space-y-2 text-2xs text-rose-200">
          <div>
            Remove this sheet? It stops syncing. Its leads are kept
            {source.pendingReview > 0 ? ` — the ${source.pendingReview} waiting for review stay in Import Review` : ''}. Adding the same
            tab again brings it back with its mapping.
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              className="font-bold text-rose-300 hover:text-rose-200 cursor-pointer disabled:opacity-40"
              disabled={busy}
              onClick={() => act(() => removeSheetSource(source.id))}
            >
              Remove sheet
            </button>
            <button type="button" className={link} disabled={busy} onClick={() => setConfirmRemove(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export const GoogleSheetsCard: React.FC = () => {
  const { setActiveView } = useApp();
  const [config, setConfig] = useState<GoogleSheetsConfig | null>(null);
  const [connection, setConnection] = useState<GoogleConnection | null>(null);
  const [sources, setSources] = useState<SheetSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [disabled, setDisabled] = useState(false);
  const [busy, setBusy] = useState<null | 'connect' | 'pick' | 'disconnect'>(null);
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [mapping, setMapping] = useState<string | null>(null);
  const [runsOf, setRunsOf] = useState<SheetSource | null>(null);
  const pending = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    try {
      const [cfg, connections, list] = await Promise.all([getGoogleSheetsConfig(), listGoogleConnections(), listSheetSources()]);
      setConfig(cfg);
      setConnection(connections[0] ?? null);
      setSources(list);
      setError(null);
    } catch (e) {
      if (isSheetsDisabled(e)) setDisabled(true);
      else setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => pending.current?.abort();
  }, [load]);

  // Follow a sync only while one is running; otherwise nothing polls.
  // ponytail: bounded at ~2 minutes; a sync still queued after that (scheduler
  // off, say) shows as "syncing" until the next action or visit refreshes it.
  const syncing = sources.some((s) => s.syncing || s.syncQueued);
  const polls = useRef(0);
  useEffect(() => {
    if (!syncing) {
      polls.current = 0;
      return;
    }
    if (polls.current >= 60) return;
    const t = setTimeout(() => {
      polls.current += 1;
      void load();
    }, 2_000);
    return () => clearTimeout(t);
  }, [syncing, sources, load]);
  const reload = useCallback(() => {
    polls.current = 0;
    void load();
  }, [load]);

  // New leads from a sheet arrive as lead.created on the live stream.
  useLiveEvents(
    useCallback(
      (e) => {
        if (e.type === 'lead.created' && sources.some((s) => s.id === e.leadSourceId)) void load();
      },
      [sources, load],
    ),
  );

  const live = connection?.status === 'ACTIVE';
  const pickerConfigured = Boolean(config?.apiKey && config?.appId);

  // Loaded ahead of the click: Google opens its window only from a direct user gesture.
  useEffect(() => {
    if (live && pickerConfigured) void loadPickerLibraries().catch((e) => setError(errorText(e)));
  }, [live, pickerConfigured]);

  const connect = async () => {
    if (busy === 'connect') {
      pending.current?.abort();
      return;
    }
    setError(null);
    setBusy('connect');
    const ac = new AbortController();
    pending.current = ac;
    try {
      setConnection(await connectGoogle(ac.signal));
    } catch (e) {
      if (!ac.signal.aborted) setError(errorText(e));
    } finally {
      pending.current = null;
      setBusy(null);
    }
  };

  const addSheet = async () => {
    if (!config || !connection) return;
    if (!pickerReady()) {
      setError('Google’s picker is still loading. Try again in a moment.');
      return;
    }
    setError(null);
    setBusy('pick');
    try {
      const id = await pickSpreadsheet(config, connection.accountEmail);
      if (id) setPicked(id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    if (!connection) return;
    if (!armed) {
      setArmed(true);
      return;
    }
    setBusy('disconnect');
    try {
      await disconnectGoogle(connection.id);
      setArmed(false);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const action = !config?.configured
    ? { label: 'Not configured on this server', icon: <X className="w-3.5 h-3.5" />, onClick: () => undefined, className: 'bg-slate-800 text-slate-500 cursor-default' }
    : busy === 'connect'
      ? { label: 'Waiting for Google… (cancel)', icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />, onClick: connect, className: 'bg-slate-800 text-slate-300 hover:bg-slate-700' }
      : !connection || !live
        ? {
            label: connection ? 'Reconnect Google' : 'Connect Google',
            icon: connection ? <RefreshCw className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />,
            onClick: connect,
            className: 'bg-green-600 text-white hover:bg-green-500',
          }
        : {
            label: busy === 'pick' ? 'Choose a spreadsheet in Google…' : 'Add a spreadsheet',
            icon: busy === 'pick' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />,
            onClick: pickerConfigured && busy !== 'pick' ? addSheet : () => undefined,
            className: pickerConfigured ? 'bg-slate-800 text-slate-100 hover:bg-slate-700' : 'bg-slate-800 text-slate-500 cursor-default',
          };

  // Switched off on this server (GOOGLE_SHEETS_ENABLED): no card at all.
  if (disabled) return null;

  return (
    <>
      <IntegrationCard
        icon={
          <div className="w-9 h-9 rounded-xl bg-green-600/20 text-green-400 flex items-center justify-center border border-green-500/30 shrink-0">
            <FileSpreadsheet className="w-5 h-5" />
          </div>
        }
        title="Google Sheets"
        blurb="Import leads from your spreadsheets, reviewed before anyone is contacted"
        connected={live}
        loading={loading}
        accent="border-green-500/40"
        action={action}
      >
        {!loading && !config?.configured && (
          <p className="text-xs text-slate-500">
            The server has no Google OAuth client yet. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable this.
          </p>
        )}

        {connection && (
          <div className="space-y-1.5">
            <Fact label="Account" value={connection.accountEmail ?? 'Unknown account'} />
            {!live && (
              <div className="flex items-start gap-1.5 text-xs text-amber-300">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                Google access was revoked or expired. Reconnect to keep syncing.
              </div>
            )}
            {live && !pickerConfigured && (
              <p className="text-xs text-slate-500">Adding a spreadsheet needs GOOGLE_PICKER_API_KEY and GOOGLE_APP_ID on the server.</p>
            )}
          </div>
        )}

        {!loading && config?.configured && !connection && (
          <p className="text-xs text-slate-500">EstatePulse can only open the spreadsheets you choose.</p>
        )}

        {sources.length > 0 && (
          <div className="space-y-2 pt-1">
            {sources.map((s) => (
              <SourceRow
                key={s.id}
                source={s}
                onMap={() => setMapping(s.id)}
                onRuns={() => setRunsOf(s)}
                onReview={() => setActiveView('import_review')}
                onChanged={reload}
              />
            ))}
          </div>
        )}

        {connection && (
          <button
            type="button"
            onClick={disconnect}
            onBlur={() => setArmed(false)}
            disabled={busy !== null}
            className="text-2xs font-bold text-slate-500 hover:text-rose-300 transition-colors cursor-pointer disabled:opacity-40"
          >
            {busy === 'disconnect' ? 'Disconnecting…' : armed ? 'Click again to disconnect Google — syncing stops' : 'Disconnect Google'}
          </button>
        )}

        {error && (
          <div className="flex items-start gap-1.5 text-xs text-rose-300">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
      </IntegrationCard>

      {picked && connection && (
        <SheetTabPickerModal
          connectionId={connection.id}
          spreadsheetId={picked}
          onClose={() => setPicked(null)}
          onCreated={(s) => {
            setPicked(null);
            void load();
            setMapping(s.id);
          }}
        />
      )}
      {mapping && <SheetMappingModal sourceId={mapping} onClose={() => setMapping(null)} onChanged={reload} />}
      {runsOf && <SheetRunsModal source={runsOf} onClose={() => setRunsOf(null)} />}
    </>
  );
};
