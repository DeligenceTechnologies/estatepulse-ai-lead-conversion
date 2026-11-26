import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BellRing,
  CalendarClock,
  Flag,
  Flame,
  Inbox,
  PhoneCall,
  PhoneOff,
  Thermometer,
  Timer,
  TrendingDown,
  TrendingUp,
  UserCheck,
  Users,
  Webhook,
} from 'lucide-react';
import { messageFor } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import { getOwnerDashboard, type OwnerDashboard } from '../../utils/dashboardApi';
import { listMembers, memberName, type OrganizationMember } from '../../utils/agentsApi';
import { Panel } from '../common/Panel';
import { Button } from '../common/Button';
import { Donut, Sparkline, TrendChart, type TrendSeries } from '../dashboard/charts';

/**
 * A group of raw statuses shown as one part of a split bar.
 *
 * Eleven lead statuses and eight call statuses are the database's vocabulary,
 * not the owner's: shown one row each they are nine empty bars and two real
 * ones. Each card folds them into the handful of outcomes an owner acts on.
 */
interface Group {
  key: string;
  label: string;
  /** Fill for this part of the bar and its legend swatch. */
  fill: string;
  statuses: readonly string[];
}
type Part = Omit<Group, 'statuses'> & { value: number };

/**
 * Lead lifecycle, in order, as five stages.
 *
 * Ordered categories, so the four live stages take one hue stepped light-to-dark
 * (validated as an ordinal ramp against the card surface) and brighten as a lead
 * advances; leads that have left the pipeline take the de-emphasis gray.
 */
const STAGES: readonly Group[] = [
  { key: 'new', label: 'New', fill: 'var(--chart-stage-1)', statuses: ['new'] },
  { key: 'working', label: 'In conversation', fill: 'var(--chart-stage-2)', statuses: ['contacting', 'engaged', 'follow_up'] },
  { key: 'interested', label: 'Interested', fill: 'var(--chart-stage-3)', statuses: ['interested', 'appointment_requested'] },
  { key: 'booked', label: 'Booked', fill: 'var(--chart-stage-4)', statuses: ['appointment_booked'] },
  {
    key: 'closed',
    label: 'Closed & lost',
    fill: 'var(--chart-muted)',
    statuses: ['not_interested', 'unresponsive', 'closed', 'invalid'],
  },
];

/** Call results by what they mean for the office, in status colours (good → bad → pending). */
const CALL_OUTCOMES: readonly Group[] = [
  { key: 'answered', label: 'Answered', fill: 'var(--chart-good)', statuses: ['completed'] },
  { key: 'handoff', label: 'Asked for a human', fill: 'var(--chart-info)', statuses: ['handoff_requested'] },
  { key: 'no_answer', label: 'No answer', fill: 'var(--chart-warn)', statuses: ['no_answer'] },
  { key: 'failed', label: 'Failed or blocked', fill: 'var(--chart-bad)', statuses: ['failed', 'dnc'] },
  { key: 'running', label: 'Still running', fill: 'var(--chart-muted)', statuses: ['queued', 'ringing', 'in_progress'] },
];

const TEMPERATURES = [
  { key: 'hot', label: 'Hot', bar: 'bg-rose-400', icon: 'text-rose-300' },
  { key: 'warm', label: 'Warm', bar: 'bg-amber-400', icon: 'text-amber-300' },
  { key: 'cold', label: 'Cold', bar: 'bg-cyan-400', icon: 'text-cyan-300' },
  { key: 'unrated', label: 'Not rated yet', bar: 'bg-slate-500', icon: 'text-slate-400' },
] as const;

/** Anything the vocabulary above does not name — a status added since this file was written. */
const OTHER: Omit<Group, 'statuses'> = { key: 'other', label: 'Other', fill: 'var(--chart-muted-soft)' };

