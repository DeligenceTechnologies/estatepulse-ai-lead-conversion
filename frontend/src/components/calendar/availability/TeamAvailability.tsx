import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { ApiError, messageFor } from '../../../lib/api';
import {
  getCalendarAvailability,
  getOrganizationCalendar,
  type AvailabilityReport,
  type MemberAvailability,
  type OrganizationCalendarStatus,
} from '../../../utils/calendarApi';
import {
  DayTimeline,
  SEGMENT_STYLE,
  UNAVAILABLE_SWATCH,
  WORKING_SWATCH,
  WeekTimeline,
  nowState,
} from './AvailabilityTimeline';
import { DAY_HOURS, dayLabel, shiftDate, todayIn } from './time';
import { useReloadOnSync } from '../shared/CalendarPanel';
import { syncedAgo } from '../shared/SyncButton';
import { PROVIDERS } from '../shared/ui';
import { displayTimeZone } from '../../../lib/datetime';

type Span = 1 | 7;
type Filter = 'all' | 'free' | 'busy';

const NOW_TICK_MS = 30_000;
const AUTO_REFRESH_MS = 60_000;
const SYNCING_POLL_MS = 5_000;

const segment = (active: boolean) =>
  `h-8 px-3 rounded-md text-xs font-semibold cursor-pointer transition-colors ${
    active ? 'bg-emerald-500/15 text-emerald-300' : 'text-slate-400 hover:text-slate-200'
  }`;

const iconButton =
  'h-9 w-9 rounded-lg border border-slate-800 bg-slate-900 text-slate-400 hover:text-white hover:border-slate-700 inline-flex items-center justify-center cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed';

const Legend: React.FC = () => (
  <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-2xs font-medium text-slate-400">
    {(['free', 'booking', 'calendar', 'hold'] as const).map((kind) => (
      <span key={kind} className="inline-flex items-center gap-1.5">
        <span className={`w-3.5 h-2.5 rounded-[3px] ${SEGMENT_STYLE[kind].swatch}`} />
        {SEGMENT_STYLE[kind].label}
      </span>
    ))}
    <span className="inline-flex items-center gap-1.5">
      <span className={`w-3.5 h-2.5 rounded-[3px] ${WORKING_SWATCH}`} />
      Working hours
    </span>
    <span className="inline-flex items-center gap-1.5">
      <span className={`w-3.5 h-2.5 rounded-[3px] ring-1 ring-inset ring-slate-700/60 ${UNAVAILABLE_SWATCH}`} />
      Off hours
    </span>
  </div>
);

const Skeleton: React.FC = () => (
  <div className="space-y-4 animate-pulse" aria-busy>
    <div className="rounded-2xl bg-slate-900 border border-slate-800 p-4 space-y-3">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-4">
          <div className="w-8 h-8 rounded-full bg-slate-800" />
          <div className="w-32 h-3 rounded bg-slate-800" />
          <div className="flex-1 h-10 rounded-lg bg-slate-800/60" />
        </div>
      ))}
    </div>
  </div>
);

const EmptyCard: React.FC<{ icon: React.ReactNode; title: string; children: React.ReactNode; action?: React.ReactNode }> = ({
  icon,
  title,
  children,
  action,
}) => (
  <div className="flex flex-col items-center text-center bg-slate-900/80 border border-slate-800 rounded-2xl px-6 py-14">
    <div className="w-12 h-12 rounded-2xl bg-slate-950 border border-slate-800 flex items-center justify-center mb-4">{icon}</div>
    <h3 className="text-sm font-bold text-white">{title}</h3>
    <p className="text-xs text-slate-400 mt-1.5 max-w-md leading-relaxed">{children}</p>
    {action && <div className="mt-5">{action}</div>}
  </div>
);

/**
 * Who is free and who is busy right now, per calendar member, read from the
 * connected Calendly or Cal.com. The Availability tab of the Scheduling page,
 * which owns the page title.
 */
