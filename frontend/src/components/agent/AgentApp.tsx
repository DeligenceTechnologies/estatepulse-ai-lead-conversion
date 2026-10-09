import React from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { CalendarCheck, Clock, LayoutDashboard, Users } from 'lucide-react';
import { AppShell } from '../layout/AppShell';
import type { NavItem } from '../layout/DashboardSidebar';
import { AgentAppointments } from './AgentAppointments';
import { AgentAvailability } from './AgentAvailability';
import { AgentDashboard } from './AgentDashboard';
import { AgentLeads } from './AgentLeads';

type AgentView = 'dashboard' | 'leads' | 'appointments' | 'availability';

const NAV_ITEMS: Array<NavItem & { id: AgentView }> = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'leads', label: 'My Leads', icon: Users },
  { id: 'appointments', label: 'Appointments', icon: CalendarCheck },
  { id: 'availability', label: 'My Availability', icon: Clock },
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
 * The chrome is the same AppShell (navbar + DashboardSidebar) the owner gets,
 * so the two do not feel like different products. What it leaves out is everything an agent has no business seeing —
 * the demo controls, the webhook tester, and every owner-only destination.
 *
 * The server is still the boundary: every route behind the owner's screens is
 * guarded by OwnerGuard and answers an agent 403 whatever the UI shows.
 */
export const AgentApp: React.FC = () => {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  // The URL is the active view, as in the owner shell (AppContext). Paths are
  // shared with the owner's (/leads, /appointments); which shell answers them is
  // decided by role in Root, not by the path.
  const view = NAV_ITEMS.find((item) => pathname === `/${item.id}`)?.id;
  if (!view) return <Navigate to="/dashboard" replace />;

  return (
    <AppShell
      groups={[{ label: 'My Workspace', items: NAV_ITEMS }]}
      activeId={view}
      onNavigate={(id) => id !== view && navigate(`/${id}`)}
    >
      {view === 'dashboard' && <AgentDashboard />}
      {view === 'leads' && <AgentLeads />}
      {view === 'appointments' && <AgentAppointments />}
      {view === 'availability' && <AgentAvailability />}
    </AppShell>
  );
};
