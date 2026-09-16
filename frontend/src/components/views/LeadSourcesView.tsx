import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Loader2,
  Radio,
  RefreshCw,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Users,
  Webhook,
} from 'lucide-react';
import {
  ApiError,
  api,
  leadsApi,
  type LeadSourceConfig,
  type LiveLead,
  type WebhookDelivery,
} from '../../api/client';
import { useApp } from '../../context/AppContext';
import { ConnectionPill, SourceStatusPill } from '../leadsources/StatusPills';


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

const DASH = '—';

const fullName = (l: LiveLead) =>
  [l.firstName, l.lastName].filter(Boolean).join(' ') || 'Unnamed lead';

/** One lead this source produced. Read-only — the pipeline is where you work them. */
const LeadRow: React.FC<{ lead: LiveLead }> = ({ lead }) => (
  <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-3 flex items-start justify-between gap-3">
    <div className="min-w-0">
      <div className="text-xs font-bold text-slate-100 truncate">{fullName(lead)}</div>
      <div className="text-[11px] text-slate-400 font-mono flex items-center gap-1 mt-0.5">
        {lead.phone ?? DASH}
        {lead.phone && !lead.phoneValid && (
          <span title="Phone could not be parsed — excluded from dialing">
            <ShieldAlert className="w-3 h-3 text-amber-400" />
          </span>
        )}
      </div>
      <div className="text-[11px] text-slate-500 truncate">{lead.email ?? DASH}</div>
    </div>
    <div className="text-right shrink-0 space-y-1">
      <div className="text-[10px] text-slate-500">
        {new Date(lead.createdAt).toLocaleString()}
      </div>
      <div className="flex items-center gap-1 justify-end">
        {lead.contactLeadCount > 1 && (
          <span
            title={`${lead.contactLeadCount} leads share this phone number or email. Each submission is kept as its own lead.`}
            className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30"
          >
            repeat
          </span>
        )}
        <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-slate-800 text-slate-300">
          {lead.status}
        </span>
      </div>
    </div>
  </div>
);

/**
 * What each connected form has actually brought in.
 *
 * Connecting a source is NOT done here any more — it lives on Integrations &
 * Webhooks, along with webhook URLs, signing secrets and disconnect. That split
 * is the point of this screen: setup is a once-per-form act, while this is the
 * page you open to ask "is the form working, and what came through it?". Mixing
 * the two put a wall of buttons in front of the answer.
 *
 * Still the only view in this app that talks to the real API besides that panel.
 * Every other screen reads the in-browser demo store in AppContext; this one
 * deliberately holds its own fetch state so the two can never merge.
 */
