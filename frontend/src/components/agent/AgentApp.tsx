import React, { useState } from 'react';
import { Building2, CalendarClock, CalendarCheck, LayoutDashboard, LogOut, Users } from 'lucide-react';
import { displayName, initialsFor, useAuth } from '../../context/AuthContext';
import { AgentAppointments } from './AgentAppointments';
import { AgentAvailability } from './AgentAvailability';
import { AgentDashboard } from './AgentDashboard';
import { AgentLeads } from './AgentLeads';

type AgentView = 'dashboard' | 'leads' | 'appointments' | 'availability';

const NAV_ITEMS: Array<{ id: AgentView; label: string; icon: React.ReactNode }> = [
  { id: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard className="w-4 h-4" /> },
  { id: 'leads', label: 'My Leads', icon: <Users className="w-4 h-4" /> },
  { id: 'appointments', label: 'Appointments', icon: <CalendarClock className="w-4 h-4" /> },
  { id: 'availability', label: 'Availability', icon: <CalendarCheck className="w-4 h-4" /> },
];

/**
 * The whole application for someone whose role is `agent`.
 *
 * A separate shell from the owner's App, rather than a set of role checks
 * threaded through it. The owner's sidebar is a list of things an agent may not
 * do — the roster, lead sources, integrations, AI settings — so hiding them one
 * by one would leave the owner experience one forgotten check away from
 * leaking, and every future view added to that sidebar would have to remember.
 * This shell can only render what is on it.
 *
 * The chrome deliberately mirrors the owner's Sidebar so the two do not feel
 * like different products: same width, same brand block, same active-item
 * treatment. What it leaves out is everything an agent has no business seeing —
 * the demo controls, the webhook tester, and every owner-only destination.
 *
 * The server is still the boundary: every route behind the owner's screens is
 * guarded by OwnerGuard and answers an agent 403 whatever the UI shows.
 */
export const AgentApp: React.FC = () => {
  const { user, organization, logout } = useAuth();
  const [view, setView] = useState<AgentView>('dashboard');

  return (
    <div className="flex h-screen bg-slate-950 text-slate-100 overflow-hidden font-sans selection:bg-emerald-500 selection:text-white">
      <aside className="w-64 bg-slate-900/95 border-r border-slate-800/80 flex flex-col h-screen shrink-0 backdrop-blur select-none">
        {/* Brand block, same shape as the owner's. The second line is the
            organization this agent belongs to — the one thing about the office
            their session actually carries. */}
        <div className="p-4 border-b border-slate-800/70">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-emerald-600 to-teal-400 flex items-center justify-center shadow-lg shadow-emerald-950/50 shrink-0">
              <Building2 className="w-5 h-5 text-white" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="font-bold text-sm text-slate-100 tracking-tight">EstatePulse</span>
                <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                  AI
                </span>
              </div>
              <p className="text-[11px] text-slate-400 truncate max-w-[130px]">
                {organization?.name ?? '—'}
              </p>
            </div>
          </div>
        </div>

        <nav className="flex-1 px-3 py-2 space-y-0.5 overflow-y-auto custom-scrollbar">
          <div className="text-[10px] uppercase tracking-wider font-semibold text-slate-300 px-3 py-1">
            My Workspace
          </div>
          {NAV_ITEMS.map((item) => {
            const isActive = view === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setView(item.id)}
                className={`w-full flex items-center px-3 py-2 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                  isActive
                    ? 'bg-emerald-600/20 text-emerald-300 border border-emerald-500/30'
                    : 'text-slate-300 hover:text-slate-100 hover:bg-slate-800/60'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <span className={isActive ? 'text-emerald-400' : 'text-slate-400'}>
                    {item.icon}
                  </span>
                  <span>{item.label}</span>
                </div>
              </button>
            );
          })}
        </nav>

        {/* Who is signed in, and the way out. */}
        <div className="p-3 border-t border-slate-800/80 bg-slate-950/40 flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-slate-800 border border-slate-700 flex items-center justify-center text-xs font-bold text-slate-300 font-mono shrink-0">
            {initialsFor(user)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-slate-200 truncate">{displayName(user)}</div>
            <div className="text-[10px] text-slate-500">Agent</div>
          </div>
          <button
            onClick={logout}
            title="Sign out"
            aria-label="Sign out"
            className="p-2 bg-slate-800 hover:bg-rose-600/20 text-slate-400 hover:text-rose-300 rounded-lg transition-colors cursor-pointer shrink-0"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto custom-scrollbar bg-slate-950/40 min-w-0">
        {view === 'dashboard' && <AgentDashboard />}
        {view === 'leads' && <AgentLeads />}
        {view === 'appointments' && <AgentAppointments />}
        {view === 'availability' && <AgentAvailability />}
      </main>
    </div>
  );
};
