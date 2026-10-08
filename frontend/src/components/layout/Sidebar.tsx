import React from 'react';
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
  Webhook,
  Clock
} from 'lucide-react';
import { useApp, AppView, isLockedView } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { ProfileMenu, SignOutButton } from '../auth/ProfileMenu';
import { ThemeToggle } from './ThemeToggle';

type NavItem = { id: AppView; label: string; icon: React.ReactNode; badge?: number };

export const Sidebar: React.FC = () => {
  const { activeView, setActiveView, leads } = useApp();
  const { role, organization, agentProfileId } = useAuth();
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
        <ProfileMenu />
        <ThemeToggle />
        <SignOutButton />
      </div>
    </aside>
  );
};
