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
  Clock,
  ShieldCheck,
  Settings,
  ClipboardCheck,
  Copy,
  CreditCard,
} from 'lucide-react';
import { isLockedView, type AppView } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { LEADS_CHANGED_EVENT, leadsApi } from '../../api/client';
import { consentReviewCount } from '../../utils/consentReviewApi';
import { duplicateCount } from '../../utils/duplicatesApi';
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
  const { role, agentProfileId, can } = useAuth();
  const isOwner = role === 'owner';
  const [consentOn, setConsentOn] = useState(false);
  // Consent Review shows while a lead added by hand waits there for its consent.
  useEffect(() => {
    if (!isOwner) return;
    const check = () => void consentReviewCount().then((awaiting) => setConsentOn(awaiting > 0));
    check();
    window.addEventListener(LEADS_CHANGED_EVENT, check);
    return () => window.removeEventListener(LEADS_CHANGED_EVENT, check);
  }, [isOwner]);

  // The All Leads badge counts only leads still at New, across every lead (not just the page loaded),
  // from the same stats the Leads tabs use. Kept current on every lead change and once a minute.
  const [newLeads, setNewLeads] = useState(0);
  useEffect(() => {
    const load = () =>
      void leadsApi
        .stats()
        .then((s) => setNewLeads(s.byStatus.new ?? 0))
        .catch(() => undefined);
    load();
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, 60_000);
    window.addEventListener(LEADS_CHANGED_EVENT, load);
    return () => {
      window.clearInterval(id);
      window.removeEventListener(LEADS_CHANGED_EVENT, load);
    };
  }, []);

  // Duplicates to review, for the badge; only for someone who sees every lead (merging moves history between them).
  const canMerge = can('lead.read');
  const [duplicates, setDuplicates] = useState(0);
  useEffect(() => {
    if (!canMerge) return;
    const load = () => void duplicateCount().then(setDuplicates);
    load();
    window.addEventListener(LEADS_CHANGED_EVENT, load);
    return () => window.removeEventListener(LEADS_CHANGED_EVENT, load);
  }, [canMerge]);

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
        { id: 'leads', label: 'All Leads', icon: Users, badge: newLeads, badgeTitle: `${newLeads} new lead${newLeads === 1 ? '' : 's'}` },
        { id: 'conversations', label: 'Conversations', icon: MessageSquare },
        { id: 'calls', label: 'AI Calls', icon: PhoneCall },
        { id: 'followups', label: 'Follow-ups', icon: Repeat },
        ...(consentOn ? [{ id: 'consent_review' as const, label: 'Consent Review', icon: ClipboardCheck }] : []),
        ...(canMerge
          ? [{ id: 'duplicates' as const, label: 'Duplicates', icon: Copy, badge: duplicates, badgeTitle: `${duplicates} possible duplicate${duplicates === 1 ? '' : 's'} to review` }]
          : []),
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
      label: 'Lead Intake',
      items: [{ id: 'integrations', label: 'Integrations', icon: Plug }],
    },
    {
      label: 'Setup',
      items: [
        { id: 'ai_settings', label: 'AI Assistant', icon: Bot },
        ...(can('billing.read') ? [{ id: 'pricing' as const, label: 'Plans & Billing', icon: CreditCard }] : []),
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