export const TeamAvailability: React.FC<{ syncVersion: number }> = ({ syncVersion }) => {
  const navigate = useNavigate();
  const [calendar, setCalendar] = useState<OrganizationCalendarStatus | null>(null);
  const [report, setReport] = useState<AvailabilityReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [span, setSpan] = useState<Span>(1);
  const [date, setDate] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const request = useRef(0);

  const connected = Boolean(calendar?.connection && calendar.connection.status === 'active');

  const load = useCallback(
    async () => {
      const id = ++request.current;
      setLoading(true);
      try {
        const status = await getOrganizationCalendar();
        if (id !== request.current) return;
        setCalendar(status);
        if (!status.connection || status.connection.status !== 'active') {
          setReport(null);
          setError(null);
          return;
        }
        const next = await getCalendarAvailability({ date: date ?? todayIn(displayTimeZone()), days: span });
        if (id !== request.current) return;
        setReport(next);
        setError(null);
      } catch (e) {
        if (id !== request.current) return;
        if (e instanceof ApiError && e.status === 403) setForbidden(true);
        setError(messageFor(e));
      } finally {
        if (id === request.current) setLoading(false);
      }
    },
    [date, span],
  );


  useEffect(() => {
    void load();
  }, [load]);
  useReloadOnSync(syncVersion, load);

  const serverSyncing = Boolean(report?.sync.syncing);

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    const poll = window.setInterval(
      () => {
        if (document.visibilityState === 'visible') void load();
      },
      serverSyncing ? SYNCING_POLL_MS : AUTO_REFRESH_MS,
    );
    return () => {
      window.clearInterval(tick);
      window.clearInterval(poll);
    };
  }, [load, serverSyncing]);

  const today = todayIn(displayTimeZone());
  const first = report?.dates[0] ?? null;
  const live = Boolean(report?.dates.includes(today));

  const members = report?.members ?? [];
  const reachable = members.filter((member) => member.status !== 'unavailable');
  const states = new Map(reachable.map((member) => [member.externalId, nowState(member, now)]));
  const freeNow = reachable.filter((member) => states.get(member.externalId)?.kind === 'free').length;
  const busyNow = reachable.filter((member) => states.get(member.externalId)?.kind === 'busy').length;

  const query = search.trim().toLowerCase();
  const visible = members.filter((member: MemberAvailability) => {
    if (query && !`${member.name} ${member.email}`.toLowerCase().includes(query)) return false;
    if (filter === 'all' || !live) return true;
    return states.get(member.externalId)?.kind === filter;
  });

  const range = report?.range ?? null;
  const move = (direction: -1 | 1) => {
    if (!first || !range) return;
    let next = shiftDate(first, direction * span);
    if (next < range.minDate) next = range.minDate;
    if (next > range.maxDate) next = range.maxDate;
    setDate(next === today ? null : next);
  };
  const busySyncing = serverSyncing;

  const title = report
    ? span === 1
      ? dayLabel(report.dates[0], 'long')
      : `${dayLabel(report.dates[0], 'short')} – ${dayLabel(report.dates[report.dates.length - 1], 'short')}`
    : '';
  const provider = calendar?.provider ? PROVIDERS[calendar.provider] : null;

  let body: React.ReactNode;
  if (forbidden) {
    body = (
      <EmptyCard icon={<AlertTriangle className="w-6 h-6 text-amber-400" />} title="No access">
        Your role can’t view this page. Ask your owner for access.
      </EmptyCard>
    );
  } else if (error && !report) {
    body = (
      <EmptyCard
        icon={<AlertTriangle className="w-6 h-6 text-rose-400" />}
        title="Couldn’t load availability"
        action={
          <button
            type="button"
            onClick={() => void load()}
            className="h-9 px-4 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-100 cursor-pointer transition-colors"
          >
            Try again
          </button>
        }
      >
        {error}
      </EmptyCard>
    );
  } else if (!calendar && loading) {
    body = <Skeleton />;
  } else if (!connected) {
    body = (
      <EmptyCard
        icon={<CalendarClock className="w-6 h-6 text-emerald-400" />}
        title={calendar?.connection ? 'Reconnect your calendar' : 'Connect a calendar'}
        action={
          <button
            type="button"
            onClick={() => navigate('/settings?tab=calendar')}
            className="h-9 px-4 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-on-accent text-xs font-semibold cursor-pointer transition-colors"
          >
            {calendar?.connection ? 'Reconnect calendar' : 'Connect calendar'}
          </button>
        }
      >
        {calendar?.connection
          ? calendar.connection.lastError ?? 'The connection stopped working.'
          : 'Connect Calendly or Cal.com to see who’s free.'}
      </EmptyCard>
    );
  } else if (!report) {
    body = <Skeleton />;
  } else {
    body = (
      <section className="bg-slate-900/80 border border-slate-800 rounded-2xl overflow-hidden">
          <header className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 px-4 py-3 border-b border-slate-800">
            <div className="relative w-full lg:max-w-xs">
              <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search members"
                aria-label="Search members"
                maxLength={100}
                className="h-9 w-full bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-8 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600/30"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-slate-500 hover:text-slate-200 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {live && (
                <div role="radiogroup" aria-label="Show" className="inline-flex h-9 p-0.5 rounded-lg bg-slate-950 border border-slate-800">
                  {(
                    [
                      { id: 'all', label: 'Everyone' },
                      { id: 'free', label: `Free now · ${freeNow}` },
                      { id: 'busy', label: `Busy now · ${busyNow}` },
                    ] as const
                  ).map(({ id, label }) => (
                    <button key={id} type="button" role="radio" aria-checked={filter === id} onClick={() => setFilter(id)} className={segment(filter === id)}>
                      {label}
                    </button>
                  ))}
                </div>
              )}
              <Legend />
            </div>
          </header>

          {visible.length === 0 ? (
            <div className="px-4 py-12 text-center text-xs text-slate-400">
              {members.length === 0 ? 'No calendar members yet.' : 'No one matches this filter.'}
            </div>
          ) : (
            <div className={`overflow-auto custom-scrollbar max-h-[calc(100vh-20rem)] min-h-[12rem] transition-opacity ${loading ? 'opacity-70' : ''}`}>
              {span === 1 ? (
                <DayTimeline members={visible} hours={DAY_HOURS} now={now} />
              ) : (
                <WeekTimeline dates={report.dates} members={visible} hours={DAY_HOURS} now={now} today={today} />
              )}
            </div>
          )}

          <footer className="px-4 py-2.5 border-t border-slate-800 text-2xs text-slate-500 flex flex-wrap items-center justify-between gap-2">
            <span>
              Each member’s times are in their own {provider?.label ?? 'calendar'} timezone
              {report.totalMembers > members.length ? ` · showing ${members.length} of ${report.totalMembers} members` : ''}
            </span>
            <span className="inline-flex items-center gap-1.5">
              {busySyncing ? (
                <>
                  <RefreshCw className="w-3 h-3 animate-spin" />
                  Syncing with {provider?.label ?? 'your calendar'}…
                </>
              ) : report.sync.syncedAt ? null : (
                'Waiting for the first sync'
              )}
            </span>
          </footer>
        </section>
    );
  }

  return (
    <div className="space-y-4">
      {connected && !forbidden && report && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-base font-bold text-white tracking-tight">{title}</div>
            <div className="text-2xs text-slate-500">
              {live ? `${freeNow} free · ${busyNow} busy now` : `From ${provider?.label ?? 'your calendar'}`}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => move(-1)} disabled={loading || !first || !range || first <= range.minDate} aria-label={span === 1 ? 'Previous day' : 'Previous week'} className={iconButton}>
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setDate(null)}
              disabled={loading || live}
              className="h-9 px-3 rounded-lg border border-slate-800 bg-slate-900 text-xs font-semibold text-slate-300 hover:text-white hover:border-slate-700 cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Today
            </button>
            <button type="button" onClick={() => move(1)} disabled={loading || !first || !range || first >= range.maxDate} aria-label={span === 1 ? 'Next day' : 'Next week'} className={iconButton}>
              <ChevronRight className="w-4 h-4" />
            </button>
            <div role="radiogroup" aria-label="Range" className="inline-flex h-9 p-0.5 rounded-lg bg-slate-900 border border-slate-800">
              {([1, 7] as const).map((value) => (
                <button key={value} type="button" role="radio" aria-checked={span === value} onClick={() => setSpan(value)} className={segment(span === value)}>
                  {value === 1 ? 'Day' : 'Week'}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {report?.sync.error && !busySyncing && (
        <div role="status" className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
          <div className="text-xs text-amber-200 leading-relaxed flex-1">
            Sync failed: {report.sync.error}
            {report.sync.syncedAt ? ` Showing data from ${syncedAgo(report.sync.syncedAt, now)}.` : ''}
          </div>
        </div>
      )}

      {error && report && (
        <div role="alert" className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" />
          <div className="text-xs text-rose-200 leading-relaxed flex-1">{error}</div>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss" className="text-rose-300 hover:text-rose-100 cursor-pointer">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {body}
    </div>
  );
};
