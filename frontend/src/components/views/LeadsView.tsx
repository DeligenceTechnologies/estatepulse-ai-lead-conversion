import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ChevronRight,
  Flame,
  Plus,
  Radio,
  RefreshCw,
  Search,
  ShieldAlert,
  Users,
  Webhook,
} from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { LEADS_CHANGED_EVENT, leadsApi, type LeadStats, type LiveLead } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useLiveEvents } from '../../lib/liveEvents';
import { useLiveQuery } from '../../lib/useLiveQuery';
import { messageFor } from '../../lib/api';
import { Lead, LeadStatus, LeadTemperature } from '../../types';
import { LEAD_STATUSES, STATUS_LABELS, normalizeStatus, statusLabel, statusTone } from '../../lib/leadStatus';

/**
 * Lead pipeline — live rows only.
 *
 * The demo pipeline that used to render here came from AppContext's localStorage
 * store, and a second "Live Leads" panel sat above it. Both are gone: this table
 * shows exactly what the backend holds. The layout, the filters and the row
 * actions are unchanged, so a column with nothing behind it yet — assigned agent,
 * budget on an unqualified lead — renders an em dash instead of being dropped.
 *
 * Rows are mapped to `Lead` for the shared detail / pre-call modals and
 * registered with AppContext, but rendering reads the raw `LiveLead` so a null
 * stays distinguishable from a zero.
 */

const DASH = '—';

/** Canonical values arrive underscored (`under_30_days`); the table reads better without them. */
const humanize = (v: string | null | undefined) => (v ? v.replace(/_/g, ' ') : null);

const fullName = (l: LiveLead) =>
  [l.firstName, l.lastName].filter(Boolean).join(' ') || 'Unnamed lead';

/** "SP" for "Sunny Patel"; the first two letters of a one-word name. */
const initialsOf = (name: string) => {
  const parts = name.trim().split(/\s+/);
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : name.slice(0, 2)).toUpperCase();
};

const thousands = (n: number) => `$${(n / 1000).toFixed(0)}k`;

const budgetRange = (l: LiveLead) => {
  const { minBudget: lo, maxBudget: hi } = l;
  if (lo !== null && hi !== null) return lo === hi ? thousands(lo) : `${thousands(lo)} – ${thousands(hi)}`;
  if (lo !== null) return `${thousands(lo)}+`;
  if (hi !== null) return `up to ${thousands(hi)}`;
  return DASH;
};

/**
 * What the row is badged with: where the lead actually came from.
 *
 * `source.type` is the transport and is 'webhook' for every ingested lead,
 * which makes it useless as a label the moment a second integration exists —
 * a form we connected through Tally's API read "webhook" exactly like a URL
 * pasted by hand. So an API-connected source is badged with its provider
 * ("tally") and only a manually pasted URL keeps "webhook", which is the same
 * rule the Lead Sources list uses for its connection pill. The customer's own
 * label for the form ("Buyer Inquiry") stays on hover.
 */
const sourceLabel = (l: LiveLead): string => {
  const s = l.source;
  if (!s) return 'manual';
  if ((s.connectionMethod ?? '').toUpperCase() === 'API' && s.provider) return s.provider.toLowerCase();
  return s.type ?? 'webhook';
};


const temperatureTone = (t: string | null) => {
  switch (t) {
    case 'hot':
      return 'bg-rose-500/20 text-rose-300 border border-rose-500/40';
    case 'warm':
      return 'bg-amber-500/20 text-amber-300 border border-amber-500/40';
    case 'cold':
      return 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30';
    default:
      return 'bg-slate-800 text-slate-400 border border-slate-700';
  }
};

/**
 * LiveLead -> Lead, for the modals and the call simulator only.
 *
 * Every gap becomes the zero value the `Lead` type demands, which is why the
 * table never renders from this shape: `budgetMin: 0` cannot be told apart from
 * a lead that genuinely has no budget yet.
 */
