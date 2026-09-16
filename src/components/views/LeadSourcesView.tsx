import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Check,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Radio,
  ShieldAlert,
  ShieldCheck,
  Webhook,
  X,
} from 'lucide-react';
import {
  ApiError,
  api,
  providersApi,
  type LeadSourceConfig,
  type LeadSourceWithSecret,
  type WebhookDelivery,
} from '../../api/client';
import { ConnectFormPanel } from '../leadsources/ConnectFormPanel';
import { CopyField } from '../leadsources/CopyField';
import { ConnectionPill, MappingPill, SourceStatusPill } from '../leadsources/StatusPills';

/**
 * Live backend screen — the ONLY view in this app that talks to the real API.
 * Every other view reads the in-browser demo store in AppContext. This one
 * deliberately holds its own fetch state rather than putting async data into
 * that context, so the two can never be accidentally merged.
 */

const SignaturePill: React.FC<{ state: string | null; usedPrevious: boolean }> = ({
  state,
  usedPrevious,
}) => {
  if (state === 'VALID') {
    return (
      <span
        className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full flex items-center gap-1 border ${
          usedPrevious
            ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
            : 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
        }`}
      >
        <ShieldCheck className="w-3 h-3" />
        {usedPrevious ? 'old secret' : 'verified'}
      </span>
    );
  }
  if (state === 'INVALID') {
    return (
      <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full flex items-center gap-1 bg-rose-500/20 text-rose-300 border border-rose-500/40">
        <ShieldAlert className="w-3 h-3" />
        bad signature
      </span>
    );
  }
  return (
    <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700">
      {state === 'NOT_CONFIGURED' ? 'no secret' : 'unsigned'}
    </span>
  );
};

const DeliveryCard: React.FC<{ d: WebhookDelivery }> = ({ d }) => {
  const quarantined = d.outcome === 'QUARANTINED_SIGNATURE';
  return (
    <div
      className={`bg-slate-950 border rounded-xl p-3 space-y-2 ${
        quarantined ? 'border-rose-500/40' : 'border-slate-800/80'
      }`}
    >
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-300 font-medium">
            {new Date(d.receivedAt).toLocaleString()}
          </span>
          <SignaturePill state={d.signatureState} usedPrevious={d.usedPreviousSecret} />
          {d.formName && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
              {d.formName}
            </span>
          )}
        </div>
        <span className="text-[10px] font-mono text-slate-500">{d.bodyBytes ?? 0}B</span>
      </div>

      {/* The one-line answer to "did normalization work on this submission?" */}
      {d.mapping && (
        <div className="flex items-center gap-1.5 flex-wrap text-[10px]">
          <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-semibold">
            {d.mapping.mapped} mapped
          </span>
          {d.mapping.unmapped > 0 && (
            <span
              title="Kept verbatim on the lead as an extra answer — not lost, just not one of our fields"
              className="px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700"
            >
              {d.mapping.unmapped} unmapped
            </span>
          )}
          {d.mapping.warnings > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40 font-semibold">
              {d.mapping.warnings} need{d.mapping.warnings === 1 ? 's' : ''} a look
            </span>
          )}
          {d.mapping.errored > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/40 font-semibold">
              {d.mapping.errored} failed
            </span>
          )}
        </div>
      )}

      {quarantined && (
        <div className="text-[11px] text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-2.5 py-2 leading-relaxed">
          <strong>Signature didn't match.</strong> The secret in Tally doesn't match ours, so this
          submission was quarantined rather than processed. The raw payload is retained — fix the
          secret and it can be re-verified and replayed, so nothing is lost.
        </div>
      )}

      {d.parseError && (
        <div className="text-[11px] text-amber-300">Could not parse payload: {d.parseError}</div>
      )}

      {d.answers.length > 0 ? (
        <div className="space-y-1 pt-1">
          {d.answers.map((a, i) => (
            <div key={i} className="space-y-0.5">
              <div className="flex items-baseline gap-2 text-xs">
                <span className="text-slate-400 min-w-[40%] shrink-0 truncate" title={a.label}>
                  {a.label}
                </span>
                <span className="text-slate-100 font-medium break-words">
                  {a.value || <span className="text-slate-600 italic">(empty)</span>}
                </span>

                {/* Where this answer ended up. The arrow is the whole point:
                    it shows a question becoming a lead field, or not. */}
                <span className="ml-auto shrink-0 flex items-center gap-1.5">
                  {a.targetFields.length > 0 ? (
                    a.targetFields.map(t => (
                      <span
                        key={t}
                        className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                      >
                        → {t}
                      </span>
                    ))
                  ) : a.mappingOutcome === 'unmapped' ? (
                    <span
                      title="Stored on the lead as an extra answer, not as one of our fields"
                      className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-500 border border-slate-700"
                    >
                      extra
                    </span>
                  ) : null}
                  <span className="text-[9px] text-slate-600 font-mono">{a.type}</span>
                </span>
              </div>

              {a.warnings.map((w, j) => (
                <div key={j} className="text-[10px] text-amber-300/90 pl-1 flex items-start gap-1">
                  <AlertTriangle className="w-2.5 h-2.5 mt-0.5 shrink-0" />
                  {w}
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : (
        !d.parseError && <div className="text-[11px] text-slate-500 italic">No fields in payload.</div>
      )}
    </div>
  );
};

export const LeadSourcesView: React.FC = () => {
  const [sources, setSources] = useState<LeadSourceConfig[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [loadingDeliveries, setLoadingDeliveries] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [justCreated, setJustCreated] = useState<LeadSourceWithSecret | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [showConnect, setShowConnect] = useState(false);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Two-step rather than window.confirm: this app has no confirm dialogs.
  const [confirmDisconnect, setConfirmDisconnect] = useState<string | null>(null);

  const loadSources = useCallback(async () => {
    try {
      setSources(await api.listLeadSources());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setSources([]);
    }
  }, []);

  const loadDeliveries = useCallback(async (id: string) => {
    setLoadingDeliveries(true);
    try {
      setDeliveries(await api.deliveries(id));
    } catch {
      setDeliveries([]);
    } finally {
      setLoadingDeliveries(false);
    }
  }, []);

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  useEffect(() => {
    if (selectedId) void loadDeliveries(selectedId);
  }, [selectedId, loadDeliveries]);

  // Poll while a source is open so a Tally submission appears without the user
  // having to guess when to refresh — this is what makes "did it arrive?"
  // answerable at a glance.
  useEffect(() => {
    if (!selectedId || !autoRefresh) return;
    const t = setInterval(() => void loadDeliveries(selectedId), 4000);
    return () => clearInterval(t);
  }, [selectedId, autoRefresh, loadDeliveries]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const created = await api.createLeadSource(newName.trim());
      setJustCreated(created);
      setShowCreate(false);
      setNewName('');
      await loadSources();
      setSelectedId(created.id);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const selected = sources?.find((s) => s.id === selectedId) ?? null;

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto text-slate-100">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-bold text-white tracking-tight">Lead Sources</h2>
            <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 flex items-center gap-1">
              <Radio className="w-3 h-3" />
              Live API
            </span>
          </div>
          <p className="text-xs text-slate-400">
            Real webhook endpoints backed by Postgres. Every other screen in this app uses in-browser
            demo data — this one does not.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              setShowCreate(true);
              setShowConnect(false);
            }}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-semibold transition-colors cursor-pointer"
          >
            Set up manually
          </button>
          <button
            onClick={() => {
              setShowConnect(true);
              setShowCreate(false);
              setJustCreated(null);
            }}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl text-xs flex items-center gap-1.5 shadow-md shadow-emerald-950 transition-colors cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            Connect a form
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-2xl p-4 flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" />
          <div className="text-xs text-rose-200 leading-relaxed">
            <div className="font-semibold text-rose-100">Can't reach the backend</div>
            {error}
            <div className="mt-2 text-rose-300/80">
              Start it with <code className="font-mono">cd server && npm run dev</code>, then make sure
              <code className="font-mono"> API_KEY</code> is set in the project-root{' '}
              <code className="font-mono">.env</code> and restart <code className="font-mono">npm run dev</code>.
            </div>
          </div>
        </div>
      )}

      {notice && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-2xl p-4 flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
          <div className="text-xs text-amber-200 leading-relaxed flex-1">{notice}</div>
          <button
            onClick={() => setNotice(null)}
            className="p-1 rounded-lg text-amber-300/70 hover:text-amber-100 transition-colors cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {showConnect && (
        <ConnectFormPanel
          onClose={() => setShowConnect(false)}
          onConnected={async (id) => {
            await loadSources();
            setSelectedId(id);
          }}
          onOpenSource={(id) => {
            setShowConnect(false);
            setSelectedId(id);
          }}
          onSetUpManually={() => {
            setShowConnect(false);
            setShowCreate(true);
          }}
        />
      )}

      {/* Secret reveal — the only time the signing secret is ever shown. */}
      {justCreated && (
        <div className="bg-slate-900/90 border border-emerald-500/40 rounded-2xl p-5 space-y-4 shadow-xl">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <h3 className="text-sm font-bold text-white">
                "{justCreated.name}" created — paste these into Tally
              </h3>
            </div>
            <button
              onClick={() => setJustCreated(null)}
              className="p-1.5 rounded-lg bg-slate-800 text-slate-400 hover:text-white transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <CopyField label="Webhook URL" value={justCreated.webhookUrl ?? ''} />
          <CopyField label="Signing secret" value={justCreated.signingSecret} />

          <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 text-[11px] text-amber-200 leading-relaxed flex gap-2">
            <KeyRound className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>
              <strong>The signing secret is shown once.</strong> It is encrypted at rest and no API
              response will ever return it again — if you lose it, rotate to get a new one. The
              webhook URL can always be recovered from this screen.
            </span>
          </div>

          <ol className="text-[11px] text-slate-300 space-y-1 list-decimal list-inside leading-relaxed">
            <li>In Tally, open your form → <strong>Integrations</strong> → <strong>Webhooks</strong> → Add webhook.</li>
            <li>Paste the <strong>Webhook URL</strong>.</li>
            <li>Expand <strong>Signing secret</strong> and paste the secret.</li>
            <li>Connect, then submit a test response — it appears below within a few seconds.</li>
          </ol>
        </div>
      )}

      {showCreate && (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-3 shadow-xl">
          <h3 className="text-sm font-bold text-white">New lead source</h3>
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void handleCreate()}
            placeholder="e.g. Buyer Intake Form (Tally)"
            className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
          />
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setShowCreate(false)}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-semibold transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={() => void handleCreate()}
              disabled={creating || !newName.trim()}
              className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-bold rounded-lg text-xs flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              {creating && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Create & show secret
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Sources list */}
        <div className="lg:col-span-1 space-y-3">
          {sources === null ? (
            <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 text-xs text-slate-400 flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
            </div>
          ) : sources.length === 0 ? (
            <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 text-center space-y-2">
              <Webhook className="w-6 h-6 text-slate-600 mx-auto" />
              <div className="text-xs text-slate-400">
                No lead sources yet. Connect a form to have the webhook installed for you, or set
                one up manually to get a URL you paste yourself.
              </div>
            </div>
          ) : (
            sources.map((s) => (
              <button
                key={s.id}
                onClick={() => setSelectedId(s.id)}
                className={`w-full text-left bg-slate-900/90 border rounded-2xl p-4 space-y-2 shadow-xl transition-colors cursor-pointer ${
                  selectedId === s.id
                    ? 'border-emerald-500/50'
                    : 'border-slate-800 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-bold text-white truncate">{s.name}</span>
                  <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 shrink-0">
                    {s.deliveryCount ?? 0}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <SourceStatusPill source={s} />
                  <ConnectionPill source={s} />
                  {s.externalFormName && (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 truncate max-w-[60%]">
                      {s.externalFormName}
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-slate-400">
                  {s.lastEventAt
                    ? `Last delivery ${new Date(s.lastEventAt).toLocaleString()}`
                    : (s.mappingStatus ?? '').toUpperCase() !== 'UNCONFIGURED'
                      ? 'Ready — listening for submissions'
                      : 'Awaiting first submission'}
                </div>
              </button>
            ))
          )}
        </div>

        {/* Detail */}
        <div className="lg:col-span-2 space-y-4">
          {selected ? (
            <>
              <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <h3 className="text-sm font-bold text-white truncate">{selected.name}</h3>
                    {selected.externalFormName && (
                      <div className="text-[11px] text-slate-400 truncate">
                        {(selected.provider ?? 'form').toLowerCase()} · {selected.externalFormName}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
                    <SourceStatusPill source={selected} />
                    <MappingPill status={selected.mappingStatus} />
                  </div>
                </div>

                {/* A webhook that vanished on the provider's side is silent
                    data loss, so it gets a repair button rather than a badge. */}
                {['UNINSTALLED', 'ORPHANED', 'ERROR', 'DRIFTED'].includes(
                  (selected.remoteState ?? '').toUpperCase(),
                ) && (
                  <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 space-y-2">
                    <div className="text-[11px] text-rose-200 leading-relaxed">
                      <strong className="text-rose-100">The webhook is not where we expect it.</strong>{' '}
                      {selected.remoteErrorMessage ??
                        'It is no longer on the form. Submissions since then were never sent to us, and cannot be recovered.'}
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={async () => {
                          setRemoteBusy(true);
                          try {
                            const r = await providersApi.resync(selected.id);
                            setNotice(`Re-sync: ${r.remoteState.toLowerCase()}${r.removedDuplicates ? `, removed ${r.removedDuplicates} duplicate webhook(s)` : ''}.`);
                            await loadSources();
                          } catch (e) {
                            setNotice(e instanceof ApiError ? e.message : String(e));
                          } finally {
                            setRemoteBusy(false);
                          }
                        }}
                        disabled={remoteBusy}
                        className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition-colors cursor-pointer disabled:opacity-40"
                      >
                        Re-sync
                      </button>
                      <button
                        onClick={async () => {
                          setRemoteBusy(true);
                          try {
                            await providersApi.reinstall(selected.id);
                            setNotice('Webhook reinstalled with the same URL and secret — nothing else to change.');
                            await loadSources();
                          } catch (e) {
                            setNotice(e instanceof ApiError ? e.message : String(e));
                          } finally {
                            setRemoteBusy(false);
                          }
                        }}
                        disabled={remoteBusy}
                        className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition-colors cursor-pointer disabled:opacity-40"
                      >
                        Reinstall webhook
                      </button>
                    </div>
                  </div>
                )}

                {selected.webhookUrl && <CopyField label="Webhook URL" value={selected.webhookUrl} />}
                <div className="text-[11px] text-slate-400">
                  Signing secret:{' '}
                  {selected.signingSecretPreview ? (
                    <span className="font-mono text-slate-300">{selected.signingSecretPreview}</span>
                  ) : (
                    'not configured'
                  )}
                  {' · '}
                  {selected.requireSignature
                    ? 'required'
                    : 'verified when present, accepted when absent'}
                </div>

                {/* Only an API-connected source can be removed from the
                    provider by us; a manual one we have no credential for. */}
                {(selected.connectionMethod ?? '').toUpperCase() === 'API' && (
                  <div className="pt-3 border-t border-slate-800 flex items-center justify-between gap-2">
                    <span className="text-[11px] text-slate-500">
                      We installed this webhook, so we can remove it for you.
                    </span>
                    <button
                      onClick={async () => {
                        if (confirmDisconnect !== selected.id) {
                          setConfirmDisconnect(selected.id);
                          return;
                        }
                        setRemoteBusy(true);
                        try {
                          const r = await providersApi.disconnectForm(selected.id);
                          setNotice(
                            r.warning ??
                              'Disconnected, and the webhook was removed from your form. Leads already received are untouched.',
                          );
                          setConfirmDisconnect(null);
                          setSelectedId(null);
                          await loadSources();
                        } catch (e) {
                          setNotice(
                            e instanceof ApiError
                              ? `${e.message} Use force if you want to disconnect anyway and remove it yourself.`
                              : String(e),
                          );
                        } finally {
                          setRemoteBusy(false);
                        }
                      }}
                      disabled={remoteBusy}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer disabled:opacity-40 ${
                        confirmDisconnect === selected.id
                          ? 'bg-rose-600 hover:bg-rose-500 text-white'
                          : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
                      }`}
                    >
                      {confirmDisconnect === selected.id ? 'Confirm — remove webhook' : 'Disconnect'}
                    </button>
                  </div>
                )}
              </div>

              <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-3 shadow-xl">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold text-white">Deliveries</h3>
                  <div className="flex items-center gap-3">
                    <label className="text-[11px] text-slate-400 flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={autoRefresh}
                        onChange={(e) => setAutoRefresh(e.target.checked)}
                        className="accent-emerald-500"
                      />
                      Auto-refresh
                    </label>
                    <button
                      onClick={() => selectedId && void loadDeliveries(selectedId)}
                      className="text-slate-400 hover:text-white transition-colors cursor-pointer"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${loadingDeliveries ? 'animate-spin' : ''}`} />
                    </button>
                  </div>
                </div>

                {deliveries.length === 0 ? (
                  <div className="text-center py-8 space-y-2">
                    <Radio className="w-6 h-6 text-slate-600 mx-auto animate-pulse" />
                    <div className="text-xs text-slate-400">Listening for your first submission…</div>
                    <div className="text-[11px] text-slate-500 max-w-md mx-auto leading-relaxed">
                      {(selected.connectionMethod ?? '').toUpperCase() === 'API' ? (
                        <>
                          The webhook is already installed on your form — just submit it once.
                          Nothing arriving? Our public URL must be reachable from the internet; a{' '}
                          <code className="font-mono">localhost</code> address cannot be called.
                        </>
                      ) : (
                        <>
                          Paste the webhook URL into Tally and submit your form. Nothing arriving? The
                          URL must be publicly reachable — a <code className="font-mono">localhost</code>{' '}
                          URL cannot be called by Tally. Use an ngrok tunnel and set{' '}
                          <code className="font-mono">PUBLIC_API_BASE_URL</code> to it.
                        </>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {deliveries.map((d) => (
                      <DeliveryCard key={d.id} d={d} />
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-8 text-center text-xs text-slate-400">
              Select a lead source to see its webhook URL and incoming deliveries.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
