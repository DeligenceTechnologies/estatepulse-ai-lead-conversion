import { useEffect, useState } from 'react';
import {
  LayoutDashboard,
  Users,
  MessageSquare,
  PhoneCall,
  CalendarCheck,
  CalendarClock,
  Repeat,
  UserCheck,
  Plug,
  Bot,
  Webhook,
  Clock,
  ShieldCheck,
  Settings,
  ClipboardCheck,
} from 'lucide-react';
import { useApp, isLockedView, type AppView } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { importReviewEnabled } from '../../utils/fileImportApi';
import type { NavGroup, NavItem } from './DashboardSidebar';

type OwnerNavItem = NavItem & { id: AppView };

/**
 * The owner app's navigation, ordered by how often each page is opened: the
 * overview, then the daily lead work, then scheduling, then the team, and the
 * one-time setup last with Settings at the very bottom. Within a group the
 * most-used page leads. Short labels — the page itself carries the full
 * title. DashboardSidebar renders it.
 */
export function useOwnerNav(): NavGroup[] {
  const { leads } = useApp();
  const { role, agentProfileId, can } = useAuth();
  const isOwner = role === 'owner';
  const [sheetsOn, setSheetsOn] = useState(false);
  useEffect(() => {
    if (isOwner) void importReviewEnabled().then(setSheetsOn);
  }, [isOwner]);

  const canReadOrg = can('organization.read');

  const groups: { label?: string; items: OwnerNavItem[] }[] = [
    {
      label: 'Overview',
      items: [
        { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
      ],
    },
    {
      // The day-to-day work on a lead, in the order it happens: the lead
      // arrives, the AI messages and calls it, then nurtures it.
      label: 'Leads',
      items: [
        { id: 'leads', label: 'All Leads', icon: Users, badge: leads.length },
        { id: 'conversations', label: 'Conversations', icon: MessageSquare },
        { id: 'calls', label: 'AI Calls', icon: PhoneCall },
        { id: 'followups', label: 'Follow-ups', icon: Repeat },
        ...(sheetsOn ? [{ id: 'import_review' as const, label: 'Import Review', icon: ClipboardCheck }] : []),
      ],
    },
    {
      // Booked appointments plus everything read from the calendar connected
      // once under Settings → Calendar, where its meetings are listed too.
      // Its members are added from Team Members.
      label: 'Scheduling',
      items: [
        { id: 'appointments', label: 'Appointments', icon: CalendarCheck },
        ...(canReadOrg
          ? [
              { id: 'team_availability' as const, label: 'Team Availability', icon: CalendarClock },
            ]
          : []),
        // Only for an owner who takes leads: an agent profile is what the screen
        // reads and writes, and an owner without one has no hours to set.
        ...(isOwner && agentProfileId
          ? [{ id: 'my_availability' as const, label: 'My Availability', icon: Clock }]
          : []),
      ],
    },
    {
      label: 'Team',
      items: [
        // Every user in the organization (owners, agents, custom roles), not
        // only agents — hence "Team Members". The view id stays `agents` so
        // existing /agents links keep working.
        ...(can('user.read') ? [{ id: 'agents' as const, label: 'Team Members', icon: UserCheck }] : []),
        ...(can('role.read') ? [{ id: 'roles' as const, label: 'Roles & Permissions', icon: ShieldCheck }] : []),
      ],
    },
    {
      // Where leads come from: connect a channel once, then watch what it sends.
      label: 'Lead Intake',
      items: [
        { id: 'integrations', label: 'Lead Integrations', icon: Plug },
        { id: 'lead_sources', label: 'Lead Sources', icon: Webhook },
      ],
    },
    {
      label: 'Setup',
      items: [
        { id: 'ai_settings', label: 'AI Assistant', icon: Bot },
        ...(canReadOrg ? [{ id: 'settings' as const, label: 'Settings', icon: Settings }] : []),
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
