import React from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Building2, CalendarClock, CalendarCheck, LayoutDashboard, LogOut, Users } from 'lucide-react';
import { displayName, initialsFor, useAuth } from '../../context/AuthContext';
import { ThemeToggle } from '../layout/ThemeToggle';
import { AgentAppointments } from './AgentAppointments';
import { AgentAvailability } from './AgentAvailability';
import { AgentDashboard } from './AgentDashboard';
import { AgentLeads } from './AgentLeads';

type AgentView = 'dashboard' | 'leads' | 'appointments' | 'availability';

const NAV_ITEMS: Array<{ id: AgentView; label: string; icon: React.ReactNode }> = [
  { id: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard className="w-[18px] h-[18px]" /> },
  { id: 'leads', label: 'My Leads', icon: <Users className="w-[18px] h-[18px]" /> },
  { id: 'appointments', label: 'Appointments', icon: <CalendarClock className="w-[18px] h-[18px]" /> },
  { id: 'availability', label: 'Availability', icon: <CalendarCheck className="w-[18px] h-[18px]" /> },
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
  const { pathname } = useLocation();
  const navigate = useNavigate();
  // The URL is the active view, as in the owner shell (AppContext). Paths are
  // shared with the owner's (/leads, /appointments); which shell answers them is
  // decided by role in Root, not by the path.
  const view = NAV_ITEMS.find((item) => pathname === `/${item.id}`)?.id;
  if (!view) return <Navigate to="/dashboard" replace />;

  return (
    <div className="flex h-screen bg-slate-950 text-slate-100 overflow-hidden font-sans selection:bg-emerald-500 selection:text-on-accent">
      <aside className="w-60 bg-slate-900 border-r border-slate-800 flex flex-col h-screen shrink-0 select-none">
        {/* Brand block, same shape as the owner's. The second line is the
            organization this agent belongs to — the one thing about the office
            their session actually carries. */}
        <div className="h-16 px-5 flex items-center gap-3 shrink-0">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-emerald-600 to-teal-500 flex items-center justify-center shrink-0">
            <Building2 className="w-4 h-4 text-on-accent" />
          </div>
          <div className="min-w-0">
            <div className="font-bold text-sm text-slate-100 tracking-tight leading-tight">EstatePulse</div>
            <p className="text-xs text-slate-400 truncate leading-tight">{organization?.name ?? '—'}</p>
          </div>
        </div>

        <nav className="flex-1 px-3 pt-2 pb-4 overflow-y-auto custom-scrollbar">
          <div className="px-3 pb-1.5 text-2xs font-semibold uppercase tracking-wider text-slate-500">
            My Workspace
          </div>
          <div className="space-y-0.5">
            {NAV_ITEMS.map((item) => {
              const isActive = view === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => item.id !== view && navigate(`/${item.id}`)}
                  aria-current={isActive ? 'page' : undefined}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors cursor-pointer ${
                    isActive
                      ? 'bg-emerald-500/10 text-emerald-300 font-semibold'
                      : 'text-slate-300 font-medium hover:text-slate-100 hover:bg-slate-800/70'
                  }`}
                >
                  <span className={isActive ? 'text-emerald-400' : 'text-slate-500'}>{item.icon}</span>
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
        </nav>

        {/* Who is signed in, theme, and the way out. */}
        <div className="p-3 border-t border-slate-800 flex items-center gap-1">
          <div className="min-w-0 flex-1 flex items-center gap-2.5 p-1.5">
            <div className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-xs font-bold text-slate-300 shrink-0">
              {initialsFor(user)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-slate-200 truncate leading-tight">{displayName(user)}</div>
              <div className="text-xs text-slate-500 leading-tight">Agent</div>
            </div>
          </div>
          <ThemeToggle />
          <button
            onClick={logout}
            title="Sign out"
            aria-label="Sign out"
            className="p-2 rounded-lg text-slate-400 hover:text-rose-300 hover:bg-rose-500/10 transition-colors cursor-pointer shrink-0"
          >
            <LogOut className="w-[18px] h-[18px]" />
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto custom-scrollbar min-w-0">
        {view === 'dashboard' && <AgentDashboard />}
        {view === 'leads' && <AgentLeads />}
        {view === 'appointments' && <AgentAppointments />}
        {view === 'availability' && <AgentAvailability />}
      </main>
    </div>
  );
};
