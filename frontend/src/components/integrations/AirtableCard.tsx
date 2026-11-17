import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Plus, RefreshCw, Settings2, Table2, X } from 'lucide-react';
import { toast } from 'react-toastify';
import {
  connectAirtable,
  DIRECTION_LABELS,
  disconnectAirtable,
  getAirtableConfig,
  isAirtableDisabled,
  listAirtableConnections,
  listAirtableSources,
  PERMISSION_LABELS,
  removeAirtableSource,
  type AirtableConfig,
  type AirtableConnection,
  type AirtablePermissions,
  type AirtableSource,
} from '../../utils/airtableApi';
import { errorText, timeAgo } from '../sheets/SheetModal';
import { AirtableSetupModal } from './AirtableSetupModal';
import { AirtableSyncPanel } from './AirtableSyncPanel';
import { IntegrationCard } from './IntegrationCard';

/**
 * Airtable — connect the office's Airtable account. Bases and tables are chosen
 * afterwards, one lead source each: connecting on its own imports nothing.
 *
 * Each table says on its own row which way it syncs and offers its settings by
 * name. Before that the table's label was itself the way in, so nothing on the
 * card admitted that a table had settings at all — two-way sync among them.
 */

const NAME = 'Airtable';

/**
 * Airtable's permissions are separate grants, so a connection can be allowed to
 * write records and still not be allowed to create columns.
 *
 * Only what is MISSING is spelled out. Listing all five every time filled the
 * card with green ticks saying nothing had gone wrong, and pushed the tables —
 * the part an owner came to the card for — below the fold.
 */
const Permissions: React.FC<{ permissions: AirtablePermissions }> = ({ permissions }) => {
  const missing = PERMISSION_LABELS.filter(({ key }) => !permissions[key]);
  if (!missing.length) return <p className="text-2xs text-slate-500">All Airtable permissions granted.</p>;
  return (
    <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-2.5 space-y-1">
      {missing.map(({ key, label, why }) => (
        <div key={key} className="flex items-start gap-1.5">
          <X className="w-3 h-3 text-amber-400 mt-0.5 shrink-0" />
          <span className="text-2xs text-amber-200 leading-relaxed">
            <span className="font-bold">{label}</span> &mdash; not granted, so EstatePulse cannot{' '}
            {why.charAt(0).toLowerCase() + why.slice(1)}
          </span>
        </div>
      ))}
      <p className="text-2xs text-amber-300/70 pt-0.5">Reconnect this account to approve them.</p>
    </div>
  );
};

const link = 'text-2xs font-bold text-slate-400 hover:text-white transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default';

