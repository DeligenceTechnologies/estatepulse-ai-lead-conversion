import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Loader2,
  Plus,
  Radio,
  Webhook,
  X,
} from 'lucide-react';
import { ApiError, api, providersApi, type LeadSourceConfig } from '../../api/client';
import { useApp } from '../../context/AppContext';
import { ConnectModal, type ConnectKind } from '../leadsources/ConnectModal';
import { CopyField } from '../leadsources/CopyField';
import { ConnectionPill, MappingPill, SourceStatusPill } from '../leadsources/StatusPills';

/**
 * Every connection control in the product, in one place.
 *
 * These used to live on Lead Sources, which conflated two different jobs: the
 * setup you do once per form, and the monitoring you do daily. This panel owns
 * setup — creating a source, showing its URL and secret, repairing a webhook
 * that drifted, disconnecting. Lead Sources owns the other half and now shows
 * only what each source has actually brought in.
 *
 * Like Lead Sources, it holds its own fetch state and never writes into
 * AppContext's demo store — the two data worlds stay separate even though they
 * now share a screen with demo integration cards.
 */
export const ConnectionsPanel: React.FC = () => {
  const { setActiveView, setFocusLeadSourceId } = useApp();

  const [sources, setSources] = useState<LeadSourceConfig[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // 'CHOOSE' opens the modal on its picker; a ConnectKind skips straight past it,
  // because clicking a button labelled "Tally" has already answered the question.
  const [connect, setConnect] = useState<ConnectKind | 'CHOOSE' | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSources(await api.listLeadSources());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setSources([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openInLeadSources = (id: string) => {
    setFocusLeadSourceId(id);
    setActiveView('lead_sources');
  };

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold text-white">Lead capture connections</h3>
            <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 flex items-center gap-1">
              <Radio className="w-3 h-3" />
              Live API
            </span>
          </div>
          <p className="text-[11px] text-slate-400 mt-0.5">
            Where real leads come from. Connect one here; watch what it brings in on Lead Sources.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setConnect('WEBHOOK')}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <Webhook className="w-3.5 h-3.5" />
            Webhook
          </button>
          <button
            onClick={() => setConnect('TALLY')}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl text-xs flex items-center gap-1.5 shadow-md shadow-emerald-950 transition-colors cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            Tally
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 text-rose-400 mt-0.5 shrink-0" />
          <div className="text-[11px] text-rose-200 leading-relaxed">
            <div className="font-semibold text-rose-100">Can't reach the backend</div>
            {error}
          </div>
        </div>
      )}

      {notice && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
          <div className="text-[11px] text-amber-200 leading-relaxed flex-1">{notice}</div>
          <button
            onClick={() => setNotice(null)}
            className="p-1 rounded-lg text-amber-300/70 hover:text-amber-100 transition-colors cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {sources === null ? (
        <div className="text-xs text-slate-400 flex items-center gap-2 py-4">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
        </div>
      ) : sources.length === 0 ? (
        <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-6 text-center space-y-2">
          <Webhook className="w-6 h-6 text-slate-600 mx-auto" />
          <div className="text-xs text-slate-400 max-w-md mx-auto leading-relaxed">
            Nothing connected yet. Connect a <strong>Tally</strong> form and we install the webhook
            for you, or take a <strong>Webhook</strong> URL and paste it in yourself.
          </div>
          <button
            onClick={() => setConnect('CHOOSE')}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl text-xs transition-colors cursor-pointer"
          >
            Connect a lead source
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {sources.map((s) => {
            const open = expandedId === s.id;
            const remote = (s.remoteState ?? '').toUpperCase();
            const broken = ['UNINSTALLED', 'ORPHANED', 'ERROR', 'DRIFTED'].includes(remote);

            return (
              <div
                key={s.id}
                className={`bg-slate-950 border rounded-xl overflow-hidden ${
                  broken ? 'border-rose-500/40' : open ? 'border-slate-700' : 'border-slate-800/80'
                }`}
              >
                <button
                  onClick={() => setExpandedId(open ? null : s.id)}
                  className="w-full text-left p-4 flex items-center gap-3 transition-colors hover:bg-slate-900/60 cursor-pointer"
                >
                  {open ? (
                    <ChevronDown className="w-4 h-4 text-slate-500 shrink-0" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-slate-500 shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-bold text-white truncate">{s.name}</div>
                    <div className="flex items-center gap-1.5 flex-wrap mt-1">
                      <SourceStatusPill source={s} />
                      <ConnectionPill source={s} />
                      {s.externalFormName && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 truncate max-w-[50%]">
                          {s.externalFormName}
                        </span>
                      )}
                    </div>
                  </div>
                  <span className="text-[11px] text-slate-500 font-mono shrink-0">
                    {s.leadCount ?? 0} leads
                  </span>
                </button>

                {open && (
                  <div className="px-4 pb-4 space-y-3 border-t border-slate-800/80 pt-3">
                    {/* A webhook that vanished on the provider's side is silent
                        data loss, so it gets a repair button rather than a badge. */}
                    {broken && (
                      <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 space-y-2">
                        <div className="text-[11px] text-rose-200 leading-relaxed">
                          <strong className="text-rose-100">The webhook is not where we expect it.</strong>{' '}
                          {s.remoteErrorMessage ??
                            'It is no longer on the form. Submissions since then were never sent to us, and cannot be recovered.'}
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={async () => {
                              setBusy(true);
                              try {
                                const r = await providersApi.resync(s.id);
                                setNotice(
                                  `Re-sync: ${r.remoteState.toLowerCase()}${r.removedDuplicates ? `, removed ${r.removedDuplicates} duplicate webhook(s)` : ''}.`,
                                );
                                await load();
                              } catch (e) {
                                setNotice(e instanceof ApiError ? e.message : String(e));
                              } finally {
                                setBusy(false);
                              }
                            }}
                            disabled={busy}
                            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition-colors cursor-pointer disabled:opacity-40"
                          >
                            Re-sync
                          </button>
                          <button
                            onClick={async () => {
                              setBusy(true);
                              try {
                                await providersApi.reinstall(s.id);
                                setNotice(
                                  'Webhook reinstalled with the same URL and secret — nothing else to change.',
                                );
                                await load();
                              } catch (e) {
                                setNotice(e instanceof ApiError ? e.message : String(e));
                              } finally {
                                setBusy(false);
                              }
                            }}
                            disabled={busy}
                            className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition-colors cursor-pointer disabled:opacity-40"
                          >
                            Reinstall webhook
                          </button>
                        </div>
                      </div>
                    )}

                    {s.webhookUrl && <CopyField label="Webhook URL" value={s.webhookUrl} />}

                    <div className="flex items-center justify-between gap-3 flex-wrap text-[11px] text-slate-400">
                      <span>
                        Signing secret:{' '}
                        {s.signingSecretPreview ? (
                          <span className="font-mono text-slate-300">{s.signingSecretPreview}</span>
                        ) : (
                          'not configured'
                        )}
                        {' · '}
                        {s.requireSignature ? 'required' : 'verified when present, accepted when absent'}
                      </span>
                      <MappingPill status={s.mappingStatus} />
                    </div>

                    <div className="pt-3 border-t border-slate-800 flex items-center justify-between gap-2 flex-wrap">
                      <button
                        onClick={() => openInLeadSources(s.id)}
                        className="text-[11px] text-emerald-400 hover:text-emerald-300 font-medium transition-colors cursor-pointer"
                      >
                        View its leads and deliveries →
                      </button>

                      {/* Only an API-connected source can be removed from the
                          provider by us; a manual one we have no credential for. */}
                      {(s.connectionMethod ?? '').toUpperCase() === 'API' ? (
                        <button
                          onClick={async () => {
                            if (confirmDisconnect !== s.id) {
                              setConfirmDisconnect(s.id);
                              return;
                            }
                            setBusy(true);
                            try {
                              const r = await providersApi.disconnectForm(s.id);
                              setNotice(
                                r.warning ??
                                  'Disconnected, and the webhook was removed from your form. Leads already received are untouched.',
                              );
                              setConfirmDisconnect(null);
                              setExpandedId(null);
                              await load();
                            } catch (e) {
                              setNotice(
                                e instanceof ApiError
                                  ? `${e.message} Use force if you want to disconnect anyway and remove it yourself.`
                                  : String(e),
                              );
                            } finally {
                              setBusy(false);
                            }
                          }}
                          disabled={busy}
                          className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer disabled:opacity-40 ${
                            confirmDisconnect === s.id
                              ? 'bg-rose-600 hover:bg-rose-500 text-white'
                              : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
                          }`}
                        >
                          {confirmDisconnect === s.id ? 'Confirm — remove webhook' : 'Disconnect'}
                        </button>
                      ) : (
                        <span className="text-[11px] text-slate-500">
                          Set up by hand — remove the webhook in your form tool to stop it.
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {connect && (
        <ConnectModal
          initial={connect === 'CHOOSE' ? undefined : connect}
          onClose={() => setConnect(null)}
          onConnected={async (id) => {
            await load();
            setExpandedId(id);
          }}
          onOpenSource={(id) => {
            setConnect(null);
            openInLeadSources(id);
          }}
        />
      )}
    </div>
  );
};
