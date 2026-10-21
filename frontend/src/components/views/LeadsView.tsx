import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Ban,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Contact,
  FileSpreadsheet,
  FileUp,
  Flame,
  Hourglass,
  Pause,
  PenLine,
  Plus,
  Radio,
  RefreshCw,
  Rocket,
  Search,
  ShieldAlert,
  Snowflake,
  Sun,
  Users,
  Webhook,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { LEADS_CHANGED_EVENT, leadsApi, type LeadStats, type ListLeadsParams, type LiveLead } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useLiveEvents } from '../../lib/liveEvents';
import { fileImportEnabled } from '../../utils/fileImportApi';
import { startLabel } from '../../utils/outreachApi';
import { FileImportModal } from '../imports/FileImportModal';
import { NewLeadModal } from '../modals/NewLeadModal';
import { PAGE_SIZE_OPTIONS, Pagination } from '../common/Pagination';
import { useLiveQuery } from '../../lib/useLiveQuery';
import { Lead, LeadTemperature } from '../../types';
import { followUpReasonLabel, normalizeStatus, statusLabel, statusTone } from '../../lib/leadStatus';
import { formatDateTime } from '../../lib/datetime';

/**
 * Lead pipeline — live rows only.
 *
 * The demo pipeline that used to render here came from AppContext's localStorage
 * store, and a second "Live Leads" panel sat above it. Both are gone: this table
 * shows exactly what the backend holds. A row carries only what the pipeline is
 * worked by — who, the number to call, how hot, their budget, where they came from,
 * who holds them, where they stand — and the dossier has the rest (email, location,
 * timeline, the form's answers).
 * A fact with nothing behind it yet renders a muted dash instead of being dropped.
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

/** "$250k – $400k", "$250k+", "up to $400k"; null when the lead gave no budget. */
const budgetRange = (l: LiveLead): string | null => {
  const { minBudget: lo, maxBudget: hi } = l;
  if (lo !== null && hi !== null) return lo === hi ? thousands(lo) : `${thousands(lo)} – ${thousands(hi)}`;
  if (lo !== null) return `${thousands(lo)}+`;
  if (hi !== null) return `up to ${thousands(hi)}`;
  return null;
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
  // API (Tally), SYNC (Google Sheets) and UPLOAD (a file) name their provider.
  const method = (s.connectionMethod ?? '').toUpperCase();
  if ((method === 'API' || method === 'SYNC' || method === 'UPLOAD') && s.provider) return s.provider.toLowerCase().replace(/_/g, ' ');
  // MANUAL means a webhook URL the owner set up by hand (the Webhook card, a pasted form URL), not a lead typed in;
  // `type` is the provider ("custom", "tally"), so it is not used here.
  return 'webhook';
};

/**
 * The channel as a glyph, so a column of sources is told apart at a glance
 * without a colour per source: colour in this table already means urgency
 * (temperature) and lifecycle (status), and a third rainbow would drown both.
 * Same icons the rest of the app uses for each channel (Lead Sources, the
 * Google Sheets card, the file import).
 */
const sourceIcon = (l: LiveLead): LucideIcon => {
  const s = l.source;
  // Only a lead typed in has no source: the pen. A MANUAL source is a hand-set webhook URL, so it falls to the webhook glyph.
  if (!s) return PenLine;
  switch ((s.connectionMethod ?? '').toUpperCase()) {
    case 'API':
      return Radio;
    case 'SYNC':
      // A connected CRM syncs too; only a spreadsheet gets the sheet glyph.
      return (s.provider ?? '').toUpperCase() === 'HUBSPOT' ? Contact : FileSpreadsheet;
    case 'UPLOAD':
      return FileUp;
    default:
      return Webhook;
  }
};

/**
 * Why a row deserves a second look, as one icon's tooltip: an answer we could
 * not store, a contact shared with other leads, a phone or email we cannot use.
 * The row only says "look"; the dossier has the detail.
 */
const attentionReasons = (l: LiveLead): string[] => [
  ...(l.needsReview ? l.reviewReasons : []),
  // Submissions are not folded into one lead — a public form is filled in by
  // different people — so a repeated contact is surfaced and a human decides.
  ...(l.contactLeadCount > 1
    ? [`${l.contactLeadCount} leads in your pipeline share this phone number or email. Each submission is kept as its own lead — check the others before calling.`]
    : []),
  // Such a lead must never be auto-dialed.
  ...(l.phone && !l.phoneValid ? ['Phone could not be parsed — excluded from dialing.'] : []),
  // Stored, but never used to match this lead to another — see the email_valid guard in createLead.
  ...(l.email && !l.emailValid ? ['Not a usable email address — excluded from matching and email outreach.'] : []),
];

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
  status: normalizeStatus(l.status),
  followUpReason: l.followUpReason,
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

