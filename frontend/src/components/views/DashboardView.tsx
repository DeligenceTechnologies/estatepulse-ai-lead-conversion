import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Building2,
  CalendarClock,
  Flame,
  Inbox,
  PhoneCall,
  RefreshCw,
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
  { key: 'hot', label: 'Hot', tone: 'bg-rose-500/15 text-rose-300 border-rose-500/30' },
  { key: 'warm', label: 'Warm', tone: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  { key: 'cold', label: 'Cold', tone: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30' },
  { key: 'unrated', label: 'Not rated', tone: 'bg-slate-800 text-slate-400 border-slate-700' },
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

/** A headline number. The value carries proportional figures; only the columns below align. */
const StatTile: React.FC<{
  label: string;
  value: React.ReactNode;
  hint: string;
  icon: React.ReactNode;
  /** This period against the one before it, when the reading has one. */
  delta?: number;
}> = ({ label, value, hint, icon, delta }) => (
  <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-xl">
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs font-semibold text-slate-400">{label}</span>
      <span className="text-slate-600">{icon}</span>
    </div>
    <div className="mt-3 flex items-baseline gap-2.5 flex-wrap">
      <span className="text-3xl font-semibold text-white leading-none">{value}</span>
      {delta !== undefined && delta !== 0 && (
        <span
          className={`inline-flex items-center gap-1 text-2xs font-semibold ${
            delta > 0 ? 'text-emerald-400' : 'text-amber-400'
          }`}
        >
          {delta > 0 ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
          {delta > 0 ? `+${delta}` : delta} vs last week
        </span>
      )}
    </div>
    <p className="mt-2 text-2xs text-slate-500 leading-relaxed">{hint}</p>
  </div>
);

/**
 * One whole split into its parts: a thin bar with no text, read together with the
 * rows beneath it, which carry every part's name and count. Parts are separated by
 * a gap in the surface rather than by a border, and a part at zero draws nothing.
 */
const SplitBar: React.FC<{ parts: Part[]; total: number }> = ({ parts, total }) =>
  total > 0 ? (
    <div
      className="flex gap-0.5 h-2"
      role="img"
      aria-label={parts
        .filter((p) => p.value > 0)
        .map((p) => `${p.label} ${p.value}`)
        .join(', ')}
    >
      {parts
        .filter((p) => p.value > 0)
        .map((p) => (
          <div
            key={p.key}
            className="h-full rounded-full"
            style={{ width: `${(p.value / total) * 100}%`, backgroundColor: p.fill }}
            title={`${p.label}: ${p.value}`}
          />
        ))}
    </div>
  ) : (
    <div className="h-2 rounded-full bg-slate-800/60" />
  );

/**
 * The split read as figures: the swatch carries identity, the text stays in ink.
 *
 * An empty part keeps its row — "nobody is in conversation" is an answer — but
 * recedes, so the rows that carry leads are the ones the eye lands on.
 */
const SplitRows: React.FC<{ parts: Part[]; total: number }> = ({ parts, total }) => (
  <ul className="space-y-2.5">
    {parts.map((p) => (
      <li key={p.key} className="flex items-center gap-2.5 text-xs">
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${p.value > 0 ? '' : 'opacity-30'}`}
          style={{ backgroundColor: p.fill }}
          aria-hidden
        />
        <span className={`flex-1 min-w-0 truncate ${p.value > 0 ? 'text-slate-300' : 'text-slate-600'}`}>
          {p.label}
        </span>
        <span className={`tabular-nums w-10 text-right ${p.value > 0 ? 'text-slate-500' : 'text-slate-600'}`}>
          {total > 0 ? `${Math.round((p.value / total) * 100)}%` : '—'}
        </span>
        <span
          className={`tabular-nums w-8 text-right ${p.value > 0 ? 'font-semibold text-white' : 'text-slate-600'}`}
        >
          {p.value}
        </span>
      </li>
    ))}
  </ul>
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

  const load = useCallback(async () => {
    setLoading(true);
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
  loading,
  load,
}) => {
  const { user, organization } = useAuth();
  const navigate = useNavigate();

  const spinner = <span aria-label="Loading" className="block h-8 w-16 rounded-md bg-slate-800 animate-pulse" />;
  const agents = (members ?? []).filter((m) => m.hasProfile && m.status !== 'suspended');

  const stages = data ? fold(STAGES, data.leads.byStatus) : [];
  const outcomes = data ? fold(CALL_OUTCOMES, data.calls7Days.byStatus) : [];
  const answered = data ? (outcomes.find((p) => p.key === 'answered')?.value ?? 0) : 0;

  // Longest first, then everything past the sixth summed into one row: fifteen
  // near-identical rows said less than six ranked ones and a tail.
  const sources = data ? data.sources30Days.slice(0, SOURCE_ROWS) : [];
  const tail = data ? data.sources30Days.slice(SOURCE_ROWS) : [];
  const tailTotal = tail.reduce((n, s) => n + s.count, 0);
  const sourceMax = Math.max(0, ...sources.map((s) => s.count));

  // Only what is actually waiting on someone. Each opens Leads filtered to it.
  const attention = data
    ? [
        { label: 'hot leads with no agent', count: data.attention.hotUnassigned, to: '/leads?tab=hot' },
        { label: 'not contacted yet', count: data.attention.neverContacted, to: '/leads?tab=new' },
        { label: 'flagged for review', count: data.attention.needsReview, to: '/leads' },
        { label: 'waiting in Import Review', count: data.attention.awaitingImportReview, to: '/import-review' },
      ].filter((a) => a.count > 0)
    : [];

  return (
    <div className="p-6 space-y-5 max-w-7xl mx-auto text-slate-100">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight">
            {user?.firstName ? `Welcome back, ${user.firstName}` : 'Dashboard'}
          </h2>
          <p className="text-xs text-slate-400 flex items-center gap-1.5 mt-0.5">
            <Building2 className="w-3.5 h-3.5 text-slate-500 shrink-0" />
            <span className="text-slate-500">Organization</span>
            <span className="text-slate-300 font-semibold truncate">{organization?.name ?? '—'}</span>
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="px-3 py-2 bg-slate-900 border border-slate-800 hover:border-slate-700 text-slate-300 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-2xl p-4 flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" />
          <div className="text-xs text-rose-200 leading-relaxed">
            <div className="font-semibold text-rose-100">Could not load the dashboard</div>
            {error}
          </div>
        </div>
      )}

      {/* The one row that asks for action. Nothing waiting, nothing shown. */}
      {attention.length > 0 && (
        <div className="bg-amber-500/5 border border-amber-500/25 rounded-2xl px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="flex items-center gap-2 text-xs font-bold text-amber-200">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            Needs attention
          </span>
          {attention.map((a) => (
            <button
              key={a.label}
              onClick={() => navigate(a.to)}
              className="px-2.5 py-1 rounded-lg bg-slate-950/50 border border-slate-800 hover:border-amber-500/40 text-xs text-slate-300 flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <span className="font-bold text-amber-200 tabular-nums">{a.count}</span>
              {a.label}
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        <StatTile
          label="New leads"
          value={data ? data.leads.last7Days : spinner}
          delta={data ? data.leads.last7Days - data.leads.previous7Days : undefined}
          hint={data ? `Last 7 days · ${data.leads.total} in total.` : 'Leads received this week.'}
          icon={<Inbox className="w-4 h-4" />}
        />
        <StatTile
          label="Median speed to lead"
          value={
            data ? (data.speedToLead.medianSeconds === null ? '—' : formatDuration(data.speedToLead.medianSeconds)) : spinner
          }
          hint={
            data && data.speedToLead.sample > 0
              ? `${data.speedToLead.within60sPct}% reached within 60s · ${data.speedToLead.sample} leads, last 30 days.`
              : 'Lead received to first outreach. No outreach in the last 30 days.'
          }
          icon={<Timer className="w-4 h-4" />}
        />
        <StatTile
          label="Open hot leads"
          value={data ? data.leads.byTemperature.hot : spinner}
          hint="Rated hot and not yet booked, closed or lost."
          icon={<Flame className="w-4 h-4" />}
        />
        <StatTile
          label="Upcoming appointments"
          value={data ? data.upcomingAppointments : spinner}
          hint="Booked with your team, from now onwards."
          icon={<CalendarClock className="w-4 h-4" />}
        />
      </div>

      {/* Card-shaped placeholders while the first load runs. */}
      {!data && !error && (
        <div aria-hidden="true" className="space-y-5 animate-pulse">
          {[0, 1].map((row) => (
            <div key={row} className="grid grid-cols-1 lg:grid-cols-12 gap-5">
              <div className="lg:col-span-7 h-72 rounded-2xl bg-slate-900 border border-slate-800" />
              <div className="lg:col-span-5 h-72 rounded-2xl bg-slate-900 border border-slate-800" />
            </div>
          ))}
        </div>
      )}

      {data && (
        <>
          {/* The two cards in a row share a height — the taller one's content, up to the cap,
              past which it scrolls. Rows size themselves, so they need not match each other. */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 [&>*]:min-h-56 [&>*]:max-h-80">
            <Panel
              title="Pipeline"
              icon={<Users className="w-4 h-4" />}
              className="lg:col-span-7"
              aside={
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-2xs text-slate-500">Open:</span>
                  {TEMPERATURES.map((t) => (
                    <span
                      key={t.key}
                      className={`text-2xs font-semibold px-2 py-0.5 rounded-full border ${t.tone}`}
                    >
                      {t.label} {data.leads.byTemperature[t.key]}
                    </span>
                  ))}
                </div>
              }
            >
              {data.leads.total === 0 ? (
                <Empty>No leads yet. Connect a lead source and they will appear here as they arrive.</Empty>
              ) : (
                <>
                  <div className="space-y-2">
                    <SplitBar parts={stages} total={data.leads.total} />
                    <p className="text-2xs text-slate-500">
                      Where all {data.leads.total} leads stand right now.
                    </p>
                  </div>
                  <SplitRows parts={stages} total={data.leads.total} />
                </>
              )}
            </Panel>

            <Panel
              title="AI calls"
              icon={<PhoneCall className="w-4 h-4" />}
              aside="Last 7 days"
              className="lg:col-span-5"
            >
              {data.calls7Days.total === 0 ? (
                <Empty>No calls placed in the last 7 days.</Empty>
              ) : (
                <>
                  <div className="space-y-2">
                    <div className="flex items-baseline gap-2">
                      <span className="text-2xl font-semibold text-white leading-none">
                        {Math.round((answered / data.calls7Days.total) * 100)}%
                      </span>
                      <span className="text-xs text-slate-400">answered</span>
                      <span className="text-2xs text-slate-500 ml-auto tabular-nums">
                        {data.calls7Days.total} placed
                      </span>
                    </div>
                    <SplitBar parts={outcomes} total={data.calls7Days.total} />
                  </div>
                  <SplitRows parts={outcomes} total={data.calls7Days.total} />
                </>
              )}
            </Panel>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 [&>*]:h-60">
            <Panel
              title="Where leads come from"
              icon={<Webhook className="w-4 h-4" />}
              aside="Last 30 days"
              className="lg:col-span-7"
            >
              {data.sources30Days.length === 0 ? (
                <Empty>No leads received in the last 30 days.</Empty>
              ) : (
                <div className="space-y-3.5">
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

            <Panel
              title="Agent load"
              icon={<UserCheck className="w-4 h-4" />}
              aside="Active leads / cap"
              className="lg:col-span-5"
            >
              {membersError && (
                <p className="text-xs text-rose-300 leading-relaxed">Could not load agents: {membersError}</p>
              )}
              {/* Not loaded yet is not "no agents": placeholders until the roster answers. */}
              {members === null ? (
                !membersError && (
                  <div aria-label="Loading agents" className="space-y-3.5 animate-pulse">
                    {[0, 1, 2].map((i) => (
                      <div key={i} className="h-7 rounded-md bg-slate-800" />
                    ))}
                  </div>
                )
              ) : agents.length === 0 ? (
                <Empty>No active agents yet. Add one from Agent Team &amp; Routing.</Empty>
              ) : (
                <div className="space-y-3.5">
                  {agents.map((m) => (
                    <LoadMeter key={m.id} label={memberName(m)} used={m.activeLeads} cap={m.maxActiveLeads} />
                  ))}
                </div>
              )}
            </Panel>
          </div>
        </>
      )}
    </div>
  );
};