/** Sums raw per-status counts into the groups' parts; unlisted statuses land in "Other". */
const fold = (groups: readonly Group[], counts: Record<string, number>): Part[] => {
  const named = new Set(groups.flatMap((g) => [...g.statuses]));
  const parts = groups.map(({ statuses, ...g }) => ({
    ...g,
    value: statuses.reduce((n, s) => n + (counts[s] ?? 0), 0),
  }));
  const other = Object.entries(counts).reduce((n, [s, v]) => (named.has(s) ? n : n + v), 0);
  return other > 0 ? [...parts, { ...OTHER, value: other }] : parts;
};

const formatDuration = (s: number): string =>
  s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${(s / 3600).toFixed(1)}h`;

const Empty: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="text-xs text-slate-500 leading-relaxed">{children}</p>
);

/** Icon chip colours for the stat tiles. Literal classes, so Tailwind generates them. */
const TILE_TONES = {
  brand: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25',
  sky: 'bg-sky-500/10 text-sky-300 border-sky-500/25',
  rose: 'bg-rose-500/10 text-rose-300 border-rose-500/25',
  violet: 'bg-violet-500/10 text-violet-300 border-violet-500/25',
} as const;

/** Icon colours for the "Needs your attention" items. */
const ATTENTION_TONES = {
  rose: 'bg-rose-500/10 text-rose-300 border-rose-500/25',
  amber: 'bg-amber-500/10 text-amber-300 border-amber-500/25',
  sky: 'bg-sky-500/10 text-sky-300 border-sky-500/25',
} as const;

/** A headline number: icon, label, value with its week-on-week change, one hint line, and an optional sparkline. */
const StatTile: React.FC<{
  label: string;
  value: React.ReactNode;
  hint: string;
  icon: React.ReactNode;
  tone: keyof typeof TILE_TONES;
  /** This period against the one before it, when the reading has one. */
  delta?: number;
  spark?: number[];
  onClick?: () => void;
}> = ({ label, value, hint, icon, tone, delta, spark, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={!onClick}
    className="text-left bg-slate-900/90 border border-slate-800 rounded-2xl px-4 py-3.5 shadow-lg flex items-center gap-3.5 min-w-0 transition-colors enabled:hover:border-slate-600 enabled:cursor-pointer disabled:cursor-default"
  >
    <span className={`w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 [&>svg]:w-[18px] [&>svg]:h-[18px] ${TILE_TONES[tone]}`}>
      {icon}
    </span>
    <div className="min-w-0 flex-1">
      <div className="text-2xs font-semibold text-slate-400 truncate">{label}</div>
      <div className="flex items-center gap-2 mt-0.5">
        <span className="text-2xl font-bold text-white leading-tight tabular-nums">{value}</span>
        {delta !== undefined && delta !== 0 && (
          <span
            className={`inline-flex items-center gap-0.5 text-2xs font-bold px-1.5 rounded-full ${
              delta > 0 ? 'bg-green-500/10 text-green-300' : 'bg-amber-500/10 text-amber-300'
            }`}
            title="Compared with the 7 days before"
          >
            {delta > 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
            {delta > 0 ? `+${delta}` : delta}
          </span>
        )}
      </div>
      <div className="text-2xs text-slate-400 truncate" title={hint}>
        {hint}
      </div>
    </div>
    {spark && spark.some((v) => v > 0) && (
      <span className="shrink-0 hidden sm:block">
        <Sparkline values={spark} color="var(--viz-1)" width={64} height={28} />
      </span>
    )}
  </button>
);

/** One ranked bar. One series, so one hue for every row: length alone carries the value. */
const RankBar: React.FC<{ label: string; value: number; max: number }> = ({ label, value, max }) => (
  <div className="space-y-1.5" title={`${label}: ${value}`}>
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="text-slate-300 truncate">{label}</span>
      <span className="font-semibold text-white tabular-nums shrink-0">{value}</span>
    </div>
    <div className="h-1.5 rounded-full bg-slate-800/70 overflow-hidden">
      <div
        className="h-full rounded-full bg-emerald-500 transition-all duration-500"
        style={{ width: max > 0 ? `${(value / max) * 100}%` : '0%' }}
      />
    </div>
  </div>
);

/** How full one agent's desk is. Fill and track are steps of one ramp, so the state reads across the whole bar. */
const LoadMeter: React.FC<{ label: string; used: number; cap: number | null }> = ({ label, used, cap }) => {
  const ratio = cap && cap > 0 ? used / cap : 0;
  const tone =
    cap === null
      ? { fill: 'bg-slate-500', track: 'bg-slate-500/15', text: 'text-slate-400' }
      : ratio >= 1
        ? { fill: 'bg-rose-500', track: 'bg-rose-500/15', text: 'text-rose-300' }
        : ratio >= 0.8
          ? { fill: 'bg-amber-500', track: 'bg-amber-500/15', text: 'text-amber-300' }
          : { fill: 'bg-emerald-500', track: 'bg-emerald-500/15', text: 'text-slate-400' };
  return (
    <div className="space-y-1.5" title={`${label}: ${used}${cap === null ? '' : ` / ${cap}`}`}>
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-slate-300 truncate">{label}</span>
        <span className="tabular-nums shrink-0">
          <span className="font-semibold text-white">{used}</span>
          {cap === null ? <span className="text-slate-600"> · no cap</span> : <span className={tone.text}> / {cap}</span>}
        </span>
      </div>
      <div className={`h-1.5 rounded-full overflow-hidden ${tone.track}`}>
        <div
          className={`h-full rounded-full transition-all duration-500 ${tone.fill}`}
          style={{ width: `${Math.min(1, ratio) * 100}%` }}
        />
      </div>
    </div>
  );
};

type LoadState = 'over' | 'near' | 'ok' | 'none';

const loadState = (used: number, cap: number | null): LoadState =>
  cap === null || cap <= 0 ? 'none' : used >= cap ? 'over' : used / cap >= 0.8 ? 'near' : 'ok';

/** The four load states, busiest first. Status colours, always shown with their name. */
const LOAD_STATES: readonly { key: LoadState; label: string; dot: string; bar: string }[] = [
  { key: 'over', label: 'At limit', dot: 'bg-rose-500', bar: 'bg-rose-500' },
  { key: 'near', label: 'Almost full', dot: 'bg-amber-500', bar: 'bg-amber-500' },
  { key: 'ok', label: 'Has room', dot: 'bg-emerald-500', bar: 'bg-emerald-500' },
  { key: 'none', label: 'No limit set', dot: 'bg-slate-500', bar: 'bg-slate-500' },
];

/** How many agents are listed before "Show all". */
const AGENT_ROWS = 6;

/**
 * Team workload that still reads with a hundred agents: one capacity figure, one bar
 * splitting the team by how full each desk is (each part a filter), then the busiest
 * agents first. The full list is one click away, searchable and scrolling in place.
 */
const AgentWorkload: React.FC<{ agents: OrganizationMember[] }> = ({ agents }) => {
  const [filter, setFilter] = useState<LoadState | 'all'>('all');
  const [query, setQuery] = useState('');
  const [all, setAll] = useState(false);

  const rows = agents
    .map((m) => ({ m, state: loadState(m.activeLeads, m.maxActiveLeads), ratio: m.maxActiveLeads ? m.activeLeads / m.maxActiveLeads : -1 }))
    .sort((a, b) => b.ratio - a.ratio || b.m.activeLeads - a.m.activeLeads);
  const counts = Object.fromEntries(LOAD_STATES.map((st) => [st.key, rows.filter((r) => r.state === st.key).length])) as Record<
    LoadState,
    number
  >;
  const capped = agents.filter((m) => m.maxActiveLeads && m.maxActiveLeads > 0);
  const used = capped.reduce((n, m) => n + m.activeLeads, 0);
  const cap = capped.reduce((n, m) => n + (m.maxActiveLeads ?? 0), 0);
  const pct = cap > 0 ? Math.round((used / cap) * 100) : null;

  const q = query.trim().toLowerCase();
  const shown = rows.filter((r) => (filter === 'all' || r.state === filter) && (!q || memberName(r.m).toLowerCase().includes(q)));
  const visible = all || q || filter !== 'all' ? shown : shown.slice(0, AGENT_ROWS);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 md:grid-cols-[14rem_1fr] gap-5 items-center">
        <div>
          <div className="text-2xs font-semibold text-slate-400">Team capacity used</div>
          <div className="flex items-baseline gap-2 mt-0.5">
            <span className="text-2xl font-bold text-white tabular-nums">{pct === null ? '—' : `${pct}%`}</span>
            {cap > 0 && (
              <span className="text-2xs text-slate-400 tabular-nums">
                {used.toLocaleString()} of {cap.toLocaleString()} leads
              </span>
            )}
          </div>
          <div className="text-2xs text-slate-400">{agents.length.toLocaleString()} active agents</div>
        </div>

        <div className="space-y-2.5">
          {/* The team split by load: one bar, every part labelled in the chips below. */}
          <div className="flex gap-0.5 h-3" role="img" aria-label={LOAD_STATES.map((st) => `${st.label} ${counts[st.key]}`).join(', ')}>
            {LOAD_STATES.filter((st) => counts[st.key] > 0).map((st) => (
              <button
                key={st.key}
                type="button"
                onClick={() => setFilter(filter === st.key ? 'all' : st.key)}
                title={`${st.label}: ${counts[st.key]} agent${counts[st.key] === 1 ? '' : 's'}`}
                className={`h-full rounded-full cursor-pointer transition-opacity ${st.bar} ${filter !== 'all' && filter !== st.key ? 'opacity-25' : ''}`}
                style={{ width: `${(counts[st.key] / rows.length) * 100}%` }}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {LOAD_STATES.map((st) => (
              <button
                key={st.key}
                type="button"
                disabled={counts[st.key] === 0}
                onClick={() => setFilter(filter === st.key ? 'all' : st.key)}
                className={`inline-flex items-center gap-1.5 pl-2 pr-2.5 py-1 rounded-full border text-2xs font-semibold transition-colors cursor-pointer disabled:cursor-default disabled:opacity-40 ${
                  filter === st.key ? 'bg-slate-800 border-slate-600 text-white' : 'border-slate-800 text-slate-300 enabled:hover:border-slate-600'
                }`}
              >
                <span className={`w-2 h-2 rounded-full ${st.dot}`} />
                {st.label}
                <span className="tabular-nums text-white">{counts[st.key]}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="border-t border-slate-800 pt-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-semibold text-slate-300">
            {filter === 'all' ? (q ? 'Matching agents' : 'Busiest first') : LOAD_STATES.find((st) => st.key === filter)?.label}
            <span className="text-slate-500 font-normal"> · {shown.length}</span>
          </span>
          {agents.length > AGENT_ROWS && (
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find an agent…"
              aria-label="Find an agent"
              className="w-48 bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-emerald-600"
            />
          )}
        </div>

        {visible.length === 0 ? (
          <Empty>No agents match.</Empty>
        ) : (
          <div className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-4 ${visible.length > 12 ? 'max-h-80 overflow-y-auto custom-scrollbar pr-2' : ''}`}>
            {visible.map(({ m }) => (
              <LoadMeter key={m.id} label={memberName(m)} used={m.activeLeads} cap={m.maxActiveLeads} />
            ))}
          </div>
        )}

        {!q && filter === 'all' && shown.length > AGENT_ROWS && (
          <Button variant="link" onClick={() => setAll(!all)}>
            {all ? 'Show fewer' : `Show all ${shown.length} agents`}
          </Button>
        )}
      </div>
    </div>
  );
};