export const LeadSourcesView: React.FC = () => {
  const { setActiveView, focusLeadSourceId, setFocusLeadSourceId } = useApp();

  const [sources, setSources] = useState<LeadSourceConfig[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [loadingDeliveries, setLoadingDeliveries] = useState(false);
  const [leads, setLeads] = useState<LiveLead[] | null>(null);
  const [loadingLeads, setLoadingLeads] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const loadSources = useCallback(async () => {
    try {
      setSources(await api.listLeadSources());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setSources([]);
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    setLoadingDeliveries(true);
    setLoadingLeads(true);
    // Settled, not all: a failing deliveries call must not blank the leads list
    // and leave the screen looking like the source produced nothing.
    const [d, l] = await Promise.allSettled([api.deliveries(id), leadsApi.list({ sourceId: id })]);
    setDeliveries(d.status === 'fulfilled' ? d.value : []);
    setLeads(l.status === 'fulfilled' ? l.value : []);
    setLoadingDeliveries(false);
    setLoadingLeads(false);
  }, []);

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  // Arriving from Integrations after connecting something — open it and drop
  // the handoff, so a later visit does not re-select a stale source.
  useEffect(() => {
    if (!focusLeadSourceId) return;
    setSelectedId(focusLeadSourceId);
    setFocusLeadSourceId(null);
  }, [focusLeadSourceId, setFocusLeadSourceId]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  // Poll while a source is open so a Tally submission appears without the user
  // having to guess when to refresh — this is what makes "did it arrive?"
  // answerable at a glance.
  useEffect(() => {
    if (!selectedId || !autoRefresh) return;
    const t = setInterval(() => {
      void loadDetail(selectedId);
      void loadSources();
    }, 4000);
    return () => clearInterval(t);
  }, [selectedId, autoRefresh, loadDetail, loadSources]);

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
            What each connected form has brought in. Real data from Postgres — every other screen in
            this app uses in-browser demo data.
          </p>
        </div>

        <button
          onClick={() => setActiveView('integrations')}
          className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
        >
          <Settings2 className="w-3.5 h-3.5" />
          Manage connections
        </button>
      </div>

      {error && (
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-2xl p-4 flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" />
          <div className="text-xs text-rose-200 leading-relaxed">
            <div className="font-semibold text-rose-100">Can't reach the backend</div>
            {error}
            <div className="mt-2 text-rose-300/80">
              Start it with <code className="font-mono">cd backend && npm run dev</code> and check it is
              listening on <code className="font-mono">:4000</code>. If you are signed in and still see
              this, your session may have expired — sign out and back in.
            </div>
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
            <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 text-center space-y-3">
              <Webhook className="w-6 h-6 text-slate-600 mx-auto" />
              <div className="text-xs text-slate-400 leading-relaxed">
                No lead sources yet. Connecting a form happens on Integrations &amp; Webhooks.
              </div>
              <button
                onClick={() => setActiveView('integrations')}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl text-xs transition-colors cursor-pointer"
              >
                Connect a form
              </button>
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
                  {/* Leads, not deliveries: a delivery with no usable phone or
                      email never becomes one, so the counts can disagree and
                      this is the number the question is actually about. */}
                  <span
                    title={`${s.leadCount ?? 0} leads from ${s.deliveryCount ?? 0} deliveries`}
                    className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 shrink-0 flex items-center gap-1"
                  >
                    <Users className="w-2.5 h-2.5" />
                    {s.leadCount ?? 0}
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
              <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-xl flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <h3 className="text-sm font-bold text-white truncate">{selected.name}</h3>
                  <div className="text-[11px] text-slate-400 truncate">
                    {selected.externalFormName
                      ? `${(selected.provider ?? 'form').toLowerCase()} · ${selected.externalFormName}`
                      : `${selected.leadCount ?? 0} leads · ${selected.deliveryCount ?? 0} deliveries`}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
                  <SourceStatusPill source={selected} />
                  <ConnectionPill source={selected} />
                </div>
              </div>

              {/* Leads from this source */}
              <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-3 shadow-xl">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Users className="w-4 h-4 text-emerald-400" />
                    <h3 className="text-sm font-bold text-white">Leads from this source</h3>
                    {leads !== null && (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-800 text-slate-300">
                        {leads.length}
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => setActiveView('leads')}
                    className="text-[11px] text-emerald-400 hover:text-emerald-300 font-medium transition-colors cursor-pointer"
                  >
                    Open pipeline →
                  </button>
                </div>

                {loadingLeads && leads === null ? (
                  <div className="text-xs text-slate-400 flex items-center gap-2 py-4">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
                  </div>
                ) : leads && leads.length > 0 ? (
                  <div className="space-y-2">
                    {leads.map((l) => (
                      <LeadRow key={l.id} lead={l} />
                    ))}
                  </div>
                ) : (
                  <div className="text-[11px] text-slate-500 text-center py-6 leading-relaxed max-w-md mx-auto">
                    No leads from this source yet. Every submission carrying a usable phone or email
                    becomes its own lead — a delivery with neither is stored below and stays
                    replayable once the mapping is fixed.
                  </div>
                )}
              </div>

              {/* Deliveries */}
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
                      onClick={() => selectedId && void loadDetail(selectedId)}
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
                          Paste the webhook URL into Tally and submit your form. The URL is on
                          Integrations &amp; Webhooks. Nothing arriving? It must be publicly
                          reachable — a <code className="font-mono">localhost</code> URL cannot be
                          called by Tally.
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
              Select a lead source to see the leads it produced and the deliveries behind them.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
