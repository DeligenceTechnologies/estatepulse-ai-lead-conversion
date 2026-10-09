import React from 'react';
import { Eye, Loader2, Pencil, ShieldCheck, Trash2 } from 'lucide-react';
import { displayName, initialsFor } from '../../context/AuthContext';
import type { TeamMember, UserStatus } from '../../utils/usersApi';
import { DAY_SHORT, isWorkingNow } from '../../utils/workingHours';

/**
 * The pieces a team member is drawn with on the Team Members screen. The card
 * (grid) and the row (list) show only the essentials — who, role, status,
 * mobile, member since — and open MemberDrawer, which holds everything else.
 */

const AVATAR_GRADIENTS = [
  'from-emerald-500 to-teal-600',
  'from-sky-500 to-indigo-600',
  'from-violet-500 to-fuchsia-600',
  'from-amber-500 to-orange-600',
  'from-rose-500 to-red-600',
  'from-cyan-500 to-blue-600',
] as const;

/** The same colour for the same person on every render. */
export const gradientFor = (id: string): string => {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return AVATAR_GRADIENTS[Math.abs(hash) % AVATAR_GRADIENTS.length];
};

export const formatDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

/** "today", "5 days", "3 mo", "2 yrs" since `iso`. */
export function timeSince(iso: string | null, now = new Date()): string {
  if (!iso) return '—';
  const days = Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
  if (days < 1) return 'today';
  if (days < 31) return `${days} day${days === 1 ? '' : 's'}`;
  const months = Math.floor(days / 30.44);
  if (months < 12) return `${months} mo`;
  const years = Math.floor(months / 12);
  return `${years} yr${years === 1 ? '' : 's'}`;
}

/** "today", "3 days ago", "never". */
export const lastSeen = (iso: string | null, now = new Date()): string => {
  if (!iso) return 'never';
  const since = timeSince(iso, now);
  return since === 'today' ? 'today' : `${since} ago`;
};

/** Whether the member is on shift right now, in their own timezone. Inactive members never are. */
export const onShift = (member: TeamMember, now: Date): boolean =>
  member.status === 'active' && isWorkingNow(member.workingHours, member.timezone, now);

export const Avatar: React.FC<{ member: TeamMember; size?: 'md' | 'lg'; working?: boolean }> = ({
  member,
  size = 'md',
  working,
}) => (
  <div className="relative shrink-0">
    <div
      className={`rounded-full bg-gradient-to-br ${gradientFor(member.id)} flex items-center justify-center font-bold text-on-accent shadow-md ${
        size === 'lg' ? 'w-12 h-12 text-sm' : 'w-9 h-9 text-xs'
      } ${member.status === 'inactive' ? 'opacity-50 grayscale' : ''}`}
    >
      {initialsFor(member)}
    </div>
    {working !== undefined && (
    <span
      title={working ? 'Working now' : 'Off shift'}
      className={`absolute bottom-0 right-0 rounded-full ring-2 ring-slate-900 ${
        size === 'lg' ? 'w-3.5 h-3.5' : 'w-2.5 h-2.5'
      } ${working ? 'bg-emerald-400' : 'bg-slate-600'}`}
    />
    )}
  </div>
);

/** One badge per role the member holds, Owner first. */
export const RoleBadges: React.FC<{ member: TeamMember }> = ({ member }) => (
  <div className="flex flex-wrap gap-1">
    {[...member.roles]
      .sort((a, b) => Number(b.isSystem) - Number(a.isSystem))
      .map((role) => (
        <span
          key={role.id}
          className={`inline-flex items-center gap-1 text-2xs font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap ${
            role.isSystem
              ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
              : 'bg-slate-800 text-slate-300 border-slate-700'
          }`}
        >
          {role.isSystem && <ShieldCheck className="w-3 h-3" />}
          {role.name}
        </span>
      ))}
  </div>
);

const STATUS_STYLES: Record<UserStatus, string> = {
  active: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  inactive: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
};