export const AirtableCard: React.FC = () => {
  const [config, setConfig] = useState<AirtableConfig | null>(null);
  const [connections, setConnections] = useState<AirtableConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [disabled, setDisabled] = useState(false);
  const [busy, setBusy] = useState<null | 'connect' | 'disconnect'>(null);
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [sources, setSources] = useState<AirtableSource[]>([]);
  const [setup, setSetup] = useState<string | null>(null);
  const [panel, setPanel] = useState<string | null>(null);
  // A table the owner is about to stop syncing. Armed first, like disconnecting
  // the account below and like the Google Sheets card does with a sheet.
  const [armedTable, setArmedTable] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    try {
      const [cfg, conns] = await Promise.all([getAirtableConfig(), listAirtableConnections()]);
      setConfig(cfg);
      setConnections(conns);
      // Only meaningful once something is connected; a 404 here is the feature being off.
      setSources(conns.length ? await listAirtableSources() : []);
      setError(null);
    } catch (e) {
      if (isAirtableDisabled(e)) setDisabled(true);
      else setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => pending.current?.abort();
  }, [load]);

  const connect = async () => {
    if (busy === 'connect') {
      pending.current?.abort();
      return;
    }
    setBusy('connect');
    const ac = new AbortController();
    pending.current = ac;
    try {
      await connectAirtable(ac.signal);
      await load();
      toast.success(`${NAME} connected. Pick a base and table to start importing.`);
    } catch (e) {
      if (!ac.signal.aborted) toast.error(errorText(e));
    } finally {
      pending.current = null;
      setBusy(null);
    }
  };

  const stopSyncing = async (sourceId: string) => {
    if (armedTable !== sourceId) {
      setArmedTable(sourceId);
      return;
    }
    setBusy('disconnect');
    try {
      const { pendingReview } = await removeAirtableSource(sourceId);
      setArmedTable(null);
      await load();
      toast.success(
        pendingReview > 0
          ? `Stopped syncing that table. ${pendingReview} lead${pendingReview === 1 ? '' : 's'} still waiting in Import Review were kept.`
          : 'Stopped syncing that table. Imported leads were kept.',
      );
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (id: string) => {
    if (armed !== id) {
      setArmed(id);
      return;
    }
    setBusy('disconnect');
    try {
      await disconnectAirtable(id);
      setArmed(null);
      await load();
      toast.success(`${NAME} disconnected. Imported leads were kept.`);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  // Switched off on this server (AIRTABLE_ENABLED): no card at all.
  if (disabled) return null;

  // A connection Airtable has stopped honouring: the owner must reconnect.
  const live = connections.filter((c) => c.status === 'active');
  const broken = connections.filter((c) => c.status === 'invalid');
  const connected = live.length > 0;

  const action = !config?.configured
    ? {
        label: 'Not configured on this server',
        icon: <X className="w-3.5 h-3.5" />,
        onClick: () => undefined,
        className: 'bg-slate-800 text-slate-500 cursor-default',
      }
    : busy === 'connect'
      ? {
          label: `Waiting for ${NAME}… (cancel)`,
          icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />,
          onClick: connect,
          className: 'bg-slate-800 text-slate-300 hover:bg-slate-700',
        }
      : {
          label: broken.length ? `Reconnect ${NAME}` : connected ? `Connect another ${NAME} account` : `Connect ${NAME}`,
          icon: broken.length ? <RefreshCw className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />,
          onClick: connect,
          className: broken.length ? 'bg-amber-600 text-white hover:bg-amber-500' : 'bg-sky-600 text-white hover:bg-sky-500',
        };

  return (
    <>
      {setup && <AirtableSetupModal connectionId={setup} onClose={() => setSetup(null)} onDone={() => { setSetup(null); void load(); }} />}
      {panel && <AirtableSyncPanel sourceId={panel} onClose={() => setPanel(null)} onChanged={() => void load()} />}
      <IntegrationCard
      icon={
        <div className="w-9 h-9 rounded-xl bg-sky-500/20 text-sky-400 flex items-center justify-center border border-sky-500/30 shrink-0">
          <Table2 className="w-5 h-5" />
        </div>
      }
      title={NAME}
      blurb="Two-way sync with an Airtable base"
      connected={connected}
      loading={loading}
      accent="border-sky-500/40"
      action={action}
    >
      {error && (
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 text-rose-400 mt-0.5 shrink-0" />
          <div className="text-xs text-rose-200 leading-relaxed">{error}</div>
        </div>
      )}

      {!loading && !connections.length && !error && (
        <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-4 text-xs text-slate-400 leading-relaxed">
          {config?.configured
            ? 'Connect your Airtable account, then choose which base and table to sync. Nothing is imported until you pick one.'
            : 'This server has no Airtable client id and secret, so the connection cannot be started.'}
        </div>
      )}

      {connections.map((c) => (
        <div key={c.id} className="bg-slate-950 border border-slate-800/80 rounded-xl p-3 space-y-2">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs font-bold text-slate-100 truncate" title={c.accountEmail ?? undefined}>
              {c.accountEmail ?? c.accountId ?? 'Airtable account'}
            </span>
            {c.status === 'active' ? (
              <span className="text-2xs text-emerald-300 shrink-0">Connected {timeAgo(c.connectedAt)}</span>
            ) : (
              <span className="text-2xs text-amber-300 shrink-0">Needs reconnecting</span>
            )}
          </div>

          <Permissions permissions={c.permissions} />

          {c.status === 'active' && (
            <div className="pt-2 border-t border-slate-800 space-y-2">
              {sources
                .filter((t) => t.connectionId === c.id)
                .map((t) => (
                  <div key={t.id} className="rounded-xl border border-slate-800 bg-slate-950/40 p-2.5 space-y-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-xs font-bold text-slate-100 truncate" title={t.name}>
                        {t.name}
                      </span>
                      {/* Which way this table syncs, on the row itself. The setting
                          was only legible after opening the table, so a table that
                          imported and one that also wrote back looked identical. */}
                      <span
                        title={DIRECTION_LABELS[t.direction].help}
                        className={`text-2xs font-bold uppercase px-2 py-0.5 rounded-full border shrink-0 ${
                          t.direction === 'two_way'
                            ? 'bg-sky-500/20 text-sky-300 border-sky-500/40'
                            : 'bg-slate-800 text-slate-400 border-slate-700'
                        }`}
                      >
                        {DIRECTION_LABELS[t.direction].short}
                      </span>
                    </div>

                    <div className="text-2xs text-slate-500">
                      {t.importedLeads} lead{t.importedLeads === 1 ? '' : 's'}
                      {t.pendingReview > 0 && ` · ${t.pendingReview} to review`}
                    </div>

                    {t.lastErrorMessage && (
                      <div className="flex items-start gap-1.5 text-2xs text-amber-300">
                        <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                        <span className="leading-relaxed">{t.lastErrorMessage}</span>
                      </div>
                    )}

                    {armedTable === t.id ? (
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-2xs text-slate-400">Stop syncing? Its leads are kept.</span>
                        <span className="flex items-center gap-3 shrink-0">
                          <button type="button" className={link} onClick={() => setArmedTable(null)} disabled={busy === 'disconnect'}>
                            Cancel
                          </button>
                          <button
                            type="button"
                            className="text-2xs font-bold text-rose-300 hover:text-rose-200 cursor-pointer disabled:opacity-40"
                            onClick={() => void stopSyncing(t.id)}
                            disabled={busy === 'disconnect'}
                          >
                            Yes, remove
                          </button>
                        </span>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5">
                        <button
                          type="button"
                          className="text-2xs font-bold text-sky-400 hover:text-sky-300 cursor-pointer inline-flex items-center gap-1"
                          onClick={() => setPanel(t.id)}
                        >
                          <Settings2 className="w-3 h-3" />
                          Sync settings
                        </button>
                        <button
                          type="button"
                          className={`${link} hover:text-rose-300`}
                          onClick={() => void stopSyncing(t.id)}
                          disabled={busy === 'disconnect'}
                        >
                          Remove
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              <button
                type="button"
                className="text-2xs font-bold text-sky-400 hover:text-sky-300 cursor-pointer"
                onClick={() => setSetup(c.id)}
              >
                + Add a table
              </button>
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-1 border-t border-slate-800">
            {armed === c.id && <span className="text-2xs text-slate-400 mr-auto">Disconnect this account?</span>}
            {armed === c.id && (
              <button type="button" className={link} onClick={() => setArmed(null)} disabled={busy === 'disconnect'}>
                Cancel
              </button>
            )}
            <button
              type="button"
              className={armed === c.id ? 'text-2xs font-bold text-rose-300 hover:text-rose-200 cursor-pointer' : link}
              onClick={() => void disconnect(c.id)}
              disabled={busy === 'disconnect'}
            >
              {armed === c.id ? 'Yes, disconnect' : 'Disconnect'}
            </button>
          </div>
        </div>
      ))}
      </IntegrationCard>
    </>
  );
};