const toLead = (l: LiveLead): Lead => ({
  id: l.id,
  organizationId: 'live',
  assignedAgentId: l.assignedAgent?.id ?? '',
  assignedAgentName: l.assignedAgent?.name,
  firstName: l.firstName ?? '',
  lastName: l.lastName ?? '',
  email: l.email ?? '',
  phone: l.phone ?? '',
  // Same label as the table badge. `LeadSource` is the demo store's closed
  // union, so an unrecognised provider would widen it — acceptable because
  // nothing branches on this value; it is displayed and nothing more.
  source: sourceLabel(l) as Lead['source'],
  sourceId: l.source?.id,
  status: normalizeStatus(l.status, l.dncStatus),
  leadType: 'buyer',
  preferredLocation: l.location ?? '',
  budgetMin: l.minBudget ?? 0,
  budgetMax: l.maxBudget ?? 0,
  propertyType: '',
  bedrooms: l.bedrooms ?? 0,
  timeline: humanize(l.timeline) ?? '',
  financingStatus: humanize(l.financingStatus) ?? '',
  preapprovalStatus: l.financingStatus === 'pre_approved',
  score: l.score,
  temperature: (l.temperature as LeadTemperature) ?? 'cold',
  consentStatus: l.consentStatus as Lead['consentStatus'],
  dncStatus: l.dncStatus,
  createdAt: l.createdAt,
  updatedAt: l.updatedAt,
  notes: humanize(l.motivation) ?? undefined,
  customFields: l.customFields,
});

type Tab = 'all' | LeadTemperature | 'new' | 'booked';
const TABS: readonly Tab[] = ['all', 'hot', 'warm', 'cold', 'new', 'booked'];

/** Poll cadence while the live stream is connected. Module-level, so it is one stable object. */
const STREAM_UP_CADENCE = { baseIntervalMs: 60_000, maxIntervalMs: 60_000 } as const;

interface LeadsViewProps {
  onOpenNewLead: () => void;
}

