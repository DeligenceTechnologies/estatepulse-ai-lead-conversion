import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Building2,
  CalendarClock,
  Flame,
  Inbox,
  Loader2,
  PhoneCall,
  RefreshCw,
  Timer,
  UserCheck,
  Users,
  Webhook,
} from 'lucide-react';
import { messageFor } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import { getOwnerDashboard, type OwnerDashboard } from '../../utils/dashboardApi';
import { LEAD_STATUSES, STATUS_LABELS } from '../../lib/leadStatus';
import { listMembers, memberName, type OrganizationMember } from '../../utils/agentsApi';


const CALL_LABELS: Record<string, string> = {
  completed: 'Completed',
  no_answer: 'No answer',
  failed: 'Failed',
  handoff_requested: 'Asked for a human',
  dnc: 'Do not call',
  in_progress: 'In progress',
  ringing: 'Ringing',
  queued: 'Queued',
};

const TEMPERATURES = [
  { key: 'hot', label: 'Hot', tone: 'bg-rose-500/20 text-rose-300 border border-rose-500/40' },
  { key: 'warm', label: 'Warm', tone: 'bg-amber-500/20 text-amber-300 border border-amber-500/40' },
  { key: 'cold', label: 'Cold', tone: 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30' },
  { key: 'unrated', label: 'Not rated', tone: 'bg-slate-800 text-slate-400 border border-slate-700' },
] as const;

const formatDuration = (s: number): string =>
  s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${(s / 3600).toFixed(1)}h`;

const Card: React.FC<{ label: string; value: React.ReactNode; hint: string; icon: React.ReactNode }> = ({
  label,
  value,
  hint,
  icon,
}) => (
  <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-xl space-y-2">
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-slate-400 font-semibold">{label}</span>
      <span className="text-slate-500">{icon}</span>
    </div>
    <div className="text-2xl font-bold text-white font-mono">{value}</div>
    <p className="text-2xs text-slate-500 leading-relaxed">{hint}</p>
  </div>
);

const Panel: React.FC<{ title: string; icon: React.ReactNode; aside?: string; children: React.ReactNode }> = ({
  title,
  icon,
  aside,
  children,
}) => (
  <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-xl space-y-4">
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <span className="text-slate-500">{icon}</span>
        <h3 className="text-sm font-bold text-white">{title}</h3>
      </div>
      {aside && <span className="text-2xs text-slate-500">{aside}</span>}
    </div>
    {children}
  </div>
);

const Empty: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="text-xs text-slate-500 leading-relaxed">{children}</p>
);

/** One labelled horizontal bar; width is relative to the largest row in its panel. */
const BarRow: React.FC<{ label: string; value: number; max: number; suffix?: string }> = ({
  label,
  value,
  max,
  suffix,
}) => (
  <div className="space-y-1" title={`${label}: ${value}${suffix ?? ''}`}>
    <div className="flex items-center justify-between text-xs">
      <span className="text-slate-300 truncate">{label}</span>
      <span className="font-mono font-bold text-white shrink-0">
        {value}
        {suffix && <span className="text-slate-500 font-normal">{suffix}</span>}
      </span>
    </div>
    <div className="w-full bg-slate-950 h-2 rounded-full overflow-hidden border border-slate-800">
      <div
        className="h-full rounded-full bg-emerald-500 transition-all duration-500"
        style={{ width: max > 0 ? `${(value / max) * 100}%` : '0%' }}
      />
    </div>
  </div>
);

/**
 * The owner's office at a glance. Every number is read from the office's real
 * records via GET /api/dashboard and GET /api/agents; zero is a real answer.
 */
export const DashboardView: React.FC = () => {
  const { user, organization } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState<OwnerDashboard | null>(null);
  const [members, setMembers] = useState<OrganizationMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [d, m] = await Promise.all([getOwnerDashboard(), listMembers()]);
      setData(d);
      setMembers(m);
      setError(null);
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const spinner = <span aria-label="Loading" className="block h-7 w-14 rounded-md bg-slate-800 animate-pulse" />;
  const agents = (members ?? []).filter((m) => m.hasProfile && m.status !== 'suspended');
  const statusMax = data ? Math.max(0, ...LEAD_STATUSES.map((s) => data.leads.byStatus[s] ?? 0)) : 0;
  const callRows = data ? Object.entries(data.calls7Days.byStatus).sort((a, b) => b[1] - a[1]) : [];
  const sourceMax = data ? Math.max(0, ...data.sources30Days.map((s) => s.count)) : 0;

  // Each item opens Leads already filtered to what it counts.
  const attention: { label: string; hint: string; count: number; to: string }[] = data
    ? [
        {
          label: 'Hot leads with no agent',
          hint: 'Open hot leads nobody currently holds.',
          count: data.attention.hotUnassigned,
          to: '/leads?tab=hot',
        },
        {
          label: 'Not contacted yet',
          hint: 'New leads with no outreach sent.',
          count: data.attention.neverContacted,
          to: '/leads?tab=new',
        },
        {
          label: 'Flagged for review',
          hint: 'Ingested with a data problem (e.g. invalid phone).',
          count: data.attention.needsReview,
          to: '/leads',
        },
      ]
    : [];

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto text-slate-100">
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

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card
          label="New Leads (7 days)"
          value={data ? data.leads.last7Days : spinner}
          hint={data ? `${data.leads.total} leads in total.` : 'Leads received this week.'}
          icon={<Inbox className="w-4 h-4" />}
        />
        <Card
          label="Median Speed-to-Lead"
          value={data ? (data.speedToLead.medianSeconds === null ? '—' : formatDuration(data.speedToLead.medianSeconds)) : spinner}
          hint={
            data && data.speedToLead.sample > 0
              ? `${data.speedToLead.within60sPct}% reached within 60s · ${data.speedToLead.sample} leads, last 30 days.`
              : 'Lead received to first outreach. No outreach in the last 30 days.'
          }
          icon={<Timer className="w-4 h-4" />}
        />
        <Card
          label="Open Hot Leads"
          value={data ? data.leads.byTemperature.hot : spinner}
          hint="Rated hot and not yet booked, closed or lost."
          icon={<Flame className="w-4 h-4" />}
        />
        <Card
          label="Upcoming Appointments"
          value={data ? data.upcomingAppointments : spinner}
          hint="Scheduled with your team, from now onwards."
          icon={<CalendarClock className="w-4 h-4" />}
        />
      </div>

      {/* Panel-shaped placeholders while the first load runs. */}
      {!data && !error && (
        <div aria-hidden="true" className="space-y-6 animate-pulse">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-5 h-64 rounded-2xl bg-slate-900 border border-slate-800" />
            <div className="lg:col-span-7 h-64 rounded-2xl bg-slate-900 border border-slate-800" />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="h-40 rounded-2xl bg-slate-900 border border-slate-800" />
            <div className="h-40 rounded-2xl bg-slate-900 border border-slate-800" />
            <div className="h-40 rounded-2xl bg-slate-900 border border-slate-800" />
          </div>
        </div>
      )}

      {data && (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-5">
              <Panel title="Needs Attention" icon={<AlertTriangle className="w-4 h-4" />}>
                <div className="space-y-2">
                  {attention.map((a) => (
                    <button
                      key={a.label}
                      onClick={() => navigate(a.to)}
                      className="w-full p-3 bg-slate-950/70 border border-slate-800 hover:border-slate-700 rounded-xl flex items-center justify-between gap-3 text-left transition-colors cursor-pointer"
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-slate-200">{a.label}</div>
                        <div className="text-2xs text-slate-500">{a.hint}</div>
                      </div>
                      <span
                        className={`font-mono font-bold text-sm shrink-0 ${a.count > 0 ? 'text-amber-300' : 'text-slate-500'}`}
                      >
                        {a.count}
                      </span>
                    </button>
                  ))}
                </div>
              </Panel>
            </div>

            <div className="lg:col-span-7">
              <Panel title="Pipeline by Status" icon={<Users className="w-4 h-4" />} aside={`${data.leads.total} leads`}>
                {data.leads.total === 0 ? (
                  <Empty>No leads yet. Connect a lead source and they will appear here as they arrive.</Empty>
                ) : (
                  <>
                    <div className="space-y-3">
                      {LEAD_STATUSES.map((s) => (
                        <BarRow
                          key={s}
                          label={STATUS_LABELS[s]}
                          value={data.leads.byStatus[s] ?? 0}
                          max={statusMax}
                        />
                      ))}
                    </div>
                    <div className="pt-3 border-t border-slate-800 flex flex-wrap items-center gap-2">
                      <span className="text-2xs text-slate-500">Open leads by temperature:</span>
                      {TEMPERATURES.map((t) => (
                        <span key={t.key} className={`text-2xs font-semibold px-2 py-0.5 rounded-full ${t.tone}`}>
                          {t.label} {data.leads.byTemperature[t.key]}
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </Panel>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <Panel title="Agent Load" icon={<UserCheck className="w-4 h-4" />} aside="Current leads / cap">
              {agents.length === 0 ? (
                <Empty>No active agents yet. Add one from Agent Team &amp; Routing.</Empty>
              ) : (
                <div className="space-y-3">
                  {agents.map((m) => (
                    <BarRow
                      key={m.id}
                      label={memberName(m)}
                      value={m.activeLeads}
                      max={m.maxActiveLeads ?? m.activeLeads}
                      suffix={m.maxActiveLeads !== null ? ` / ${m.maxActiveLeads}` : undefined}
                    />
                  ))}
                </div>
              )}
            </Panel>

            <Panel
              title="AI Calls"
              icon={<PhoneCall className="w-4 h-4" />}
              aside={`${data.calls7Days.total} in the last 7 days`}
            >
              {callRows.length === 0 ? (
                <Empty>No calls placed in the last 7 days.</Empty>
              ) : (
                <div className="space-y-3">
                  {callRows.map(([status, n]) => (
                    <BarRow key={status} label={CALL_LABELS[status] ?? status} value={n} max={data.calls7Days.total} />
                  ))}
                </div>
              )}
            </Panel>

            <Panel title="Lead Sources" icon={<Webhook className="w-4 h-4" />} aside="Last 30 days">
              {data.sources30Days.length === 0 ? (
                <Empty>No leads received in the last 30 days.</Empty>
              ) : (
                <div className="space-y-3">
                  {data.sources30Days.map((s, i) => (
                    <BarRow key={`${s.name}-${i}`} label={s.name} value={s.count} max={sourceMax} />
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