const SKIP_TEXT: Record<string, string> = {
  DO_NOT_CONTACT: 'opted out',
  STATUS_CHANGED: 'already being worked',
  NO_DIALABLE_PHONE: 'no dialable phone',
  ALREADY_RELEASED: 'already in outreach',
};

/** The line under a lead's status that says where it stands with outreach, or null. */
function outreachLine(o: LiveLead['outreach']): { Icon: LucideIcon; text: string; title: string; tone: string } | null {
  if (!o) return null;
  switch (o.state) {
    case 'scheduled':
      return { Icon: CalendarClock, text: `Scheduled · ${startLabel(o.startAt, o.timeZone)}`, title: 'Approved in a scheduled outreach batch: released at this time', tone: 'text-sky-300' };
    case 'waiting':
      return { Icon: Hourglass, text: 'Waiting for a call slot', title: 'Its batch has started; it is released when a call slot is free and the contact window is open', tone: 'text-amber-300' };
    case 'released':
      return { Icon: Rocket, text: 'Released · strategy starting', title: 'Released by its batch: the outreach strategy picks it up within seconds', tone: 'text-emerald-300' };
    case 'skipped':
      return { Icon: Ban, text: `Skipped · ${SKIP_TEXT[o.reason ?? ''] ?? 'not contacted'}`, title: 'Approved in a batch but not contacted', tone: 'text-slate-400' };
    case 'paused':
      return { Icon: Pause, text: 'Outreach paused', title: 'Nothing automated contacts this lead until it is released', tone: 'text-slate-400' };
  }
}

type Tab = 'all' | LeadTemperature | 'new' | 'booked';
const TABS: readonly Tab[] = ['all', 'hot', 'warm', 'cold', 'new', 'booked'];

/** Poll cadence while the live stream is connected. Module-level, so it is one stable object. */
const STREAM_UP_CADENCE = { baseIntervalMs: 60_000, maxIntervalMs: 60_000 } as const;

const PAGE_SIZE_KEY = 'ep_leads_page_size';
const SEARCH_DEBOUNCE_MS = 300;

/** The value, `delay` ms after it last changed — so search does not fire per keystroke. */
function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** The remembered rows-per-page, or the smallest size. */
function readPageSize(): number {
  try {
    const stored = Number(localStorage.getItem(PAGE_SIZE_KEY));
    return (PAGE_SIZE_OPTIONS as readonly number[]).includes(stored) ? stored : PAGE_SIZE_OPTIONS[0];
  } catch {
    return PAGE_SIZE_OPTIONS[0];
  }
}

/** What a tab asks the server for. */
const TAB_FILTER: Record<Tab, Pick<ListLeadsParams, 'status' | 'temperature'>> = {
  all: {},
  hot: { temperature: 'hot' },
  warm: { temperature: 'warm' },
  cold: { temperature: 'cold' },
  new: { status: 'new' },
  booked: { status: 'appointment_booked' },
};

