import {
  LayoutDashboard,
  Users,
  MessageSquare,
  PhoneCall,
  CalendarCheck,
  Repeat,
  UserCheck,
  Plug,
  Bot,
  BarChart3,
  Webhook,
  Clock,
  ShieldCheck,
  Settings,
} from 'lucide-react';
import { useApp, isLockedView, type AppView } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import type { NavGroup, NavItem } from './DashboardSidebar';

type OwnerNavItem = NavItem & { id: AppView };

/**
 * The owner app's navigation, ordered by how often each page is used: the
 * overview first, then the daily lead work, then the team, and one-time
 * settings last. Within a group the most-used page leads. Short labels — the
 * page itself carries the full title. DashboardSidebar renders it.
 */
export function useOwnerNav(): NavGroup[] {
  const { leads } = useApp();
  const { role, agentProfileId, can } = useAuth();
  const isOwner = role === 'owner';

  const groups: { label?: string; items: OwnerNavItem[] }[] = [
    {
      label: 'Overview',
      items: [
        { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
        { id: 'analytics', label: 'Analytics', icon: BarChart3 },
      ],
    },
    {
      label: 'Pipeline',
      items: [
        { id: 'leads', label: 'Leads', icon: Users, badge: leads.length },
        { id: 'appointments', label: 'Appointments', icon: CalendarCheck },
        { id: 'conversations', label: 'Conversations', icon: MessageSquare },
        { id: 'calls', label: 'AI Calls', icon: PhoneCall },
        { id: 'followups', label: 'Follow-ups', icon: Repeat },
      ],
    },
    {
      label: 'Team',
      items: [
        // Every user in the organization (owners, agents, custom roles), not
        // only agents — hence "Team Members". The view id stays `agents` so
        // existing /agents links keep working.
        ...(can('user.read') ? [{ id: 'agents' as const, label: 'Team Members', icon: UserCheck }] : []),
        // Only for an owner who takes leads: an agent profile is what the screen
        // reads and writes, and an owner without one has no hours to set.
        ...(isOwner && agentProfileId
          ? [{ id: 'my_availability' as const, label: 'My Availability', icon: Clock }]
          : []),
        ...(can('role.read') ? [{ id: 'roles' as const, label: 'Roles & Permissions', icon: ShieldCheck }] : []),
      ],
    },
    {
      label: 'Configuration',
      items: [
        ...(can('organization.read') ? [{ id: 'settings' as const, label: 'Settings', icon: Settings }] : []),
        { id: 'ai_settings', label: 'AI Assistant', icon: Bot },
        { id: 'lead_sources', label: 'Lead Sources', icon: Webhook },
        { id: 'integrations', label: 'Integrations', icon: Plug },
      ],
    },
  ];

  return groups
    .filter((group) => group.items.length > 0)
    .map((group) => ({
      ...group,
      items: group.items.map((item) => ({ ...item, soon: isLockedView(item.id) })),
    }));
}
