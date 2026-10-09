import React, { useEffect, useRef, useState } from 'react';
import {
  CalendarDays,
  Check,
  Clock,
  Copy,
  Gauge,
  Globe,
  Loader2,
  LogIn,
  Mail,
  Pencil,
  Phone,
  RefreshCw,
  Timer,
  Trash2,
  X,
} from 'lucide-react';
import { displayName } from '../../context/AuthContext';
import type { TeamMember } from '../../utils/usersApi';
import {
  DAY_SHORT,
  WEEK_ORDER,
  formatTime,
  localTimeIn,
  normalizeWeek,
  nowIn,
  summarizeWeek,
  toMinutes,
  utcOffset,
  weeklyHours,
} from '../../utils/workingHours';
import {
  Avatar,
  LeadLoad,
  RoleBadges,
  StatusBadge,
  formatDate,
  lastSeen,
  timeSince,
  todayIndex,
} from './MemberParts';

interface MemberDrawerProps {
  member: TeamMember;
  isSelf: boolean;
  now: Date;
  canEdit: boolean;
  canDelete: boolean;
  deleting: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
}

const DAY_MINUTES = 24 * 60;

/** A small copy button that confirms with a tick for a moment. */
const CopyButton: React.FC<{ value: string; label: string }> = ({ value, label }) => {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: nothing to confirm */
    }
  };
  return (
    <button
      type="button"
      onClick={() => void copy()}
      title={copied ? 'Copied' : `Copy ${label}`}
      aria-label={`Copy ${label}`}
      className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 transition-colors cursor-pointer ${
        copied ? 'text-emerald-300 bg-emerald-500/10' : 'text-slate-500 hover:text-slate-200 hover:bg-slate-800'
      }`}
    >
      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
};

/** One of the three headline figures under the header. */
const StatTile: React.FC<{ icon: React.ReactNode; label: string; value: React.ReactNode; hint?: string }> = ({
  icon,
  label,
  value,
  hint,
}) => (
  <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-3 min-w-0">
    <div className="flex items-center gap-1.5 text-slate-500">
      {icon}
      <span className="text-2xs font-semibold uppercase tracking-wider truncate">{label}</span>
    </div>
    <div className="mt-1.5 text-base font-bold text-white tabular-nums leading-tight truncate">{value}</div>
    {hint && <div className="text-2xs text-slate-500 truncate mt-0.5">{hint}</div>}
  </div>
);

const Section: React.FC<{ title: string; aside?: React.ReactNode; children: React.ReactNode }> = ({
  title,
  aside,
  children,
}) => (
  <section className="px-5 py-5 border-b border-slate-800/80 last:border-b-0">
    <div className="flex items-center justify-between gap-2 mb-3">
      <h4 className="text-2xs font-bold uppercase tracking-wider text-slate-400">{title}</h4>
      {aside}
    </div>
    {children}
  </section>
);

/** An icon, a label and a value, optionally with a trailing control (copy). */
const InfoRow: React.FC<{ icon: React.ReactNode; label: string; trailing?: React.ReactNode; children: React.ReactNode }> = ({
  icon,
  label,
  trailing,
  children,
}) => (
  <div className="flex items-center gap-3 py-2">
    <span className="w-8 h-8 rounded-lg bg-slate-800/70 text-slate-400 flex items-center justify-center shrink-0">{icon}</span>
    <div className="min-w-0 flex-1">
      <div className="text-2xs font-medium text-slate-500">{label}</div>
      <div className="text-xs text-slate-100 font-medium truncate">{children}</div>
    </div>
    {trailing}
  </div>
);

/**
 * Seven rows, Monday first, each a 24-hour track with the working span filled
 * in. Today's row is marked, with a line at the member's current local time.
 */
const WeekTimeline: React.FC<{ member: TeamMember; now: Date }> = ({ member, now }) => {
  const week = normalizeWeek(member.workingHours);
  const today = todayIndex(member, now);
  const current = nowIn(member.timezone, now);
  const nowPct = current ? (toMinutes(current.time) / DAY_MINUTES) * 100 : null;

  return (
    <div className="space-y-1.5">
      {WEEK_ORDER.map((d) => {
        const day = week[d];
        const isToday = d === today;
        const left = (toMinutes(day.startTime) / DAY_MINUTES) * 100;
        const width = Math.max(0, ((toMinutes(day.endTime) - toMinutes(day.startTime)) / DAY_MINUTES) * 100);
        return (
          <div
            key={d}
            className={`grid grid-cols-[2.75rem_1fr_6.5rem] items-center gap-3 px-2 py-1.5 rounded-lg ${
              isToday ? 'bg-emerald-500/5 ring-1 ring-inset ring-emerald-500/20' : ''
            }`}
          >
            <span className={`text-xs font-semibold ${isToday ? 'text-emerald-300' : day.isAvailable ? 'text-slate-200' : 'text-slate-500'}`}>
              {DAY_SHORT[d]}
            </span>
            <div className="relative h-2 rounded-full bg-slate-800">
              {day.isAvailable && (
                <div
                  className={`absolute inset-y-0 rounded-full ${isToday ? 'bg-emerald-400' : 'bg-emerald-500/60'}`}
                  style={{ left: `${left}%`, width: `${width}%` }}
                />
              )}
              {isToday && nowPct !== null && (
                <div
                  title={`Now · ${localTimeIn(member.timezone, now) ?? ''}`}
                  className="absolute -top-1 -bottom-1 w-0.5 rounded-full bg-white shadow"
                  style={{ left: `${nowPct}%` }}
                />
              )}
            </div>
            <span className={`text-2xs text-right tabular-nums ${day.isAvailable ? 'text-slate-300' : 'text-slate-500 italic'}`}>
              {day.isAvailable ? `${formatTime(day.startTime)} – ${formatTime(day.endTime)}` : 'Off'}
            </span>
          </div>
        );
      })}
      <div className="grid grid-cols-[2.75rem_1fr_6.5rem] gap-3 px-2 text-2xs text-slate-600">
        <span />
        <div className="flex justify-between">
          <span>12a</span>
          <span>6a</span>
          <span>12p</span>
          <span>6p</span>
          <span>12a</span>
        </div>
        <span />
      </div>
    </div>
  );
};

/**
 * Everything about one member, in a panel sliding in from the right: who they
 * are and how to reach them, their lead load, a timeline of their working
 * week in their own timezone, and account history. Edit and Delete sit in a
 * footer that stays in view. Escape or a click outside closes it.
 */
export const MemberDrawer: React.FC<MemberDrawerProps> = ({
  member,
  isSelf,
  now,
  canEdit,
  canDelete,
  deleting,
  onEdit,
  onDelete,
  onClose,
}) => {
  const week = normalizeWeek(member.workingHours);
  const local = localTimeIn(member.timezone, now);
  const workingDays = week.filter((d) => d.isAvailable).length;
  const name = displayName(member);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-labelledby="member-drawer-title">
      <div className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm animate-fade-in" onClick={onClose} />

      <aside className="relative w-full sm:max-w-lg h-full bg-slate-900 border-l border-slate-800 shadow-2xl flex flex-col animate-slide-in-right">
        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
          {/* Identity */}
          <div className="relative border-b border-slate-800 bg-slate-950/40">
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="absolute top-3 right-3 w-8 h-8 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 flex items-center justify-center cursor-pointer transition-colors"
            >
              <X className="w-4 h-4" />
            </button>

            <div className="px-5 pt-6 pb-5">
              <div className="flex items-center gap-4 pr-8">
                <div className="p-1 rounded-full border border-slate-800 bg-slate-900">
                  <Avatar member={member} size="lg" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 id="member-drawer-title" className="text-lg font-bold text-white tracking-tight truncate">
                    {name}
                    {isSelf && <span className="ml-2 text-xs font-medium text-slate-500">(you)</span>}
                  </h3>
                  <p className="text-xs text-slate-400 truncate">{member.email}</p>
                </div>
              </div>

              <dl className="mt-4 rounded-xl border border-slate-800 bg-slate-900/60 divide-y divide-slate-800/70 text-xs">
                <div className="flex items-center gap-3 px-3.5 py-2.5">
                  <dt className="w-14 shrink-0 text-2xs font-semibold uppercase tracking-wider text-slate-500">Status</dt>
                  <dd>
                    <StatusBadge status={member.status} />
                  </dd>
                </div>
                <div className="flex items-start gap-3 px-3.5 py-2.5">
                  <dt className="w-14 shrink-0 pt-0.5 text-2xs font-semibold uppercase tracking-wider text-slate-500">
                    {member.roles.length === 1 ? 'Role' : 'Roles'}
                  </dt>
                  <dd className="min-w-0">
                    <RoleBadges member={member} />
                  </dd>
                </div>
              </dl>
            </div>
          </div>

          {/* Headline figures */}
          <div className="grid grid-cols-3 gap-2 px-5 pt-5">
            <StatTile
              icon={<Gauge className="w-3.5 h-3.5" />}
              label="Capacity"
              value={member.maxActiveLeads === 0 ? 'None' : `${member.maxActiveLeads ?? '—'}`}
              hint="leads at once"
            />
            <StatTile
              icon={<Timer className="w-3.5 h-3.5" />}
              label="Weekly"
              value={`${weeklyHours(week)} h`}
              hint={`${workingDays} working day${workingDays === 1 ? '' : 's'}`}
            />
            <StatTile
              icon={<Clock className="w-3.5 h-3.5" />}
              label="Local time"
              value={local ?? '—'}
              hint={utcOffset(member.timezone, now)}
            />
          </div>

          <Section title="Lead load">
            <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-3.5">
              <LeadLoad member={member} />
            </div>
          </Section>

          <Section
            title="Working hours"
            aside={<span className="text-2xs text-slate-500 truncate max-w-[60%]">{summarizeWeek(week)}</span>}
          >
            <WeekTimeline member={member} now={now} />
            <p className="mt-2 text-2xs text-slate-500">
              Times are in {member.timezone.replace(/_/g, ' ')}. The marker on today shows their time right now.
            </p>
          </Section>

          <Section title="Contact">
            <div className="divide-y divide-slate-800/70">
              <InfoRow icon={<Mail className="w-3.5 h-3.5" />} label="Email" trailing={<CopyButton value={member.email} label="email" />}>
                {member.email}
              </InfoRow>
              <InfoRow
                icon={<Phone className="w-3.5 h-3.5" />}
                label="Mobile number"
                trailing={member.phone ? <CopyButton value={member.phone} label="mobile number" /> : undefined}
              >
                <span className="font-mono">{member.phone || '—'}</span>
              </InfoRow>
              <InfoRow icon={<Globe className="w-3.5 h-3.5" />} label="Timezone">
                {member.timezone.replace(/_/g, ' ')} <span className="text-slate-500">· {utcOffset(member.timezone, now)}</span>
              </InfoRow>
            </div>
          </Section>

          <Section title="Account">
            <div className="divide-y divide-slate-800/70">
              <InfoRow icon={<CalendarDays className="w-3.5 h-3.5" />} label="Member since">
                {formatDate(member.createdAt)} <span className="text-slate-500">· {timeSince(member.createdAt, now)}</span>
              </InfoRow>
              <InfoRow icon={<LogIn className="w-3.5 h-3.5" />} label="Last sign-in">
                {member.lastLoginAt ? (
                  <>
                    {formatDate(member.lastLoginAt)} <span className="text-slate-500">· {lastSeen(member.lastLoginAt, now)}</span>
                  </>
                ) : (
                  <span className="text-slate-500">Never signed in</span>
                )}
              </InfoRow>
              <InfoRow icon={<RefreshCw className="w-3.5 h-3.5" />} label="Profile updated">
                {formatDate(member.updatedAt)}
              </InfoRow>
            </div>
          </Section>
        </div>

        {/* Actions: always in view */}
        {(canEdit || canDelete) && (
          <div className="shrink-0 border-t border-slate-800 bg-slate-900/95 backdrop-blur px-5 py-3 flex items-center gap-2">
            {canDelete && (
              <button
                type="button"
                onClick={onDelete}
                disabled={deleting}
                className="h-9 px-3 rounded-lg text-xs font-semibold text-rose-300 border border-rose-500/30 hover:bg-rose-500/10 flex items-center gap-1.5 cursor-pointer transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                Delete
              </button>
            )}
            {canEdit && (
              <button
                type="button"
                onClick={onEdit}
                disabled={deleting}
                className="ml-auto h-9 px-4 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-on-accent text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <Pencil className="w-3.5 h-3.5" />
                Edit member
              </button>
            )}
          </div>
        )}
      </aside>
    </div>
  );
};
