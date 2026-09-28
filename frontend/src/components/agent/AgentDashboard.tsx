import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Building2, CalendarClock, Flame, Loader2, RefreshCw, Users } from 'lucide-react';
import { messageFor } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { getAgentDashboard, type AgentDashboard as Stats } from '../../utils/agentMeApi';

/**
 * One count. The number is whatever the server answered — including zero, which
 * is a real answer here rather than a placeholder.
 */
const Card: React.FC<{
  label: string;
  value: number | null;
  hint: string;
  icon: React.ReactNode;
}> = ({ label, value, hint, icon }) => (
  <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-xl space-y-2">
    <div className="flex items-center justify-between gap-2">
      <span className="text-[11px] text-slate-400 font-semibold">{label}</span>
      <span className="text-slate-500">{icon}</span>
    </div>
    <div className="text-2xl font-bold text-white font-mono">
      {value === null ? <Loader2 className="w-5 h-5 animate-spin text-slate-600" /> : value}
    </div>
    <p className="text-[10px] text-slate-500 leading-relaxed">{hint}</p>
  </div>
);

/**
 * The agent's own numbers. Every card is a real count over the leads currently
 * assigned to this agent and the appointments that belong to them — there is no
 * sample data behind this screen.
 */
export const AgentDashboard: React.FC = () => {
  const { user, organization } = useAuth();
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStats(await getAgentDashboard());
      setError(null);
    } catch (e) {
      setError(messageFor(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto text-slate-100">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight">
            {user?.firstName ? `Welcome back, ${user.firstName}` : 'Your dashboard'}
          </h2>
          {/* Labelled, not a bare string: on its own under the greeting it read
              as a second copy of the person's name. The organization NAME is
              the only thing about the office an agent sees here — none of its
              other data — and it is the office their own session resolved to,
              never one they can ask for. */}
          <p className="text-xs text-slate-400 flex items-center gap-1.5 mt-0.5">
            <Building2 className="w-3.5 h-3.5 text-slate-500 shrink-0" />
            <span className="text-slate-500">Organization</span>
            <span className="text-slate-300 font-semibold truncate">
              {organization?.name ?? '—'}
            </span>
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="px-3 py-2 bg-slate-900 border border-slate-800 hover:border-slate-700 text-slate-300 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${stats === null ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-2xl p-4 flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" />
          <div className="text-xs text-rose-200 leading-relaxed">
            <div className="font-semibold text-rose-100">Could not load your dashboard</div>
            {error}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card
          label="My Active Leads"
          value={stats?.activeLeads ?? null}
          hint="Assigned to you and not closed or lost."
          icon={<Users className="w-4 h-4" />}
        />
        <Card
          label="New Leads"
          value={stats?.newLeads ?? null}
          hint="Assigned to you and not yet contacted."
          icon={<Flame className="w-4 h-4" />}
        />
        <Card
          label="Upcoming Appointments"
          value={stats?.upcomingAppointments ?? null}
          hint="Scheduled with you, from now onwards."
          icon={<CalendarClock className="w-4 h-4" />}
        />
        <Card
          label="Total Assigned Leads"
          value={stats?.totalAssignedLeads ?? null}
          hint="Everything currently in your name."
          icon={<Users className="w-4 h-4" />}
        />
      </div>

      {/* Said plainly rather than left looking broken: the counts are real, and
          they are zero because nothing assigns leads to agents yet. */}
      {stats !== null && stats.totalAssignedLeads === 0 && (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 text-xs text-slate-400 leading-relaxed">
          <span className="text-slate-300 font-semibold">Nothing assigned to you yet.</span> These
          counts are read straight from your office&apos;s records, so they will start moving the
          moment leads are assigned to you.
        </div>
      )}
    </div>
  );
};
