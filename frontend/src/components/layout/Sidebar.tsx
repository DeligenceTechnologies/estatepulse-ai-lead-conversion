import React, { useState } from 'react';
import {
  LayoutDashboard,
  Users,
  MessageSquare,
  PhoneCall,
  Calendar,
  GitFork,
  UserCheck,
  Cpu,
  Sliders,
  BarChart3,
  Building2,
  LogOut,
  Webhook,
  Clock
} from 'lucide-react';
import { useApp, AppView, isLockedView } from '../../context/AppContext';
import { displayName, initialsFor, roleLabel, useAuth } from '../../context/AuthContext';
import { ThemeToggle } from './ThemeToggle';

type NavItem = { id: AppView; label: string; icon: React.ReactNode; badge?: number };

export const Sidebar: React.FC = () => {
  const { activeView, setActiveView, leads } = useApp();
  const { user, role, organization, agentProfileId, logout } = useAuth();
  const [profileOpen, setProfileOpen] = useState(false);
  const isOwner = role === 'owner';

  // Grouped by the job the owner is doing: working leads, managing the team,
  // and one-time setup. Short labels — the page itself carries the full title.
  const groups: { label?: string; items: NavItem[] }[] = [
    { items: [{ id: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard className="w-[18px] h-[18px]" /> }] },
    {
      label: 'Pipeline',
      items: [
        { id: 'leads', label: 'Leads', icon: <Users className="w-[18px] h-[18px]" />, badge: leads.length },
        { id: 'conversations', label: 'Conversations', icon: <MessageSquare className="w-[18px] h-[18px]" /> },
        { id: 'calls', label: 'AI Calls', icon: <PhoneCall className="w-[18px] h-[18px]" /> },
        { id: 'appointments', label: 'Appointments', icon: <Calendar className="w-[18px] h-[18px]" /> },
        { id: 'followups', label: 'Follow-ups', icon: <GitFork className="w-[18px] h-[18px]" /> },
      ],
    },
    {
      label: 'Team',
      items: [
        { id: 'agents', label: 'Agents', icon: <UserCheck className="w-[18px] h-[18px]" /> },
        // Only for an owner who takes leads: an agent profile is what the screen
        // reads and writes, and an owner without one has no hours to set.
        ...(isOwner && agentProfileId
          ? [{ id: 'my_availability' as const, label: 'My Availability', icon: <Clock className="w-[18px] h-[18px]" /> }]
          : []),
      ],
    },
    {
      label: 'Setup',
      items: [
        { id: 'lead_sources', label: 'Lead Sources', icon: <Webhook className="w-[18px] h-[18px]" /> },
        { id: 'integrations', label: 'Integrations', icon: <Cpu className="w-[18px] h-[18px]" /> },
        { id: 'ai_settings', label: 'AI Assistant', icon: <Sliders className="w-[18px] h-[18px]" /> },
        { id: 'analytics', label: 'Analytics', icon: <BarChart3 className="w-[18px] h-[18px]" /> },
      ],
    },
  ];

  return (
    <aside className="w-60 bg-slate-900 border-r border-slate-800 flex flex-col h-screen shrink-0 select-none">
      {/* Brand */}
      <div className="h-16 px-5 flex items-center gap-3 shrink-0">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-emerald-600 to-teal-500 flex items-center justify-center shrink-0">
          <Building2 className="w-4 h-4 text-on-accent" />
        </div>
        <div className="min-w-0">
          <div className="font-bold text-sm text-slate-100 tracking-tight leading-tight">EstatePulse</div>
          <p className="text-xs text-slate-400 truncate leading-tight">{organization?.name ?? '—'}</p>
        </div>
      </div>

      <nav className="flex-1 px-3 pb-4 overflow-y-auto custom-scrollbar">
        {groups.map((group, gi) => (
          <div key={gi} className={gi === 0 ? 'pt-2' : 'pt-5'}>
            {group.label && (
              <div className="px-3 pb-1.5 text-2xs font-semibold uppercase tracking-wider text-slate-500">
                {group.label}
              </div>
            )}
            <div className="space-y-0.5">
              {group.items.map(item => {
                const isActive = activeView === item.id;
                const soon = isLockedView(item.id);
                return (
                  <button
                    key={item.id}
                    onClick={() => setActiveView(item.id)}
                    aria-current={isActive ? 'page' : undefined}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors cursor-pointer ${
                      isActive
                        ? 'bg-emerald-500/10 text-emerald-300 font-semibold'
                        : 'text-slate-300 font-medium hover:text-slate-100 hover:bg-slate-800/70'
                    }`}
                  >
                    <span className={isActive ? 'text-emerald-400' : 'text-slate-500'}>{item.icon}</span>
                    <span className="flex-1 text-left truncate">{item.label}</span>
                    {soon && <span className="text-2xs text-slate-500">Soon</span>}
                    {!!item.badge && (
                      <span className="text-2xs font-semibold px-1.5 min-w-5 text-center rounded-full bg-slate-800 text-slate-300">
                        {item.badge}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Who is signed in, theme, and the way out. */}
      <div className="relative p-3 border-t border-slate-800 flex items-center gap-1">
        {/* Read-only profile card, owner only for now. */}
        {isOwner && profileOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setProfileOpen(false)} />
            <div className="absolute bottom-full left-3 right-3 mb-2 z-50 bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-xl space-y-3">
              <div className="flex items-center gap-2.5">
                <div className="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center text-sm font-bold text-slate-300 shrink-0">
                  {initialsFor(user)}
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-slate-100 truncate">{displayName(user)}</div>
                  <div className="text-xs text-emerald-400">{roleLabel(role)}</div>
                </div>
              </div>
              <dl className="text-xs space-y-2">
                <div>
                  <dt className="text-slate-500 uppercase tracking-wider text-2xs">Email</dt>
                  <dd className="text-slate-200 truncate">{user?.email}</dd>
                </div>
                <div>
                  <dt className="text-slate-500 uppercase tracking-wider text-2xs">Organization</dt>
                  <dd className="text-slate-200 truncate">{organization?.name}</dd>
                </div>
              </dl>
            </div>
          </>
        )}
        <button
          type="button"
          disabled={!isOwner}
          onClick={() => setProfileOpen(o => !o)}
          aria-expanded={isOwner ? profileOpen : undefined}
          className={`min-w-0 flex-1 flex items-center gap-2.5 text-left rounded-lg p-1.5 ${isOwner ? 'cursor-pointer hover:bg-slate-800/70' : 'cursor-default'}`}
        >
          <div className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-xs font-bold text-slate-300 shrink-0">
            {initialsFor(user)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-slate-200 truncate leading-tight">{displayName(user)}</div>
            <div className="text-xs text-slate-500 leading-tight">{roleLabel(role)}</div>
          </div>
        </button>
        <ThemeToggle />
        <button
          onClick={logout}
          title="Sign out"
          aria-label="Sign out"
          className="p-2 rounded-lg text-slate-400 hover:text-rose-300 hover:bg-rose-500/10 transition-colors cursor-pointer shrink-0"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </aside>
  );
};
