import React from 'react';
import {
  CalendarClock,
  ChevronDown,
  Link2,
  BadgeCheck,
  MapPin,
  RotateCcw,
  UserRound,
  Users,
  Video,
  X,
  XCircle,
} from 'lucide-react';
import type { BookedMeeting, CalendarEventType, MeetingPerson } from '../../../utils/calendarApi';
import { POOLING_LABEL } from '../shared/ui';
import { CopyLink, OpenLink } from './links';
import { durationLabel, isOpen, meetingMinutes, meetingPhase, meetingTool, startsIn, timeRange } from './meetings';

const smallAction =
  'h-8 px-3 rounded-lg border border-slate-700 text-xs font-semibold text-slate-300 hover:border-slate-600 hover:text-white inline-flex items-center gap-1.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500';

const Detail: React.FC<{ icon: React.ElementType; label: string; children: React.ReactNode }> = ({
  icon: Icon,
  label,
  children,
}) => (
  <div className="min-w-0">
    <div className="flex items-center gap-1.5 text-2xs font-bold uppercase tracking-wide text-slate-500 mb-1.5">
      <Icon className="w-3 h-3" />
      {label}
    </div>
    <div className="text-xs text-slate-200 space-y-1.5">{children}</div>
  </div>
);

const Person: React.FC<{ person: MeetingPerson }> = ({ person }) => (
  <div className="flex items-center gap-2 min-w-0">
    <span className="w-6 h-6 rounded-full bg-slate-800 text-slate-300 text-[10px] font-bold flex items-center justify-center shrink-0 uppercase">
      {person.name.trim().charAt(0) || '?'}
    </span>
    <span className="min-w-0">
      <span className="block truncate font-medium">{person.name}</span>
      {person.email && (
        <a href={`mailto:${person.email}`} className="block text-2xs text-slate-400 hover:text-slate-200 truncate">
          {person.email}
        </a>
      )}
    </span>
    {person.email && <CopyLink url={person.email} title={`Copy ${person.name}'s email`} />}
  </div>
);

const StatusTag: React.FC<{ meeting: BookedMeeting; now: number }> = ({ meeting, now }) => {
  const phase = meetingPhase(meeting, now);
  const when = startsIn(meeting, now);
  if (phase === 'canceled') {
    return <span className="text-2xs font-semibold px-2 py-0.5 rounded-full bg-rose-500/10 text-rose-300">Canceled</span>;
  }
  if (meeting.status === 'pending' && isOpen(phase)) {
    return <span className="text-2xs font-semibold px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-300">Pending</span>;
  }
  if (phase === 'live') {
    return (
      <span className="inline-flex items-center gap-1.5 text-2xs font-semibold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
        Live now
      </span>
    );
  }
  if (when) return <span className="text-2xs font-semibold px-2 py-0.5 rounded-full bg-slate-800 text-slate-300">{when}</span>;
  if (phase === 'past') return <span className="text-2xs font-semibold text-slate-500">Done</span>;
  return null;
};

/**
 * One booked meeting: a compact line (time, meeting type, who booked) that
 * expands to the meeting type it was booked on, everyone in it, where it
 * happens and what can be done with it.
 */