export const LeadsView: React.FC = () => {
  // Set when the reader takes leads: their own entry in the agent filter reads "Mine".
  const { agentProfileId, role } = useAuth();
  const isOwner = role === 'owner';
  // "Add leads" (owner only): one lead typed in by hand, or a file import where the server has it switched on.
  const [canImport, setCanImport] = useState(false);
  const [addMenu, setAddMenu] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  useEffect(() => {
    if (isOwner) void fileImportEnabled().then(setCanImport);
  }, [isOwner]);
  const {
    setSelectedLeadId,
    setPreCallLeadId,
    registerExternalLeads,
  } = useApp();

  const [searchQuery, setSearchQuery] = useState('');
  const debouncedSearch = useDebounced(searchQuery, SEARCH_DEBOUNCE_MS);
  // ?tab=hot etc. lets other screens (the dashboard) open Leads pre-filtered.
  const { search } = useLocation();
  const [selectedTab, setSelectedTab] = useState<Tab>(() => {
    const t = new URLSearchParams(search).get('tab') as Tab | null;
    return t && TABS.includes(t) ? t : 'all';
  });
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [agentFilter, setAgentFilter] = useState<string>('all');
  // Search, filters and paging all happen server-side; any change of filter starts over at the first page.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(readPageSize);
  useEffect(() => setPage(1), [debouncedSearch, selectedTab, sourceFilter, agentFilter, pageSize]);

  const params = useMemo<ListLeadsParams>(
    () => ({
      page,
      limit: pageSize,
      search: debouncedSearch,
      ...TAB_FILTER[selectedTab],
      sourceId: sourceFilter === 'all' ? undefined : sourceFilter,
      agentId: agentFilter === 'all' || agentFilter === 'unassigned' ? undefined : agentFilter,
      unassigned: agentFilter === 'unassigned',
    }),
    [page, pageSize, debouncedSearch, selectedTab, sourceFilter, agentFilter],
  );

  // One fetch, both payloads. They are always read together, so a failure in
  // either has to be a failure of the pair — a lead list rendered beside counts
  // from a minute ago is worse than a moment of staleness in both.
  const load = useCallback(async () => {
    const [leads, stats] = await Promise.all([leadsApi.list(params), leadsApi.stats()]);
    return { leads, stats };
  }, [params]);

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
  // A new page or filter is a different question, so its key discards the old rows and asks at once.
  const { data, error, refreshing, stale, refresh, invalidate } = useLiveQuery(load, {
    ...(connected ? STREAM_UP_CADENCE : {}),
    refreshKey: JSON.stringify(params),
  });

  // This tab's own assignments refetch at once, stream or no stream.
  useEffect(() => {
    const onChanged = (): void => invalidate();
    window.addEventListener(LEADS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(LEADS_CHANGED_EVENT, onChanged);
  }, [invalidate]);

  const rows = data?.leads.data ?? [];
  const meta = data?.leads.meta ?? null;
  const stats: LeadStats | null = data?.stats ?? null;

  // The last row of the last page went away (reassigned, filtered out): step back to a page that has rows.
  useEffect(() => {
    if (meta && meta.count === 0 && meta.page > 1 && meta.total > 0) setPage(meta.totalPages);
  }, [meta]);

  const changePageSize = (size: number): void => {
    setPageSize(size);
    try {
      localStorage.setItem(PAGE_SIZE_KEY, String(size));
    } catch {
      /* the choice just will not be remembered */
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
  // list: a source exists here only once it holds a lead. The server lists them
  // across every page, not just the one on screen.
  const sourceOptions = stats?.sources ?? [];

  // Agent options from real assignments, like the source options above: an
  // agent appears once they hold a lead. The reader's own entry, when they take
  // leads, is first and reads "Mine".
  const agentOptions = useMemo(
    () =>
      (stats?.agents ?? [])
        .map((a) => ({ id: a.id, name: a.id === agentProfileId ? 'Mine' : a.name }))
        .sort((a, b) => Number(b.id === agentProfileId) - Number(a.id === agentProfileId) || a.name.localeCompare(b.name)),
    [stats, agentProfileId],
  );

  // Tab counts cover every lead, not the page on screen; hidden until the first answer arrives.
  const tabCount = (n: number | undefined): string => (stats ? ` (${n ?? 0})` : '');

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

          {isOwner && (
            <div
              className="relative"
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setAddMenu(false);
              }}
            >
              <button
                type="button"
                onClick={() => setAddMenu((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={addMenu}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-on-accent rounded-xl text-xs font-semibold shadow-md shadow-emerald-950 flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>Add leads</span>
                <ChevronDown className="w-3.5 h-3.5" />
              </button>
              {addMenu && (
                <div
                  role="menu"
                  className="absolute right-0 mt-1 w-56 bg-slate-900 border border-slate-800 rounded-xl shadow-xl p-1 z-20 text-xs"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setAddMenu(false);
                      setAddOpen(true);
                    }}
                    className="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-800 text-slate-100 flex items-center gap-2 cursor-pointer"
                  >
                    <PenLine className="w-3.5 h-3.5 text-emerald-300" />
                    <span>
                      Add a lead
                      <span className="block text-2xs text-slate-500">Type in one person's details</span>
                    </span>
                  </button>
                  {canImport && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setAddMenu(false);
                        setImportOpen(true);
                      }}
                      className="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-800 text-slate-100 flex items-center gap-2 cursor-pointer"
                    >
                      <FileUp className="w-3.5 h-3.5 text-sky-300" />
                      <span>
                        Import from CSV / Excel
                        <span className="block text-2xs text-slate-500">Reviewed before anyone is contacted</span>
                      </span>
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          {addOpen && <NewLeadModal onClose={() => setAddOpen(false)} onCreated={() => refresh()} />}
          {importOpen && (
            <FileImportModal
              onClose={() => setImportOpen(false)}
              onImported={() => {
                // Approved leads appear here; the rest are on Import Review.
                refresh();
              }}
            />
          )}
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
            { id: 'all', icon: null, label: `All Leads${tabCount(stats?.total)}` },
            { id: 'hot', icon: <Flame className="w-3.5 h-3.5" />, label: `Hot${tabCount(stats?.byTemperature.hot)}` },
            { id: 'warm', icon: <Sun className="w-3.5 h-3.5" />, label: `Warm${tabCount(stats?.byTemperature.warm)}` },
            { id: 'cold', icon: <Snowflake className="w-3.5 h-3.5" />, label: `Cold${tabCount(stats?.byTemperature.cold)}` },
            { id: 'new', icon: null, label: `New Inbound${tabCount(stats?.byStatus.new)}` },
            { id: 'booked', icon: null, label: `Appointments${tabCount(stats?.byStatus.appointment_booked)}` },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setSelectedTab(tab.id as Tab)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer inline-flex items-center gap-1.5 ${
                selectedTab === tab.id
                  ? 'bg-emerald-600/20 text-emerald-300 border border-emerald-500/40 font-semibold'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              {tab.icon}
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
              className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-9 py-2 text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label="Clear search"
                className="absolute right-2 top-1.5 p-1 rounded-md text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            )}
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
            <thead className="bg-slate-950/60 text-slate-500 uppercase font-semibold text-2xs tracking-wider border-b border-slate-800">
              <tr>
                <th className="px-4 py-2.5">Lead</th>
                <th className="px-4 py-2.5">Temperature</th>
                <th className="px-4 py-2.5">Budget</th>
                <th className="px-4 py-2.5">Source</th>
                <th className="px-4 py-2.5">Assigned agent</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5 text-right">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {data === null ? (
                // Skeleton rows in the table's own shape while the first fetch runs.
                Array.from({ length: 6 }, (_, i) => (
                  <tr key={i} aria-hidden="true" className="animate-pulse">
                    <td className="px-4 py-3.5">
                      <div className="h-3.5 w-32 rounded bg-slate-800" />
                      <div className="h-3 w-44 rounded bg-slate-800/70 mt-2" />
                    </td>
                    {[14, 20, 16, 24, 28, 10].map((w, j) => (
                      <td key={j} className="px-4 py-3.5">
                        <div className="h-3.5 rounded bg-slate-800/80" style={{ width: `${w * 4}px` }} />
                      </td>
                    ))}
                  </tr>
                ))
              ) : rows.length > 0 ? (
                rows.map(lead => {
                  const attention = attentionReasons(lead);
                  const budget = budgetRange(lead);
                  return (
                    <tr
                      key={lead.id}
                      tabIndex={0}
                      className="hover:bg-slate-800/40 transition-colors group cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500/60"
                      onClick={() => openLead(lead)}
                      onKeyDown={(e) => {
                        // The row itself only: a button inside it already answers its own Enter.
                        if (e.target !== e.currentTarget) return;
                        if (e.key === ' ') e.preventDefault();
                        if (e.key === 'Enter' || e.key === ' ') openLead(lead);
                      }}
                    >
                      {/* Lead: the name, then the number to call (the email when there is none).
                          Anything worth a second look is one icon with the reasons on hover; the
                          dossier has the rest (email, location, timeline, other answers). */}
                      <td className="px-4 py-3.5">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="font-semibold text-slate-100 hover:text-emerald-300 transition-colors truncate">
                            {fullName(lead)}
                          </span>
                          {attention.length > 0 && (
                            <span role="img" aria-label={attention.join(' ')} title={attention.join('\n')} className="shrink-0 cursor-help">
                              <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
                            </span>
                          )}
                        </div>
                        <div className="text-2xs text-slate-400 mt-0.5 truncate max-w-[220px]">
                          {lead.phone || lead.email || <span className="text-slate-600">{DASH}</span>}
                        </div>
                      </td>

                      {/* Temperature (Hot / Warm / Cold) — no numeric score in Milestone 2 */}
                      <td className="px-4 py-3.5">
                        <span
                          title={lead.temperature ? undefined : 'Not classified yet — the AI call classifies the lead'}
                          className={`text-xs font-bold uppercase px-2 py-0.5 rounded-full inline-flex items-center gap-1 whitespace-nowrap ${temperatureTone(lead.temperature)}`}
                        >
                          {lead.temperature === 'hot' && <Flame className="w-3 h-3 text-rose-400" />}
                          {lead.temperature ?? 'Not classified'}
                        </span>
                      </td>

                      {/* Budget — what they said they can spend. A value, not a call to action. */}
                      <td className="px-4 py-3.5">
                        {budget ? (
                          <span className="text-slate-200 font-medium whitespace-nowrap">{budget}</span>
                        ) : (
                          <span className="text-slate-600">{DASH}</span>
                        )}
                      </td>

                      {/* Source — where the lead actually came from (see sourceLabel); the form's own name on hover. */}
                      <td className="px-4 py-3.5">
                        {(() => {
                          const SourceIcon = sourceIcon(lead);
                          return (
                            <span title={lead.source?.name ?? undefined} className="inline-flex items-center gap-1.5 text-slate-200 font-medium capitalize whitespace-nowrap">
                              <SourceIcon className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                              {sourceLabel(lead)}
                            </span>
                          );
                        })()}
                      </td>

                      {/* Agent — the current assignment, or honestly unassigned. */}
                      <td className="px-4 py-3.5">
                        {lead.assignedAgent ? (
                          <div className="flex items-center gap-1.5" title={`Assigned ${lead.assignedAgent.assignmentType} · ${formatDateTime(lead.assignedAgent.assignedAt)}`}>
                            <div className="w-5 h-5 rounded-full bg-emerald-500/15 border border-emerald-500/40 text-2xs font-bold text-emerald-300 flex items-center justify-center">
                              {initialsOf(lead.assignedAgent.name)}
                            </div>
                            <span className="text-slate-200 font-medium">
                              {lead.assignedAgent.id === agentProfileId ? 'You' : lead.assignedAgent.name}
                            </span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            <div className="w-5 h-5 rounded-full border border-dashed border-slate-700 text-2xs font-bold text-slate-600 flex items-center justify-center">
                              {DASH}
                            </div>
                            <span className="text-slate-500">Unassigned</span>
                          </div>
                        )}
                      </td>

                      {/* Status — read-only pill; hover shows why (e.g. a failed/unanswered call) */}
                      <td className="px-4 py-3.5">
                        <span
                          title={lead.statusReason || undefined}
                          className={`inline-block whitespace-nowrap text-xs px-2 py-0.5 rounded-md font-mono uppercase ${statusTone(lead.status)}${lead.statusReason ? ' cursor-help underline decoration-dotted decoration-slate-500 underline-offset-2' : ''}`}
                        >
                          {statusLabel(lead.status)}
                        </span>
                        {followUpReasonLabel(lead.status, lead.followUpReason) && (
                          <p className="text-2xs text-slate-400 mt-1">
                            {followUpReasonLabel(lead.status, lead.followUpReason)}
                          </p>
                        )}
                        {(() => {
                          const line = outreachLine(lead.outreach);
                          return line ? (
                            <p className={`text-2xs mt-1 flex items-center gap-1 whitespace-nowrap ${line.tone}`} title={line.title}>
                              <line.Icon className="w-3 h-3 shrink-0" aria-hidden="true" />
                              {line.text}
                            </p>
                          ) : null;
                        })()}
                      </td>

                      {/* Actions */}
                      <td className="px-4 py-3.5 text-right">
                        <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
                          {lead.temperature === 'hot' && (
                            <button
                              onClick={() => setPreCallLeadId(lead.id)}
                              title="Agent Pre-Call Briefing"
                              className="h-7 w-7 flex items-center justify-center rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 opacity-60 group-hover:opacity-100 focus-visible:opacity-100 transition cursor-pointer"
                            >
                              <Flame className="w-3.5 h-3.5 text-rose-400" />
                            </button>
                          )}

                          <button
                            onClick={() => openLead(lead)}
                            title="Open Full Dossier"
                            className="h-7 w-7 flex items-center justify-center rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white opacity-60 group-hover:opacity-100 focus-visible:opacity-100 transition cursor-pointer"
                          >
                            <ChevronRight className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              ) : stats?.total === 0 && !error ? (
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

      {/* Outside the card: its overflow-hidden would clip the rows-per-page menu, which opens upwards. */}
      {meta && (
        <Pagination
          meta={meta}
          itemLabel={meta.total === 1 ? 'lead' : 'leads'}
          disabled={refreshing}
          onPageChange={setPage}
          onPageSizeChange={changePageSize}
        />
      )}

    </div>
  );
};
