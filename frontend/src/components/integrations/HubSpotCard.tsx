import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Contact, Loader2, Plus, RefreshCw, X } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { useLiveEvents } from '../../lib/liveEvents';
import { connectCrm, disconnectCrm, getCrmStatus, isCrmDisabled, startCrmSync, type CrmStatus } from '../../utils/crmApi';
import { errorText, timeAgo } from '../sheets/SheetModal';
import { CrmRunsModal, crmCountsLine } from './CrmRunsModal';
import { IntegrationCard } from './IntegrationCard';

/**
 * HubSpot — connect the office's HubSpot account and import its contacts as
 * leads. New leads wait in Import Review; nobody is called or texted until the
 * owner approves them. After the first import, HubSpot's webhooks keep leads in
 * step, with a periodic check for anything a webhook missed.
 */

const PROVIDER = 'hubspot' as const;
const NAME = 'HubSpot';

const Fact: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="flex items-baseline justify-between gap-3">
    <span className="text-xs text-slate-500 shrink-0">{label}</span>
    <span className="text-xs text-slate-200 truncate text-right">{value}</span>
  </div>
);

const link = 'text-2xs font-bold text-slate-400 hover:text-white transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default';

export const HubSpotCard: React.FC = () => {
  const { setActiveView } = useApp();
  const [status, setStatus] = useState<CrmStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [disabled, setDisabled] = useState(false);
  const [busy, setBusy] = useState<null | 'connect' | 'sync' | 'disconnect'>(null);
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [history, setHistory] = useState(false);
  const pending = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await getCrmStatus(PROVIDER));
      setError(null);
    } catch (e) {
      if (isCrmDisabled(e)) setDisabled(true);
      else setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => pending.current?.abort();
  }, [load]);

  // Follow an import only while one is running; otherwise nothing polls.
  // ponytail: bounded at ~30 minutes of polling; a larger import keeps running
  // on the server and shows its result on the next visit.
  const running = Boolean(status?.activeRun);
  const polls = useRef(0);
  useEffect(() => {
    if (!running) {
      polls.current = 0;
      return;
    }
    if (polls.current >= 600) return;
    const t = setTimeout(() => {
      polls.current += 1;
      void load();
    }, 3_000);
    return () => clearTimeout(t);
  }, [running, status, load]);

  // New leads from a webhook arrive as lead.created on the live stream.
  useLiveEvents(
    useCallback(
      (e) => {
        if (e.type === 'lead.created' && status?.sourceId && e.leadSourceId === status.sourceId) void load();
      },
      [status?.sourceId, load],
    ),
  );

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
      setStatus(await connectCrm(PROVIDER, NAME, ac.signal));
    } catch (e) {
      if (!ac.signal.aborted) setError(errorText(e));
    } finally {
      pending.current = null;
      setBusy(null);
    }
  };

  const sync = async () => {
    setError(null);
    setBusy('sync');
    try {
      await startCrmSync(PROVIDER);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    setBusy('disconnect');
    try {
      await disconnectCrm(PROVIDER);
      setArmed(false);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  // Switched off on this server (HUBSPOT_ENABLED): no card at all.
  if (disabled) return null;

  const s = status?.status ?? 'not_connected';
  const live = s === 'connected' || s === 'error';
  const run = status?.activeRun ?? null;
  const last = status?.lastRun ?? null;

  const action = !status?.configured
    ? { label: 'Not configured on this server', icon: <X className="w-3.5 h-3.5" />, onClick: () => undefined, className: 'bg-slate-800 text-slate-500 cursor-default' }
    : busy === 'connect'
      ? { label: `Waiting for ${NAME}… (cancel)`, icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />, onClick: connect, className: 'bg-slate-800 text-slate-300 hover:bg-slate-700' }
      : !live
        ? {
            label: s === 'reauthorization_required' ? `Reconnect ${NAME}` : `Connect ${NAME}`,
            icon: s === 'reauthorization_required' ? <RefreshCw className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />,
            onClick: connect,
            className: 'bg-orange-600 text-white hover:bg-orange-500',
          }
        : run || busy === 'sync'
          ? { label: run?.status === 'queued' ? 'Import queued…' : 'Importing…', icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />, onClick: () => undefined, className: 'bg-slate-800 text-slate-400 cursor-default' }
          : { label: 'Sync now', icon: <RefreshCw className="w-3.5 h-3.5" />, onClick: sync, className: 'bg-slate-800 text-slate-100 hover:bg-slate-700' };

  return (
    <>
      <IntegrationCard
        icon={
          <div className="w-9 h-9 rounded-xl bg-orange-500/20 text-orange-400 flex items-center justify-center border border-orange-500/30 shrink-0">
            <Contact className="w-5 h-5" />
          </div>
        }
        title={NAME}
        blurb="Import your CRM contacts, reviewed before anyone is contacted"
        connected={live}
        loading={loading}
        accent="border-orange-500/40"
        action={action}
      >
        {!loading && !status?.configured && (
          <p className="text-xs text-slate-500">
            The server has no HubSpot app yet. Set HUBSPOT_CLIENT_ID and HUBSPOT_CLIENT_SECRET to enable this.
          </p>
        )}

        {!loading && status?.configured && s === 'not_connected' && (
          <p className="text-xs text-slate-500">
            Connecting imports your HubSpot contacts as leads. They wait in Import Review — nobody is contacted until you approve them.
          </p>
        )}

        {status?.account && (
          <div className="space-y-1.5">
            <Fact label="Account" value={status.account.name ?? status.account.id ?? 'Unknown account'} />
            {status.account.connectedBy && <Fact label="Connected by" value={status.account.connectedBy} />}
            {live && <Fact label="Last sync" value={timeAgo(status.lastSuccessfulSyncAt)} />}
            <Fact label="Leads from HubSpot" value={status.importedLeads.toLocaleString()} />
          </div>
        )}

        {s === 'reauthorization_required' && (
          <div className="flex items-start gap-1.5 text-xs text-amber-300">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            HubSpot access was revoked or has expired. Reconnect to keep syncing — leads already imported stay as they are.
          </div>
        )}
        {s === 'disconnected' && (
          <p className="text-xs text-slate-500">
            Disconnected. The {status?.importedLeads.toLocaleString()} lead{status?.importedLeads === 1 ? '' : 's'} imported from HubSpot were kept;
            reconnecting the same account carries on without duplicating them.
          </p>
        )}

        {run && (
          <div className="rounded-xl border border-cyan-500/30 bg-cyan-500/5 p-3 space-y-1">
            <div className="flex items-center gap-1.5 text-xs font-bold text-cyan-300">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              {run.kind === 'initial' ? 'Importing your contacts' : 'Syncing all contacts'}
              {run.status === 'queued' ? ' — starting…' : ''}
            </div>
            <div className="text-2xs text-slate-300">{crmCountsLine(run.counts) || 'Reading the first page…'}</div>
            {run.error && (
              <div className="text-2xs text-amber-300">
                {run.error.message ?? run.error.code}
                {run.nextAttemptAt && ` Continuing around ${new Date(run.nextAttemptAt).toLocaleTimeString()}.`}
              </div>
            )}
          </div>
        )}

        {!run && last && live && (
          <div className="text-2xs text-slate-500">
            Last full sync {last.status === 'succeeded' ? 'completed' : last.status} {timeAgo(last.finishedAt)}
            {crmCountsLine(last.counts) ? ` — ${crmCountsLine(last.counts)}` : ''}
          </div>
        )}

        {live && status?.lastError && !run && (
          <div className="flex items-start gap-1.5 text-2xs text-amber-300">
            <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
            <span>{status.lastError.message ?? status.lastError.code}</span>
          </div>
        )}

        {status && (status.pendingReview > 0 || status.changesToReview > 0) && (
          <button type="button" onClick={() => setActiveView('import_review')} className="text-2xs font-bold text-orange-300 hover:text-orange-200 cursor-pointer text-left">
            {status.pendingReview > 0 && `${status.pendingReview.toLocaleString()} waiting for review`}
            {status.pendingReview > 0 && status.changesToReview > 0 && ' · '}
            {status.changesToReview > 0 && `${status.changesToReview.toLocaleString()} change${status.changesToReview === 1 ? '' : 's'} to review`}
          </button>
        )}

        {(live || s === 'reauthorization_required') && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 pt-0.5">
            <button type="button" className={link} onClick={() => setHistory(true)}>
              History
            </button>
            <button
              type="button"
              onClick={disconnect}
              onBlur={() => setArmed(false)}
              disabled={busy !== null}
              className={`${link} hover:text-rose-300`}
            >
              {busy === 'disconnect' ? 'Disconnecting…' : armed ? 'Click again to disconnect — syncing stops, leads are kept' : `Disconnect ${NAME}`}
            </button>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-1.5 text-xs text-rose-300">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
      </IntegrationCard>

      {history && <CrmRunsModal provider={PROVIDER} displayName={NAME} onClose={() => setHistory(false)} />}
    </>
  );
};
