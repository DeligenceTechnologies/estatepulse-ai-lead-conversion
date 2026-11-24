import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Contact, KeyRound, Loader2, Plus, RefreshCw } from 'lucide-react';
import { toast } from 'react-toastify';
import { useApp } from '../../context/AppContext';
import { useLiveEvents } from '../../lib/liveEvents';
import { connectCrmWithToken, disconnectCrm, getCrmStatus, isCrmDisabled, startCrmSync, type CrmStatus } from '../../utils/crmApi';
import { errorText, timeAgo } from '../sheets/SheetModal';
import { CredentialField } from '../leadsources/CredentialField';
import { CrmRunsModal, crmCountsLine } from './CrmRunsModal';
import { IntegrationCard } from './IntegrationCard';
import { Button, buttonClass } from '../common/Button';

/**
 * BoldTrail (kvCORE): connect the office's BoldTrail account with an API token
 * and import its contacts as leads, exactly as HubSpot's are. A clean contact
 * goes straight to Leads (and outreach); an incomplete one, a possible
 * duplicate or an opt-out waits in Import Review. Archived contacts are never
 * imported.
 *
 * BoldTrail sends no webhooks, so new and changed contacts arrive on the
 * periodic check rather than instantly. Its tokens last a year; the card warns
 * a month ahead and takes a replacement in place, without re-importing.
 */

const PROVIDER = 'boldtrail' as const;
const NAME = 'BoldTrail';
/** Warn this long before the token stops working. */
const EXPIRY_WARNING_MS = 30 * 24 * 60 * 60 * 1000;

const Fact: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="flex items-baseline justify-between gap-3">
    <span className="text-xs text-slate-500 shrink-0">{label}</span>
    <span className="text-xs text-slate-200 truncate text-right">{value}</span>
  </div>
);

const link = buttonClass({ variant: 'ghost', size: 'sm' });