export const MeetingRow: React.FC<{
  meeting: BookedMeeting;
  eventType: CalendarEventType | null;
  color: string;
  now: number;
  expanded: boolean;
  onToggle: () => void;
}> = ({ meeting, eventType, color, now, expanded, onToggle }) => {
  const phase = meetingPhase(meeting, now);
  const open = isOpen(phase);
  const faded = phase === 'past' || phase === 'canceled';
  const [booker, ...others] = meeting.invitees;
  const panelId = `meeting-${meeting.id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const title = eventType?.name ?? meeting.title;

  return (
    <li className={`relative ${expanded ? 'bg-slate-800/30' : ''}`}>
      <span
        aria-hidden
        className={`absolute left-0 top-2 bottom-2 w-1 rounded-r-full ${faded ? 'opacity-40' : ''}`}
        style={{ backgroundColor: color }}
      />
      <div className="flex items-center gap-2 pl-4 pr-2 sm:pr-3">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={panelId}
          className="min-w-0 flex-1 flex flex-col sm:flex-row sm:items-center gap-0.5 sm:gap-6 py-3.5 text-left cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-500 rounded-lg"
        >
          <span
            className={`sm:w-40 shrink-0 text-xs tabular-nums ${
              phase === 'canceled' ? 'text-slate-500 line-through' : faded ? 'text-slate-400' : 'text-slate-200'
            }`}
          >
            {timeRange(meeting.start, meeting.end)}
          </span>
          <span className="min-w-0 flex-1 truncate">
            <span className={`text-sm font-semibold ${faded ? 'text-slate-300' : 'text-white'}`}>{title}</span>
            {booker && (
              <span className="text-xs text-slate-400">
                {' '}
                with {booker.name}
                {others.length > 0 && ` +${others.length}`}
              </span>
            )}
          </span>
        </button>

        <div className="flex items-center gap-2 shrink-0">
          <span className="hidden sm:inline-flex">
            <StatusTag meeting={meeting} now={now} />
          </span>
          {open && meeting.meetingUrl && (
            <a
              href={meeting.meetingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={`h-8 px-3 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ${
                phase === 'live'
                  ? 'bg-emerald-600 hover:bg-emerald-500 text-on-accent'
                  : 'border border-slate-700 text-slate-200 hover:border-slate-600 hover:text-white'
              }`}
              title={`Join on ${meetingTool(meeting.meetingUrl)}`}
            >
              <Video className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Join</span>
            </a>
          )}
          <button
            type="button"
            onClick={onToggle}
            aria-label={expanded ? 'Hide details' : 'Show details'}
            aria-expanded={expanded}
            aria-controls={panelId}
            tabIndex={-1}
            className="p-1.5 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-slate-800 cursor-pointer"
          >
            <ChevronDown className={`w-4 h-4 transition-transform ${expanded ? 'rotate-180' : ''}`} />
          </button>
        </div>
      </div>

      {expanded && (
        <div id={panelId} className="pl-4 pr-3 pb-4">
          <div className="sm:hidden mb-3">
            <StatusTag meeting={meeting} now={now} />
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 grid gap-5 sm:grid-cols-2">
            <Detail icon={CalendarClock} label="Meeting type">
              <div className="flex items-start gap-2 min-w-0">
                <span className="w-2.5 h-2.5 rounded-full mt-1 shrink-0" style={{ backgroundColor: color }} />
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold truncate">{title}</span>
                  <span className="block text-2xs text-slate-400">
                    {durationLabel(eventType?.durationMinutes ?? meetingMinutes(meeting))}
                    {eventType?.poolingType && ` · ${POOLING_LABEL[eventType.poolingType]}`}
                    {!eventType && ' · No longer listed'}
                  </span>
                </span>
                {eventType?.bookingUrl && (
                  <span className="flex items-center shrink-0 -my-1">
                    <CopyLink url={eventType.bookingUrl} title="Copy booking link" />
                    <OpenLink url={eventType.bookingUrl} title="Open booking page" />
                  </span>
                )}
              </div>
              <div className="text-2xs text-slate-400">
                {new Date(meeting.start).toLocaleDateString(undefined, {
                  weekday: 'long',
                  day: 'numeric',
                  month: 'long',
                })}
                , {timeRange(meeting.start, meeting.end)}
              </div>
            </Detail>

            <Detail icon={MapPin} label="Where">
              {meeting.meetingUrl ? (
                <div className="flex items-center gap-2 min-w-0">
                  <Link2 className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                  <a
                    href={meeting.meetingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-w-0 truncate text-sky-300 hover:text-sky-200 hover:underline"
                    title={meeting.meetingUrl}
                  >
                    {meetingTool(meeting.meetingUrl)} · {meeting.meetingUrl.replace(/^https?:\/\//, '')}
                  </a>
                  <CopyLink url={meeting.meetingUrl} title="Copy meeting link" />
                </div>
              ) : null}
              {meeting.location && <div className="break-words text-slate-300">{meeting.location}</div>}
              {!meeting.meetingUrl && !meeting.location && <div className="text-slate-500">No location set</div>}
            </Detail>

            <Detail
              icon={meeting.invitees.length > 1 ? Users : UserRound}
              label={meeting.invitees.length > 1 ? `Booked by · ${meeting.invitees.length}` : 'Booked by'}
            >
              {meeting.invitees.length ? (
                meeting.invitees.map((person, index) => <Person key={`${person.email ?? person.name}-${index}`} person={person} />)
              ) : (
                <div className="text-slate-500">No invitee details</div>
              )}
            </Detail>

            <Detail icon={BadgeCheck} label={meeting.hosts.length > 1 ? 'Hosts' : 'Host'}>
              {meeting.hosts.length ? (
                meeting.hosts.map((person, index) => <Person key={`${person.email ?? person.name}-${index}`} person={person} />)
              ) : (
                <div className="text-slate-500">—</div>
              )}
            </Detail>

            {phase === 'canceled' && (
              <div className="sm:col-span-2 flex items-start gap-2 rounded-lg bg-rose-500/10 border border-rose-500/20 px-3 py-2 text-xs text-rose-200">
                <XCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span className="min-w-0 break-words">
                  Canceled{meeting.canceledReason ? `: ${meeting.canceledReason}` : ''}
                </span>
              </div>
            )}

            {open && (meeting.meetingUrl || meeting.rescheduleUrl || meeting.cancelUrl) && (
              <div className="sm:col-span-2 flex flex-wrap items-center gap-2 border-t border-slate-800/80 -mx-4 px-4 pt-3">
                {meeting.meetingUrl && (
                  <a
                    href={meeting.meetingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="h-8 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-on-accent text-xs font-semibold inline-flex items-center gap-1.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                  >
                    <Video className="w-3.5 h-3.5" />
                    Join {meetingTool(meeting.meetingUrl)}
                  </a>
                )}
                {meeting.rescheduleUrl && (
                  <a href={meeting.rescheduleUrl} target="_blank" rel="noopener noreferrer" className={smallAction}>
                    <RotateCcw className="w-3.5 h-3.5" />
                    Reschedule
                  </a>
                )}
                {meeting.cancelUrl && (
                  <a href={meeting.cancelUrl} target="_blank" rel="noopener noreferrer" className={smallAction}>
                    <X className="w-3.5 h-3.5" />
                    Cancel
                  </a>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </li>
  );
};
