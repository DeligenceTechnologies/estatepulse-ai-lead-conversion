import React from 'react';
import { Check, ExternalLink, Loader2, UserPlus } from 'lucide-react';
import type { CalendarMember } from '../../../utils/calendarApi';
import { ROLE_LABEL } from '../shared/ui';
import { summarizeSchedule } from './schedule';

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase() || '?';

const AVATAR_TONES = [
  'bg-sky-500/15 text-sky-300',
  'bg-violet-500/15 text-violet-300',
  'bg-amber-500/15 text-amber-300',
  'bg-rose-500/15 text-rose-300',
  'bg-teal-500/15 text-teal-300',
  'bg-indigo-500/15 text-indigo-300',
];

/** Same person, same colour, every time. */
const avatarTone = (key: string): string => {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return AVATAR_TONES[Math.abs(hash) % AVATAR_TONES.length];
};

/** "3:20 PM" in their timezone; null when the calendar gave none or an unknown one. */
const localTime = (timezone: string | null, now: Date): string | null => {
  if (!timezone) return null;
  try {
    return now.toLocaleTimeString(undefined, { timeZone: timezone, hour: 'numeric', minute: '2-digit' });
  } catch {
    return null;
  }
};

const GRID =
  'grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1fr)_5.5rem_13rem_8.5rem] lg:grid-cols-[minmax(0,1fr)_5.5rem_13rem_8rem_8.5rem] items-center gap-x-4';

const MAX_LINES = 2;

/** Their working hours from the calendar, merged into a line or two; the full week on hover. */
const WorkingHours: React.FC<{ member: CalendarMember; compact?: boolean }> = ({ member, compact }) => {
  if (!member.schedule) {
    return compact ? null : (
      <span className="text-xs text-slate-500" title="Their calendar has not shared working hours">
        Not set
      </span>
    );
  }
  const lines = summarizeSchedule(member.schedule);
  if (!lines.length) {
    return <span className="text-xs text-slate-500">No working days</span>;
  }
  const full = lines.map((line) => `${line.days}: ${line.hours}`).join('\n');
  const tz = member.schedule.timezone && member.schedule.timezone !== member.timezone ? member.schedule.timezone : null;
  const shown = compact ? lines.slice(0, 1) : lines.slice(0, MAX_LINES);
  const more = lines.length - shown.length;

  return (
    <div className={`min-w-0 leading-5 ${compact ? 'text-2xs' : 'text-xs'}`} title={tz ? `${full}\n(${tz})` : full}>
      {shown.map((line) => (
        <div key={line.days} className="truncate">
          <span className="font-semibold text-slate-200">{line.days}</span>{' '}
          <span className="text-slate-400 tabular-nums">{line.hours}</span>
        </div>
      ))}
      {(more > 0 || (tz && !compact)) && (
        <div className="text-2xs text-slate-500 truncate">
          {more > 0 && `+${more} more`}
          {more > 0 && tz && !compact && ' · '}
          {!compact && tz?.replace(/_/g, ' ')}
        </div>
      )}
    </div>
  );
};

/** People in the connected calendar, with who is already on the team and a one-click add for the rest. */
export const MemberList: React.FC<{
  items: CalendarMember[];
  canAdd: boolean;
  adding: string | null;
  onAdd: (member: CalendarMember) => void;
}> = ({ items, canAdd, adding, onAdd }) => {
  const now = new Date();

  return (
    <div className="rounded-xl border border-slate-800 overflow-hidden">
      <div
        className={`${GRID} hidden md:grid px-4 py-2.5 bg-slate-950/70 border-b border-slate-800 text-2xs font-semibold uppercase tracking-wide text-slate-500`}
      >
        <span>Member</span>
        <span>Role</span>
        <span>Working hours</span>
        <span className="hidden lg:block">Local time</span>
        <span className="text-right">Team</span>
      </div>

      <ul className="divide-y divide-slate-800/80 list-none">
        {items.map((member) => {
          const onTeam = Boolean(member.userId);
          const busy = adding === member.externalId;
          // Their hours are in the schedule's zone, so that is their working clock.
          const zone = member.schedule?.timezone || member.timezone;
          const time = localTime(zone, now);
          const linkedAs = member.userName && member.userName !== member.name ? member.userName : null;

          return (
            <li key={member.externalId} className={`${GRID} px-4 py-3 hover:bg-slate-800/25 transition-colors`}>
              <div className="flex items-center gap-3 min-w-0">
                <span
                  className={`w-9 h-9 rounded-full text-2xs font-bold flex items-center justify-center shrink-0 ${avatarTone(
                    member.email || member.name,
                  )}`}
                  aria-hidden
                >
                  {initials(member.name)}
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-sm font-semibold text-white truncate">{member.name}</span>
                    {member.schedulingUrl && (
                      <a
                        href={member.schedulingUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Open booking page"
                        aria-label={`Open ${member.name}'s booking page`}
                        className="p-0.5 rounded text-slate-500 hover:text-slate-200 shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
                      >
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </div>
                  <div className="text-xs text-slate-400 truncate">
                    {member.email || <span className="text-slate-500">No email</span>}
                    {linkedAs && <span className="text-slate-500"> · {linkedAs} here</span>}
                  </div>
                  <div className="md:hidden mt-0.5">
                    <WorkingHours member={member} compact />
                  </div>
                </div>
              </div>

              <span className="hidden md:block">
                <span
                  className={`text-2xs font-semibold px-2 py-0.5 rounded-md ${
                    member.role === 'member' ? 'text-slate-500 font-medium px-0' : 'bg-slate-800 text-slate-200'
                  }`}
                >
                  {ROLE_LABEL[member.role]}
                </span>
              </span>

              <div className="hidden md:block min-w-0">
                <WorkingHours member={member} />
              </div>

              <span className="hidden lg:block min-w-0 text-xs text-slate-300 tabular-nums truncate" title={zone ?? undefined}>
                {time ? (
                  <>
                    {time}
                    <span className="block text-2xs text-slate-500 truncate">{zone!.replace(/_/g, ' ')}</span>
                  </>
                ) : (
                  <span className="text-slate-500">—</span>
                )}
              </span>

              <div className="flex justify-end">
                {onTeam ? (
                  <span className="inline-flex items-center gap-1 h-7 px-2.5 rounded-full text-2xs font-semibold bg-emerald-500/10 text-emerald-300">
                    <Check className="w-3 h-3" />
                    On team
                  </span>
                ) : canAdd && member.email ? (
                  <button
                    type="button"
                    onClick={() => onAdd(member)}
                    disabled={adding !== null}
                    aria-busy={busy || undefined}
                    title={`Create an agent login for ${member.name}`}
                    className="h-8 px-3 rounded-lg text-xs font-semibold border border-slate-700 text-slate-200 hover:border-emerald-500/60 hover:text-emerald-200 hover:bg-emerald-500/10 inline-flex items-center gap-1.5 cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50"
                  >
                    {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />}
                    {busy ? (
                      'Adding…'
                    ) : (
                      // One flex item, so the gap does not split "Add" from "to team".
                      <span>
                        Add<span className="hidden sm:inline"> to team</span>
                      </span>
                    )}
                  </button>
                ) : (
                  <span
                    className="h-7 px-2.5 inline-flex items-center rounded-full text-2xs font-semibold bg-slate-800 text-slate-400"
                    title={member.email ? undefined : 'They need an email in the calendar to sign in'}
                  >
                    Not added
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
};