export const StatusBadge: React.FC<{ status: UserStatus }> = ({ status }) => (
  <span
    className={`inline-flex items-center gap-1.5 text-2xs font-semibold px-2 py-0.5 rounded-full border capitalize ${STATUS_STYLES[status]}`}
  >
    <span className="w-1.5 h-1.5 rounded-full bg-current" />
    {status}
  </span>
);

/** "Working now" / "Off now", with today's hours. */
export const ShiftChip: React.FC<{ member: TeamMember; working: boolean }> = ({ member, working }) => (
  <span
    className={`inline-flex items-center gap-1 text-2xs font-semibold px-1.5 py-0.5 rounded-md whitespace-nowrap ${
      working ? 'bg-emerald-500/10 text-emerald-300' : 'bg-slate-800 text-slate-400'
    }`}
  >
    <span className={`w-1.5 h-1.5 rounded-full ${working ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'}`} />
    {working ? 'Working now' : member.status === 'inactive' ? 'Inactive' : 'Off now'}
  </span>
);

/**
 * Active leads against capacity, as "12 / 25" with a bar. Active leads are not
 * sent by the server yet (no lead assignment on this backend), so they read "—".
 */
export const LeadLoad: React.FC<{ member: TeamMember; compact?: boolean }> = ({ member, compact }) => {
  const cap = member.maxActiveLeads;
  const active = member.activeLeads;
  // An older server that does not send the capacity yet.
  if (cap === undefined || cap === null) return <span className="text-xs text-slate-500">—</span>;
  if (cap === 0) {
    return <span className="text-2xs font-medium text-slate-500 italic">Not taking leads</span>;
  }
  const pct = active === undefined ? 0 : Math.min(100, Math.round((active / cap) * 100));
  const tone = pct >= 90 ? 'bg-rose-500' : pct >= 70 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <div
      className={compact ? 'w-28' : 'w-full'}
      title={active === undefined ? 'Active lead count appears once lead assignment is connected' : `${pct}% of capacity`}
    >
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <span className="text-xs font-bold text-slate-100 tabular-nums">
          {active ?? '—'}
          <span className="text-slate-500 font-medium"> / {cap}</span>
        </span>
        {!compact && <span className="text-2xs text-slate-500">active / capacity</span>}
      </div>
      <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
        <div className={`h-full rounded-full ${tone} transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
};

export const Identity: React.FC<{ member: TeamMember; isSelf: boolean }> = ({ member, isSelf }) => (
  <div className="flex items-center gap-3 min-w-0">
    <Avatar member={member} />
    <div className="min-w-0">
      <div className="text-sm font-semibold text-slate-100 truncate">
        {displayName(member)}
        {isSelf && <span className="ml-1.5 text-2xs font-medium text-slate-500">(you)</span>}
      </div>
      <div className="text-xs text-slate-500 truncate">{member.email}</div>
    </div>
  </div>
);

/** Opens on click, Enter or Space — the card and the row are buttons to the member's details. */
const openProps = (onOpen: () => void, name: string) => ({
  role: 'button' as const,
  tabIndex: 0,
  'aria-label': `View ${name}`,
  onClick: onOpen,
  onKeyDown: (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen();
    }
  },
});

/** Today's day of week (0 = Sunday) in the member's zone, or -1 for a zone the browser does not know. */
export const todayIndex = (member: TeamMember, now: Date): number => {
  try {
    return (DAY_SHORT as readonly string[]).indexOf(
      now.toLocaleDateString('en-US', { timeZone: member.timezone, weekday: 'short' }),
    );
  } catch {
    return -1;
  }
};


/** Stops a click on an action from also opening the details panel. */
const stop = (fn: () => void) => (e: React.MouseEvent) => {
  e.stopPropagation();
  fn();
};

const actionBtn =
  'w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed';

/** View, Edit and Delete — the last thing in every row and card. */
export const MemberActions: React.FC<{
  name: string;
  canEdit: boolean;
  canDelete: boolean;
  deleting: boolean;
  onView: () => void;
  onEdit: () => void;
  onDelete: () => void;
}> = ({ name, canEdit, canDelete, deleting, onView, onEdit, onDelete }) => (
  <div className="flex items-center justify-end gap-1" onKeyDown={(e) => e.stopPropagation()}>
    <button
      type="button"
      onClick={stop(onView)}
      title="View details"
      aria-label={`View ${name}`}
      className={`${actionBtn} hover:text-sky-300 hover:bg-sky-500/10`}
    >
      <Eye className="w-3.5 h-3.5" />
    </button>
    {canEdit && (
      <button
        type="button"
        onClick={stop(onEdit)}
        disabled={deleting}
        title="Edit"
        aria-label={`Edit ${name}`}
        className={`${actionBtn} hover:text-emerald-300 hover:bg-emerald-500/10`}
      >
        <Pencil className="w-3.5 h-3.5" />
      </button>
    )}
    {canDelete && (
      <button
        type="button"
        onClick={stop(onDelete)}
        disabled={deleting}
        title="Delete"
        aria-label={`Delete ${name}`}
        className={`${actionBtn} hover:text-rose-300 hover:bg-rose-500/10`}
      >
        {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
      </button>
    )}
  </div>
);

/** The grid view's card: the same essentials as a list row — everything else is in the details panel. */
export const MemberCard: React.FC<{
  member: TeamMember;
  isSelf: boolean;
  onOpen: () => void;
  actions: React.ReactNode;
}> = ({ member, isSelf, onOpen, actions }) => (
  <article
    {...openProps(onOpen, displayName(member))}
    className="flex flex-col gap-4 p-4 bg-slate-900/80 border border-slate-800 rounded-2xl cursor-pointer transition-all duration-200 hover:border-emerald-500/40 hover:shadow-xl hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
  >
    <div className="flex items-start justify-between gap-2">
      <Identity member={member} isSelf={isSelf} />
      <StatusBadge status={member.status} />
    </div>
    <RoleBadges member={member} />
    <div className="grid grid-cols-2 gap-2 text-xs">
      <div className="min-w-0">
        <div className="text-2xs font-semibold uppercase tracking-wider text-slate-500">Mobile</div>
        <div className="font-mono text-slate-200 truncate">{member.phone || '—'}</div>
      </div>
      <div className="min-w-0">
        <div className="text-2xs font-semibold uppercase tracking-wider text-slate-500">Member since</div>
        <div className="text-slate-200">{formatDate(member.createdAt)}</div>
      </div>
    </div>
    <div className="mt-auto pt-3 border-t border-slate-800">{actions}</div>
  </article>
);

/** The list view's row: Member, Role, Status, Mobile, Member since, Actions. */
export const MemberRow: React.FC<{
  member: TeamMember;
  isSelf: boolean;
  onOpen: () => void;
  actions: React.ReactNode;
}> = ({ member, isSelf, onOpen, actions }) => (
  <tr
    {...openProps(onOpen, displayName(member))}
    className="cursor-pointer hover:bg-slate-800/30 transition-colors align-middle focus:outline-none focus-visible:bg-slate-800/40"
  >
    <td className="px-4 py-3 max-w-[18rem]">
      <Identity member={member} isSelf={isSelf} />
    </td>
    <td className="px-4 py-3 max-w-[14rem]">
      <RoleBadges member={member} />
    </td>
    <td className="px-4 py-3">
      <StatusBadge status={member.status} />
    </td>
    <td className="px-4 py-3 font-mono text-xs text-slate-300 whitespace-nowrap">{member.phone || '—'}</td>
    <td className="px-4 py-3 whitespace-nowrap text-xs text-slate-300">{formatDate(member.createdAt)}</td>
    <td className="px-4 py-3">{actions}</td>
  </tr>
);