export const LeadsView: React.FC<LeadsViewProps> = ({ onOpenNewLead }) => {
  // Set when the reader takes leads: their own entry in the agent filter reads "Mine".
  const { agentProfileId, role } = useAuth();
  const isOwner = role === 'owner';
  const {
    setSelectedLeadId,
    setPreCallLeadId,
    registerExternalLeads,
  } = useApp();

  const [searchQuery, setSearchQuery] = useState('');
  // ?tab=hot etc. lets other screens (the dashboard) open Leads pre-filtered.
  const { search } = useLocation();
  const [selectedTab, setSelectedTab] = useState<Tab>(() => {
    const t = new URLSearchParams(search).get('tab') as Tab | null;
    return t && TABS.includes(t) ? t : 'all';
  });
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [agentFilter, setAgentFilter] = useState<string>('all');

  // One fetch, both payloads. They are always read together, so a failure in
  // either has to be a failure of the pair — a lead list rendered beside counts
  // from a minute ago is worse than a moment of staleness in both.
  const load = useCallback(async () => {
    const [leads, stats] = await Promise.all([leadsApi.list(), leadsApi.stats()]);
    return { leads, stats };
  }, []);

  // The push path. The backend knows the moment a submission becomes a lead, so
  // this screen is told rather than asked to guess. Subscribed before the query
  // because the query's cadence depends on whether the stream is up. The handler
  // only runs after render, by when `invalidate` below exists, and useLiveEvents
  // reads it through a ref, so an inline handler costs no reconnect.
  const { connected } = useLiveEvents((e) => {
    if (e.type === 'lead.created' || e.type === 'lead.assigned') invalidate();
  });

  // Stream up: it reports every change as it happens, so the poll is only a
  // safety net — once a minute, and an event or a return to the tab refetches
  // without dropping back to 5-second polling. Stream down: the default
  // 5-second poll backing off to a minute, the reliability fallback as before.
  const { data, error, refreshing, stale, refresh, invalidate } = useLiveQuery(
    load,
    connected ? STREAM_UP_CADENCE : undefined,
  );

  // This tab's own assignments refetch at once, stream or no stream.
  useEffect(() => {
    const onChanged = (): void => invalidate();
    window.addEventListener(LEADS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(LEADS_CHANGED_EVENT, onChanged);
  }, [invalidate]);

  const rows = data?.leads ?? [];
  const stats: LeadStats | null = data?.stats ?? null;

  const [savingStatus, setSavingStatus] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<{ id: string; message: string } | null>(null);

  const changeStatus = async (id: string, status: LeadStatus): Promise<void> => {
    setSavingStatus(id);
    setStatusError(null);
    try {
      await leadsApi.setStatus(id, status);
      invalidate();
    } catch (e) {
      setStatusError({ id, message: messageFor(e) });
    } finally {
      setSavingStatus(null);
    }
  };

  const mapped = useMemo(() => {
    const byId: Record<string, Lead> = {};
    for (const l of rows) byId[l.id] = toLead(l);
    return byId;
  }, [rows]);

  // Register with the context so the detail and pre-call modals — which look a
  // lead up by id — can resolve a row that is not in the demo store.
  useEffect(() => {
    registerExternalLeads(Object.values(mapped));
  }, [mapped, registerExternalLeads]);

  // Source options come from what has actually arrived rather than a hardcoded
  // list: a source exists here only once a form has been connected to it.
  const sourceOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const l of rows) if (l.source) seen.set(l.source.id, l.source.name);
    return [...seen].map(([id, name]) => ({ id, name }));
  }, [rows]);

  // Agent options from real assignments, like the source options above: an
  // agent appears once they hold a lead. The reader's own entry, when they take
  // leads, is first and reads "Mine".
  const agentOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const l of rows) {
      if (l.assignedAgent) seen.set(l.assignedAgent.id, l.assignedAgent.id === agentProfileId ? 'Mine' : l.assignedAgent.name);
    }
    return [...seen]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => Number(b.id === agentProfileId) - Number(a.id === agentProfileId) || a.name.localeCompare(b.name));
  }, [rows, agentProfileId]);

  const filteredLeads = rows.filter(lead => {
    // Tab filter
    if (selectedTab === 'hot' && lead.temperature !== 'hot') return false;
    if (selectedTab === 'warm' && lead.temperature !== 'warm') return false;
    if (selectedTab === 'cold' && lead.temperature !== 'cold') return false;
    if (selectedTab === 'new' && lead.status !== 'new') return false;
    if (selectedTab === 'booked' && normalizeStatus(lead.status) !== 'appointment_booked') return false;

    // Source filter
    if (sourceFilter !== 'all' && lead.source?.id !== sourceFilter) return false;

    // Agent filter
    if (agentFilter === 'unassigned' && lead.assignedAgent) return false;
    if (agentFilter !== 'all' && agentFilter !== 'unassigned' && lead.assignedAgent?.id !== agentFilter) return false;

    // Search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const haystack = [fullName(lead), lead.phone, lead.email, lead.location]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }

    return true;
  });

  const openLead = (lead: LiveLead) => setSelectedLeadId(lead.id);

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto text-slate-100">

      {/* Top Header & Search Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-bold text-white tracking-tight">Leads</h2>
            {/*
              Says which mechanism is actually feeding the table. "Live" means the
              event stream is open and a new lead lands here the moment it is
              created; "Polling" means we fell back and it may take up to a
              minute. Worth showing, because the difference is visible to the
              user as latency and would otherwise look like a bug.
            */}
            <span
              title={
                connected
                  ? 'Connected to the live event stream — new leads appear as they arrive.'
                  : 'Event stream not connected; falling back to periodic refresh.'
              }
              className={`text-2xs font-bold uppercase px-2 py-0.5 rounded-full border flex items-center gap-1 ${
                connected
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                  : 'bg-slate-800 text-slate-400 border-slate-700'
              }`}
            >
              <Radio className={`w-3 h-3 ${connected ? '' : 'opacity-60'}`} />
              {connected ? 'Live' : 'Polling'}
            </span>
          </div>
          <p className="text-xs text-slate-400">
            {stats?.total ?? rows.length} total buyer leads ingested from your connected forms
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={refresh}
            title="Refresh"
            className="p-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-400 hover:text-white transition-colors cursor-pointer"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          </button>

          <button
            onClick={onOpenNewLead}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-on-accent rounded-xl text-xs font-semibold shadow-md shadow-emerald-950 flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>Add New Lead</span>
          </button>
        </div>
      </div>

      {/*
        Two different failures, deliberately shown differently.

        `stale` means the table below is real data that simply stopped updating —
        a quiet amber line, because the screen is still usable and shouting about
        it is what made a transient blip read as an outage. The rose block is
        reserved for having nothing to show at all.
      */}
      {stale ? (
        <div className="flex items-center gap-2 text-xs text-amber-300/90 px-1">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>
            Showing the last data we loaded — reconnecting. ({error})
          </span>
        </div>
      ) : error ? (
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-2xl p-4 flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" />
          <div className="text-xs text-rose-200">
            <div className="font-semibold text-rose-100">Live leads unavailable</div>
            {error}
          </div>
        </div>
      ) : null}

      {/* Filter Tabs & Search Controls */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 space-y-4 shadow-lg">

        {/* Filter Tabs */}
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 pb-3">
          {[
            { id: 'all', label: `All Leads (${rows.length})` },
            { id: 'hot', label: `🔥 Hot (${rows.filter(l => l.temperature === 'hot').length})` },
            { id: 'warm', label: `☀️ Warm (${rows.filter(l => l.temperature === 'warm').length})` },
            { id: 'cold', label: `❄️ Cold (${rows.filter(l => l.temperature === 'cold').length})` },
            { id: 'new', label: `New Inbound (${rows.filter(l => l.status === 'new').length})` },
            { id: 'booked', label: `Appointments (${rows.filter(l => normalizeStatus(l.status) === 'appointment_booked').length})` },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setSelectedTab(tab.id as Tab)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                selectedTab === tab.id
                  ? 'bg-emerald-600/20 text-emerald-300 border border-emerald-500/40 font-semibold'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Search & Select dropdowns */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3 text-xs">

          <div className="md:col-span-6 relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by name, phone, email, or submarket..."
              className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-4 py-2 text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
            />
          </div>

          <div className="md:col-span-3">
            <select
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-300 focus:outline-none focus:border-emerald-500"
            >
              <option value="all">All Lead Sources</option>
              {sourceOptions.map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>

          <div className="md:col-span-3">
            <select
              value={agentFilter}
              onChange={(e) => setAgentFilter(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-300 focus:outline-none focus:border-emerald-500"
            >
              <option value="all">All Assigned Agents</option>
              <option value="unassigned">Unassigned</option>
              {agentOptions.map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>

        </div>

      </div>

      {/* Leads Table (PRD Section 37) */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-950 text-slate-400 uppercase font-semibold text-2xs tracking-wider border-b border-slate-800">
              <tr>
                <th className="px-4 py-3.5">Lead / Contact</th>
                <th className="px-4 py-3.5">Temperature</th>
                <th className="px-4 py-3.5">Target Budget & Location</th>
                <th className="px-4 py-3.5">Timeline</th>
                <th className="px-4 py-3.5">Assigned Agent</th>
                <th className="px-4 py-3.5">Status</th>
                <th className="px-4 py-3.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {data === null ? (
                // Skeleton rows in the table's own shape while the first fetch runs.
                Array.from({ length: 6 }, (_, i) => (
                  <tr key={i} aria-hidden="true" className="animate-pulse">
                    <td className="px-4 py-4">
                      <div className="h-3.5 w-32 rounded bg-slate-800" />
                      <div className="h-3 w-44 rounded bg-slate-800/70 mt-2" />
                    </td>
                    {[16, 28, 20, 24, 20, 10].map((w, j) => (
                      <td key={j} className="px-4 py-4">
                        <div className="h-3.5 rounded bg-slate-800/80" style={{ width: `${w * 4}px` }} />
                      </td>
                    ))}
                  </tr>
                ))
              ) : filteredLeads.length > 0 ? (
                filteredLeads.map(lead => (
                  <tr
                    key={lead.id}
                    className="hover:bg-slate-800/40 transition-colors group cursor-pointer"
                    onClick={() => openLead(lead)}
                  >
                    {/* Name & Contact */}
                    <td className="px-4 py-3.5">
                      <div className="space-y-0.5">
                        <div className="font-semibold text-slate-100 group-hover:text-emerald-400 transition-colors flex items-center gap-2">
                          <span>{fullName(lead)}</span>
                          <span
                            title={lead.source?.name ?? undefined}
                            className="text-2xs font-medium px-1.5 rounded bg-slate-800 text-slate-400"
                          >
                            {sourceLabel(lead)}
                          </span>
                          {lead.contactLeadCount > 1 && (
                            // Replaces "N submissions merged". Submissions are
                            // no longer folded into one lead — a public form is
                            // filled in by different people, and merging them
                            // overwrote one prospect's answers with another's.
                            // Repeats are surfaced instead of resolved: the
                            // rows stay separate and a human decides.
                            <span
                              title={`${lead.contactLeadCount} leads in your pipeline share this phone number or email. Each submission is kept as its own lead — check the others before calling.`}
                              className="text-2xs text-amber-300 font-normal"
                            >
                              repeat contact ({lead.contactLeadCount})
                            </span>
                          )}
                          {lead.needsReview && (
                            <span
                              title={lead.reviewReasons.join('\n')}
                              className="text-2xs font-bold uppercase px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40"
                            >
                              review
                            </span>
                          )}
                        </div>
                        {/* One contact line: only what the lead actually has. */}
                        <div className="text-xs text-slate-400 flex items-center gap-1.5 min-w-0">
                          {lead.phone && (
                            <span className="flex items-center gap-1 shrink-0">
                              {lead.phone}
                              {!lead.phoneValid && (
                                // Surfaced because such a lead must never be auto-dialed.
                                <span title="Phone could not be parsed — excluded from dialing">
                                  <ShieldAlert className="w-3 h-3 text-amber-400" />
                                </span>
                              )}
                            </span>
                          )}
                          {lead.phone && lead.email && <span className="text-slate-600">·</span>}
                          {lead.email && (
                            <span className="flex items-center gap-1 min-w-0">
                              <span className="truncate max-w-[200px]">{lead.email}</span>
                              {!lead.emailValid && (
                                // Stored, but never used to match this lead to
                                // another — see the email_valid guard in createLead.
                                <span title="Not a usable address — excluded from matching and email outreach">
                                  <ShieldAlert className="w-3 h-3 text-amber-400 shrink-0" />
                                </span>
                              )}
                            </span>
                          )}
                          {!lead.phone && !lead.email && DASH}
                        </div>
                      </div>
                    </td>

                    {/* Temperature (Hot / Warm / Cold) — no numeric score in Milestone 2 */}
                    <td className="px-4 py-3.5">
                      <span
                        title={lead.temperature ? undefined : 'Not rated yet — the AI call rates the lead'}
                        className={`text-xs font-bold uppercase px-2 py-0.5 rounded-full inline-flex items-center gap-1 ${temperatureTone(lead.temperature)}`}
                      >
                        {lead.temperature === 'hot' && <Flame className="w-3 h-3 text-rose-400" />}
                        {lead.temperature ?? DASH}
                      </span>
                    </td>

                    {/* Target Budget & Location */}
                    <td className="px-4 py-3.5">
                      <div className="space-y-0.5">
                        <div className="font-bold text-emerald-400 font-mono">
                          {budgetRange(lead)}
                        </div>
                        <div className="text-xs text-slate-300 truncate max-w-[150px]">
                          {lead.location ?? DASH}
                        </div>
                      </div>
                    </td>

                    {/* Timeline */}
                    <td className="px-4 py-3.5">
                      <span className="text-slate-200 font-medium">
                        {humanize(lead.timeline) ?? DASH}
                      </span>
                    </td>

                    {/* Agent — the current assignment, or honestly unassigned. */}
                    <td className="px-4 py-3.5">
                      {lead.assignedAgent ? (
                        <div className="flex items-center gap-1.5" title={`Assigned ${lead.assignedAgent.assignmentType} · ${new Date(lead.assignedAgent.assignedAt).toLocaleString()}`}>
                          <div className="w-5 h-5 rounded-full bg-emerald-500/15 border border-emerald-500/40 text-2xs font-bold text-emerald-300 flex items-center justify-center">
                            {initialsOf(lead.assignedAgent.name)}
                          </div>
                          <span className="text-slate-200 font-medium">
                            {lead.assignedAgent.id === agentProfileId ? 'You' : lead.assignedAgent.name}
                          </span>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1.5">
                          <div className="w-5 h-5 rounded-full border border-dashed border-slate-700 text-2xs font-bold text-slate-500 flex items-center justify-center">
                            {DASH}
                          </div>
                          <span className="text-slate-500">Unassigned</span>
                        </div>
                      )}
                    </td>

                    {/* Status — hover shows why (e.g. a failed/unanswered call) */}
                    <td className="px-4 py-3.5" onClick={(e) => e.stopPropagation()}>
                      {isOwner ? (
                        // Owner-only: the API refuses anyone else. The only way
                        // into 'closed', and the correction path for automation.
                        <select
                          value={normalizeStatus(lead.status, lead.dncStatus)}
                          disabled={savingStatus === lead.id}
                          onChange={(e) => void changeStatus(lead.id, e.target.value as LeadStatus)}
                          title={lead.statusReason || 'Change status'}
                          className={`text-xs px-2 py-0.5 rounded-md font-mono uppercase cursor-pointer focus:outline-none disabled:opacity-50 ${statusTone(lead.status)}`}
                        >
                          {LEAD_STATUSES.map((s) => (
                            <option key={s} value={s} className="bg-slate-900 text-slate-200 normal-case">
                              {STATUS_LABELS[s]}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span
                          title={lead.statusReason || undefined}
                          className={`text-xs px-2 py-0.5 rounded-md font-mono uppercase ${statusTone(lead.status)}${lead.statusReason ? ' cursor-help underline decoration-dotted decoration-slate-500 underline-offset-2' : ''}`}
                        >
                          {statusLabel(lead.status)}
                        </span>
                      )}
                      {statusError?.id === lead.id && (
                        <p className="text-2xs text-rose-400 mt-1">{statusError.message}</p>
                      )}
                    </td>

                    {/* Actions */}
                    <td className="px-4 py-3.5 text-right">
                      <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
                        {lead.temperature === 'hot' && (
                          <button
                            onClick={() => setPreCallLeadId(lead.id)}
                            title="Agent Pre-Call Briefing"
                            className="p-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 transition-colors cursor-pointer"
                          >
                            <Flame className="w-3.5 h-3.5 text-rose-400" />
                          </button>
                        )}

                        <button
                          onClick={() => openLead(lead)}
                          title="Open Full Dossier"
                          className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition-colors cursor-pointer"
                        >
                          <ChevronRight className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              ) : rows.length === 0 && !error ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center space-y-2">
                    <Webhook className="w-6 h-6 text-slate-600 mx-auto" />
                    <div className="text-xs text-slate-400">No live leads yet.</div>
                    <div className="text-xs text-slate-500 max-w-md mx-auto leading-relaxed">
                      Connect a form under <strong className="text-slate-400">Lead Sources</strong> and
                      submit it — a lead appears here within a couple of seconds, with status{' '}
                      <span className="text-cyan-300 font-semibold">new</span>.
                    </div>
                  </td>
                </tr>
              ) : (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-slate-500">
                    No leads match the selected criteria.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
};