export const BoldTrailCard: React.FC = () => {
  const { setActiveView } = useApp();
  const [status, setStatus] = useState<CrmStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [disabled, setDisabled] = useState(false);
  const [busy, setBusy] = useState<null | 'connect' | 'sync' | 'disconnect'>(null);
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [history, setHistory] = useState(false);
  /** The token form is open: first connect, an expired token, or a replacement. */
  const [entering, setEntering] = useState(false);
  const [token, setToken] = useState('');

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
  }, [load]);

  // Follow an import only while one is running; otherwise nothing polls.
  // ponytail: bounded at ~30 minutes of polling, as for HubSpot.
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

  // New leads from the periodic check arrive as lead.created on the live stream.
  useLiveEvents(
    useCallback(
      (e) => {
        if (e.type === 'lead.created' && status?.sourceId && e.leadSourceId === status.sourceId) void load();
      },
      [status?.sourceId, load],
    ),
  );

  const submitToken = async () => {
    if (!token || busy) return;
    setBusy('connect');
    try {
      const wasLive = status?.status === 'connected' || status?.status === 'error';
      setStatus(await connectCrmWithToken(PROVIDER, token));
      setToken('');
      setEntering(false);
      toast.success(wasLive ? `${NAME} token replaced.` : `${NAME} connected. Importing your contacts…`);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const sync = async () => {
    setBusy('sync');
    try {
      const { alreadyActive } = await startCrmSync(PROVIDER);
      await load();
      toast.success(alreadyActive ? 'A sync is already running.' : 'Sync started.');
    } catch (e) {
      toast.error(errorText(e));
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
      toast.success(`${NAME} disconnected. Imported leads were kept.`);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  // Switched off on this server (BOLDTRAIL_ENABLED): no card at all.
  if (disabled) return null;

  const s = status?.status ?? 'not_connected';
  const live = s === 'connected' || s === 'error';
  const run = status?.activeRun ?? null;
  const last = status?.lastRun ?? null;
  const expiresAt = status?.tokenExpiresAt ? new Date(status.tokenExpiresAt) : null;
  const expiringSoon = live && expiresAt !== null && expiresAt.getTime() - Date.now() < EXPIRY_WARNING_MS;

  const action =
    busy === 'connect'
      ? { label: 'Checking the token…', icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />, onClick: () => undefined, variant: 'secondary' as const, disabled: true }
      : !live
        ? {
            label: s === 'reauthorization_required' ? 'Paste a new token' : `Connect ${NAME}`,
            icon: s === 'reauthorization_required' ? <KeyRound className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />,
            onClick: () => setEntering(true),
            variant: 'primary' as const,
            disabled: entering,
          }
        : run || busy === 'sync'
          ? { label: run?.status === 'queued' ? 'Import queued…' : 'Importing…', icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />, onClick: () => undefined, variant: 'secondary' as const, disabled: true }
          : { label: 'Sync now', icon: <RefreshCw className="w-3.5 h-3.5" />, onClick: sync, variant: 'secondary' as const };

  return (
    <>
      <IntegrationCard
        icon={
          <div className="w-9 h-9 rounded-xl bg-indigo-500/20 text-indigo-400 flex items-center justify-center border border-indigo-500/30 shrink-0">
            <Contact className="w-5 h-5" />
          </div>
        }
        title={NAME}
        blurb="Bring in your BoldTrail (kvCORE) contacts"
        connected={live}
        loading={loading}
        accent="border-indigo-500/40"
        action={action}
      >
        {!loading && s === 'not_connected' && !entering && (
          <p className="text-xs text-slate-500">
            Complete contacts go straight to Leads. Incomplete or duplicate ones wait in Import Review for you. Archived contacts are skipped.
          </p>
        )}

        {entering && (
          <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/40 p-3">
            <ol className="text-2xs text-slate-400 list-decimal pl-4 space-y-0.5">
              <li>In BoldTrail, open Lead Engine, then Lead Dropbox.</li>
              <li>Under My API Tokens, choose Contacts (or All) and click Generate.</li>
              <li>Copy the token and paste it here.</li>
            </ol>
            <CredentialField
              label={`${NAME} API token`}
              value={token}
              onChange={setToken}
              onSubmit={submitToken}
              disabled={busy === 'connect'}
              placeholder="eyJ0eXAiOiJKV1Qi…"
            />
            <div className="flex items-center gap-2">
              <Button variant="primary" size="sm" onClick={submitToken} disabled={!token || busy === 'connect'}>
                {busy === 'connect' ? 'Checking…' : live ? 'Replace token' : 'Connect'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEntering(false);
                  setToken('');
                }}
                disabled={busy === 'connect'}
              >
                Cancel
              </Button>
            </div>
            <p className="text-2xs text-slate-500">
              The token is checked with BoldTrail, stored encrypted, and never shown again. New contacts are picked up on a regular check, not instantly.
            </p>
          </div>
        )}

        {status?.account && (
          <div className="space-y-1.5">
            <Fact label="Account" value={status.account.name ?? 'BoldTrail account'} />
            {status.account.authorizedBy && <Fact label="Token owner" value={status.account.authorizedBy} />}
            {status.account.connectedBy && <Fact label="Connected by" value={status.account.connectedBy} />}
            {live && <Fact label="Last sync" value={timeAgo(status.lastSuccessfulSyncAt)} />}
            {live && expiresAt && <Fact label="Token expires" value={expiresAt.toLocaleDateString()} />}
            <Fact label="Leads from BoldTrail" value={status.importedLeads.toLocaleString()} />
          </div>
        )}

        {expiringSoon && !entering && (
          <div className="flex items-start gap-1.5 text-xs text-amber-300">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            The BoldTrail token expires {expiresAt!.getTime() <= Date.now() ? 'now' : `on ${expiresAt!.toLocaleDateString()}`}. Generate a new one and replace it to keep syncing.
          </div>
        )}
        {s === 'reauthorization_required' && !entering && (
          <div className="flex items-start gap-1.5 text-xs text-amber-300">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            BoldTrail no longer accepts the API token (it expired or was deleted). Paste a new one to keep syncing. Imported leads are kept.
          </div>
        )}
        {s === 'disconnected' && !entering && (
          <p className="text-xs text-slate-500">
            Disconnected. {status?.importedLeads.toLocaleString()} imported lead{status?.importedLeads === 1 ? ' was' : 's were'} kept.
            Reconnecting the same account won't create duplicates.
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
          <Button variant="link" onClick={() => setActiveView('import_review')} className="whitespace-normal! text-left">
            {status.pendingReview > 0 && `${status.pendingReview.toLocaleString()} waiting for review`}
            {status.pendingReview > 0 && status.changesToReview > 0 && ' · '}
            {status.changesToReview > 0 && `${status.changesToReview.toLocaleString()} change${status.changesToReview === 1 ? '' : 's'} to review`}
          </Button>
        )}

        {(live || s === 'reauthorization_required') && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 pt-0.5">
            <button type="button" className={link} onClick={() => setHistory(true)}>
              History
            </button>
            {live && !entering && (
              <button type="button" className={link} onClick={() => setEntering(true)}>
                Replace API token
              </button>
            )}
            <Button
              variant={armed ? 'danger-soft' : 'ghost'}
              size="sm"
              onClick={disconnect}
              onBlur={() => setArmed(false)}
              disabled={busy !== null}
              className={armed ? '' : 'hover:text-rose-300!'}
            >
              {busy === 'disconnect' ? 'Disconnecting…' : armed ? 'Click again to disconnect (leads are kept)' : `Disconnect ${NAME}`}
            </Button>
          </div>
        )}
        {armed && (
          <p className="text-2xs text-slate-500">To stop the token working everywhere, also delete it in BoldTrail under My API Tokens.</p>
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