/**
 * The dashboard's two reads, independent of each other.
 *
 * GET /api/dashboard feeds everything except Agent load; GET /api/agents feeds
 * only Agent load. Each lands in state the moment it arrives, so the dashboard
 * never waits on the slower roster and a failed roster never blanks it.
 * `error` is the dashboard's, `membersError` the roster's. `loading` stays
 * true until both have settled.
 */
export function useDashboardData() {
  const [data, setData] = useState<OwnerDashboard | null>(null);
  const [members, setMembers] = useState<OrganizationMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  /** `silent` is the background refresh: the numbers update without a loading state. */
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    await Promise.allSettled([
      getOwnerDashboard().then(
        (d) => {
          setData(d);
          setError(null);
        },
        (e) => setError(messageFor(e)),
      ),
      listMembers().then(
        (m) => {
          setMembers(m);
          setMembersError(null);
        },
        (e) => setMembersError(messageFor(e)),
      ),
    ]);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    // No refresh button: the numbers keep themselves current while the tab is open.
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(true);
    }, 60_000);
    return () => window.clearInterval(id);
  }, [load]);

  return { data, members, error, membersError, loading, load };
}

/**
 * The owner's office at a glance. Every number is read from the office's real
 * records via GET /api/dashboard and GET /api/agents; zero is a real answer.
 */
export const DashboardView: React.FC = () => {
  const state = useDashboardData();
  return <DashboardContent {...state} />;
};

/** How many sources are listed before the tail is summed into one row. */
const SOURCE_ROWS = 6;

/** The view for a given state of the two reads; rendered on its own in tests. */
export const DashboardContent: React.FC<ReturnType<typeof useDashboardData>> = ({
  data,
  members,
  error,
  membersError,
  load,
}) => {
  const { user, organization } = useAuth();
  const navigate = useNavigate();

  const spinner = <span aria-label="Loading" className="block h-8 w-16 rounded-md bg-slate-800 animate-pulse" />;
  const agents = (members ?? []).filter((m) => m.hasProfile && m.status !== 'suspended');

  const stages = data ? fold(STAGES, data.leads.byStatus) : [];
  const outcomes = data ? fold(CALL_OUTCOMES, data.calls7Days.byStatus) : [];
  const answered = data ? (outcomes.find((p) => p.key === 'answered')?.value ?? 0) : 0;

  // Longest first, then everything past the sixth summed into one row.
  const sources = data ? data.sources30Days.slice(0, SOURCE_ROWS) : [];
  const tail = data ? data.sources30Days.slice(SOURCE_ROWS) : [];
  const tailTotal = tail.reduce((n, s) => n + s.count, 0);
  const sourceMax = Math.max(0, ...sources.map((s) => s.count));

  const trend = data?.trend14Days ?? [];
  const series: TrendSeries[] = [
    { key: 'leads', label: 'New leads', color: 'var(--viz-1)', values: trend.map((d) => d.leads) },
    { key: 'calls', label: 'AI calls', color: 'var(--viz-2)', values: trend.map((d) => d.calls) },
    { key: 'texts', label: 'Texts sent', color: 'var(--viz-3)', values: trend.map((d) => d.texts) },
  ];
  const trendActive = series.some((s) => s.values.some((v) => v > 0));

  const temps = data ? TEMPERATURES.map((t) => ({ ...t, value: data.leads.byTemperature[t.key] })) : [];
  const openTotal = temps.reduce((n, t) => n + t.value, 0);
  const tempMax = Math.max(0, ...temps.map((t) => t.value));

  // Only what is actually waiting on someone. Each opens Leads filtered to it.
  const attention = data
    ? [
        {
          label: 'Hot leads with no agent',
          sentence: (n: number) => `${n} hot lead${n === 1 ? ' has' : 's have'} no agent`,
          hint: 'Assign an agent so they are not kept waiting.',
          action: 'Assign',
          count: data.attention.hotUnassigned,
          to: '/leads?tab=hot',
          tone: 'rose' as const,
          icon: <Flame />,
        },
        {
          label: 'Not contacted yet',
          sentence: (n: number) => `${n} lead${n === 1 ? '' : 's'} not contacted yet`,
          hint: 'New leads the AI has not reached so far.',
          action: 'View leads',
          count: data.attention.neverContacted,
          to: '/leads?tab=new',
          tone: 'amber' as const,
          icon: <PhoneOff />,
        },
        {
          label: 'Flagged for review',
          sentence: (n: number) => `${n} lead${n === 1 ? '' : 's'} flagged for review`,
          hint: 'The AI wants a person to check these.',
          action: 'Review',
          count: data.attention.needsReview,
          to: '/leads',
          tone: 'amber' as const,
          icon: <Flag />,
        },
      ].filter((a) => a.count > 0)
    : [];

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <div className="p-6 space-y-5 max-w-7xl mx-auto text-slate-100">
      <div>
        <h2 className="text-xl font-bold text-white tracking-tight">
          {user?.firstName ? `${greeting}, ${user.firstName}` : 'Dashboard'}
        </h2>
        <p className="text-xs text-slate-400 mt-0.5">
          Here is how your AI is working your leads{organization?.name ? ` at ${organization.name}` : ''}.
        </p>
      </div>

      {error && (
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-2xl p-4 flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" />
          <div className="text-xs text-rose-200 leading-relaxed flex-1">
            <div className="font-semibold text-rose-100">Could not load the dashboard</div>
            {error}
          </div>
          <Button variant="link" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      )}

      {/* The one row that asks for action. Nothing waiting, nothing shown. */}
      {/* One thing waiting: a single-line banner with its action, not a grid with one lonely card. */}
      {attention.length === 1 && (
        <section
          aria-label="Needs your attention"
          className="bg-slate-900/90 border border-amber-500/30 rounded-2xl shadow-lg px-4 py-3 flex flex-wrap items-center gap-3"
        >
          <span className={`w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 [&>svg]:w-[18px] [&>svg]:h-[18px] ${ATTENTION_TONES[attention[0].tone]}`}>
            {attention[0].icon}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-2xs font-bold text-amber-300">Needs your attention</div>
            <div className="text-sm font-bold text-white">
              {attention[0].sentence(attention[0].count)}
            </div>
            <div className="text-2xs text-slate-400">{attention[0].hint}</div>
          </div>
          <Button size="sm" onClick={() => navigate(attention[0].to)} iconRight={<ArrowRight />}>
            {attention[0].action}
          </Button>
        </section>
      )}

      {attention.length > 1 && (
        <section
          aria-label="Needs your attention"
          className="bg-slate-900/90 border border-amber-500/30 rounded-2xl shadow-lg overflow-hidden"
        >
          <div className="flex flex-wrap items-center gap-3 px-4 py-3 bg-amber-500/[0.07] border-b border-amber-500/20">
            <span className="w-8 h-8 rounded-lg bg-amber-500/15 border border-amber-500/30 flex items-center justify-center shrink-0">
              <BellRing className="w-4 h-4 text-amber-300" />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-bold text-white">Needs your attention</h3>
              <p className="text-2xs text-slate-400">
                {attention.length} things are waiting on you. Click one to deal with it.
              </p>
            </div>
          </div>
          <div
            className={`p-3 grid gap-3 grid-cols-1 sm:grid-cols-2 ${
              attention.length === 3 ? 'lg:grid-cols-3' : attention.length === 4 ? 'xl:grid-cols-4' : ''
            }`}
          >
            {attention.map((a) => (
              <button
                key={a.label}
                type="button"
                onClick={() => navigate(a.to)}
                className="group text-left bg-slate-950/50 border border-slate-800 rounded-xl p-3.5 flex items-start gap-3 transition-colors hover:border-slate-600 cursor-pointer"
              >
                <span className={`w-9 h-9 rounded-lg border flex items-center justify-center shrink-0 [&>svg]:w-4 [&>svg]:h-4 ${ATTENTION_TONES[a.tone]}`}>
                  {a.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="text-xl font-bold text-white tabular-nums leading-none">{a.count.toLocaleString()}</span>
                    <span className="text-xs font-semibold text-slate-200 truncate">{a.label}</span>
                  </span>
                  <span className="block text-2xs text-slate-400 mt-1.5">{a.hint}</span>
                  <span className="inline-flex items-center gap-1 text-2xs font-bold text-emerald-400 mt-2 group-hover:gap-1.5 transition-all">
                    {a.action} <ArrowRight className="w-3 h-3" />
                  </span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <StatTile
          tone="brand"
          label="New leads this week"
          value={data ? data.leads.last7Days : spinner}
          delta={data ? data.leads.last7Days - data.leads.previous7Days : undefined}
          spark={trend.length ? trend.slice(-7).map((d) => d.leads) : undefined}
          hint={data ? `${data.leads.total.toLocaleString()} leads in total` : 'Leads received in the last 7 days'}
          icon={<Inbox />}
          onClick={() => navigate('/leads')}
        />
        <StatTile
          tone="sky"
          label="Speed to lead"
          value={
            data ? (data.speedToLead.medianSeconds === null ? '—' : formatDuration(data.speedToLead.medianSeconds)) : spinner
          }
          hint={
            data && data.speedToLead.sample > 0
              ? `${data.speedToLead.within60sPct}% reached within 1 minute`
              : 'Time from a new lead to the first AI contact'
          }
          icon={<Timer />}
        />
        <StatTile
          tone="rose"
          label="Hot leads"
          value={data ? data.leads.byTemperature.hot : spinner}
          hint="Ready to talk, not booked yet"
          icon={<Flame />}
          onClick={() => navigate('/leads?tab=hot')}
        />
        <StatTile
          tone="violet"
          label="Upcoming appointments"
          value={data ? data.upcomingAppointments : spinner}
          hint="Booked with your team"
          icon={<CalendarClock />}
        />
      </div>

      {/* Card-shaped placeholders while the first load runs. */}
      {!data && !error && (
        <div aria-hidden="true" className="space-y-5 animate-pulse">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            <div className="lg:col-span-8 h-80 rounded-2xl bg-slate-900 border border-slate-800" />
            <div className="lg:col-span-4 h-80 rounded-2xl bg-slate-900 border border-slate-800" />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-72 rounded-2xl bg-slate-900 border border-slate-800" />
            ))}
          </div>
        </div>
      )}

      {data && (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            {/* AI activity: the page's hero. Totals double as the legend. */}
            <Panel title="AI activity" icon={<Activity className="w-4 h-4" />} aside="Last 14 days" className="lg:col-span-8">
              {trend.length === 0 ? (
                <Empty>The activity chart appears here once the server is updated.</Empty>
              ) : (
                <>
                  <div className="grid grid-cols-3 gap-2">
                    {series.map((s) => (
                      <div key={s.key} className="bg-slate-950/50 border border-slate-800 rounded-xl px-3 py-2.5">
                        <div className="flex items-center gap-1.5 text-2xs font-semibold text-slate-400">
                          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
                          <span className="truncate">{s.label}</span>
                        </div>
                        <div className="text-xl font-bold text-white tabular-nums mt-1">
                          {s.values.reduce((a, b) => a + b, 0).toLocaleString()}
                        </div>
                      </div>
                    ))}
                  </div>
                  {trendActive ? (
                    <TrendChart days={trend.map((d) => d.day)} series={series} height={270} />
                  ) : (
                    <div className="h-40 flex items-center justify-center">
                      <Empty>No activity in the last 14 days yet.</Empty>
                    </div>
                  )}
                </>
              )}
            </Panel>

            <Panel title="Pipeline" icon={<Users className="w-4 h-4" />} aside="All leads" className="lg:col-span-4">
              {data.leads.total === 0 ? (
                <Empty>No leads yet. Connect a lead source and they appear here.</Empty>
              ) : (
                <Donut parts={stages} centerValue={data.leads.total.toLocaleString()} centerLabel="total leads" />
              )}
            </Panel>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            <Panel title="AI call results" icon={<PhoneCall className="w-4 h-4" />} aside="Last 7 days">
              {data.calls7Days.total === 0 ? (
                <Empty>No AI calls in the last 7 days.</Empty>
              ) : (
                <Donut
                  parts={outcomes}
                  centerValue={`${Math.round((answered / data.calls7Days.total) * 100)}%`}
                  centerLabel={`answered · ${data.calls7Days.total} calls`}
                />
              )}
            </Panel>

            <Panel title="Lead temperature" icon={<Thermometer className="w-4 h-4" />} aside="Open leads">
              {openTotal === 0 ? (
                <Empty>No open leads right now.</Empty>
              ) : (
                <div className="space-y-4">
                  {temps.map((t) => (
                    <div key={t.key} className="space-y-1.5" title={`${t.label}: ${t.value}`}>
                      <div className="flex items-baseline justify-between gap-3 text-xs">
                        <span className={t.value > 0 ? 'text-slate-300' : 'text-slate-500'}>{t.label}</span>
                        <span className="tabular-nums">
                          <span className="text-slate-500 mr-2">{Math.round((t.value / openTotal) * 100)}%</span>
                          <span className={t.value > 0 ? 'font-bold text-white' : 'text-slate-500'}>{t.value}</span>
                        </span>
                      </div>
                      <div className="h-2 rounded-full bg-slate-800/70 overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-500 ${t.bar}`}
                          style={{ width: tempMax > 0 ? `${(t.value / tempMax) * 100}%` : '0%' }}
                        />
                      </div>
                    </div>
                  ))}
                  <p className="text-2xs text-slate-400">The AI rates each lead from its calls and texts.</p>
                </div>
              )}
            </Panel>

            <Panel title="Where leads come from" icon={<Webhook className="w-4 h-4" />} aside="Last 30 days">
              {data.sources30Days.length === 0 ? (
                <Empty>No leads in the last 30 days.</Empty>
              ) : (
                <div className="space-y-4">
                  {sources.map((s, i) => (
                    <RankBar key={`${s.name}-${i}`} label={s.name} value={s.count} max={sourceMax} />
                  ))}
                  {tail.length > 0 && (
                    <p className="pt-1 text-2xs text-slate-500 flex items-baseline justify-between gap-3">
                      <span>
                        {tail.length} smaller {tail.length === 1 ? 'source' : 'sources'}
                      </span>
                      <span className="tabular-nums">{tailTotal}</span>
                    </p>
                  )}
                </div>
              )}
            </Panel>
          </div>

          <Panel title="Agent workload" icon={<UserCheck className="w-4 h-4" />} aside="Active leads per agent">
            {membersError && <p className="text-xs text-rose-300 leading-relaxed">Could not load agents: {membersError}</p>}
            {/* Not loaded yet is not "no agents": placeholders until the roster answers. */}
            {members === null ? (
              !membersError && (
                <div aria-label="Loading agents" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-4 animate-pulse">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="h-7 rounded-md bg-slate-800" />
                  ))}
                </div>
              )
            ) : agents.length === 0 ? (
              <Empty>No active agents yet. Add one from Agent Team &amp; Routing.</Empty>
            ) : (
              <AgentWorkload agents={agents} />
            )}
          </Panel>
        </>
      )}
    </div>
  );
};
