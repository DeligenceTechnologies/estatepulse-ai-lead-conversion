import React from 'react';
import { AlertTriangle, UserCheck } from 'lucide-react';
import type {
  AvailabilityDay,
  AvailabilityReport,
  BusySource,
  MemberAvailability,
  TimeRange,
} from '../../../utils/calendarApi';
import { gradientFor } from '../../team/MemberParts';
import { dayLabel, duration, hourLabel, minutesInDay, ms, overlaps, placeIn } from './time';

type SegmentKind = 'free' | BusySource;

export const SEGMENT_STYLE: Record<SegmentKind, { label: string; fill: string; text: string; swatch: string }> = {
  free: {
    label: 'Free',
    fill: 'bg-gradient-to-b from-emerald-400 to-emerald-600',
    text: 'text-on-accent',
    swatch: 'bg-gradient-to-b from-emerald-400 to-emerald-600',
  },
  booking: {
    label: 'Booked',
    fill: 'bg-gradient-to-b from-rose-400 to-rose-600',
    text: 'text-on-accent',
    swatch: 'bg-gradient-to-b from-rose-400 to-rose-600',
  },
  calendar: {
    label: 'Busy',
    fill: 'bg-gradient-to-b from-amber-300 to-amber-500',
    text: 'text-amber-950',
    swatch: 'bg-gradient-to-b from-amber-300 to-amber-500',
  },
  hold: {
    label: 'On hold',
    fill: 'bg-gradient-to-b from-violet-400 to-violet-600',
    text: 'text-on-accent',
    swatch: 'bg-gradient-to-b from-violet-400 to-violet-600',
  },
};

const SEGMENT_EDGE = 'shadow-[inset_0_1px_0_rgb(255_255_255/0.28),inset_-1px_0_0_rgb(2_6_23/0.35)]';

export const UNAVAILABLE_SWATCH = 'bg-slate-800';

const NAME_COLUMN = '15rem';

const segmentsFor = (member: MemberAvailability, day: AvailabilityDay): { range: TimeRange; kind: SegmentKind }[] => [
  ...member.free.filter((range) => overlaps(range, day)).map((range) => ({ range, kind: 'free' as const })),
  ...member.busy.filter((range) => overlaps(range, day)).map((range) => ({ range, kind: range.source })),
];

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase() || '?';

export type NowState = { kind: 'busy'; until: number } | { kind: 'free'; until: number } | { kind: 'away'; next: number | null };

export function nowState(member: MemberAvailability, now: number): NowState {
  const busy = member.busy.find((range) => ms(range.start) <= now && ms(range.end) > now);
  if (busy) return { kind: 'busy', until: ms(busy.end) };
  const free = member.free.find((range) => ms(range.start) <= now && ms(range.end) > now);
  if (free) return { kind: 'free', until: ms(free.end) };
  return { kind: 'away', next: member.summary.nextFreeAt ? ms(member.summary.nextFreeAt) : null };
}

const MemberCell: React.FC<{
  member: MemberAvailability;
  now: number;
  live: boolean;
  format: Intl.DateTimeFormat;
}> = ({ member, now, live, format }) => {
  const state = nowState(member, now);
  const status =
    member.status === 'unavailable'
      ? { text: 'text-slate-400', label: 'Not shared' }
      : !live
        ? { text: 'text-slate-400', label: `${duration(member.summary.freeMinutes)} free` }
        : state.kind === 'busy'
          ? { text: 'text-rose-300', label: `Busy until ${format.format(state.until)}` }
          : state.kind === 'free'
            ? { text: 'text-emerald-300', label: `Free until ${format.format(state.until)}` }
            : {
                text: 'text-slate-400',
                label: state.next ? `Next free ${format.format(state.next)}` : 'No free time left',
              };

  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <span
        className={`w-8 h-8 rounded-full bg-gradient-to-br ${gradientFor(member.externalId)} text-on-accent text-2xs font-bold flex items-center justify-center shrink-0 shadow-sm`}
      >
        {initials(member.name)}
      </span>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs font-semibold text-white truncate" title={member.email}>
            {member.name}
          </span>
          {member.userId && (
            <span title={`On EstatePulse as ${member.userName ?? member.name}`} className="shrink-0">
              <UserCheck className="w-3 h-3 text-emerald-400" />
            </span>
          )}
        </div>
        <div className={`text-2xs font-medium truncate ${status.text}`}>{status.label}</div>
      </div>
    </div>
  );
};

const Bar: React.FC<{
  member: MemberAvailability;
  day: AvailabilityDay;
  hours: [number, number];
  now: number;
  format: Intl.DateTimeFormat;
  size: 'lg' | 'sm';
}> = ({ member, day, hours, now, format, size }) => {
  const large = size === 'lg';
  const hourCount = hours[1] - hours[0];
  const past = placeIn({ start: day.start, end: new Date(Math.min(now, ms(day.end))).toISOString() }, day, hours);
  const nowAt = now > ms(day.start) && now < ms(day.end) ? placeIn({ start: new Date(now).toISOString(), end: day.end }, day, hours) : null;

  return (
    <div
      className={`relative w-full overflow-hidden ${UNAVAILABLE_SWATCH} shadow-inner ring-1 ring-inset ring-slate-700/40 ${
        large ? 'h-10 rounded-xl' : 'h-8 rounded-lg'
      }`}
    >
      {large &&
        Array.from({ length: hourCount - 1 }, (_, i) => (
          <span
            key={i}
            aria-hidden
            className="absolute inset-y-0 w-px bg-slate-700/40 pointer-events-none"
            style={{ left: `${((i + 1) / hourCount) * 100}%` }}
          />
        ))}
      {segmentsFor(member, day).map(({ range, kind }, index) => {
        const position = placeIn(range, day, hours);
        if (!position) return null;
        const style = SEGMENT_STYLE[kind];
        const time = `${format.format(ms(range.start))} – ${format.format(ms(range.end))}`;
        const showLabel = large ? position.width > 7 : position.width > 34;
        return (
          <span
            key={index}
            title={`${member.name} · ${style.label} · ${time}`}
            className={`absolute inset-y-0 ${style.fill} ${SEGMENT_EDGE} hover:brightness-110 hover:saturate-125 transition-[filter]`}
            style={{ left: `${position.left}%`, width: `${position.width}%` }}
          >
            {showLabel && (
              <span
                className={`absolute inset-0 flex items-center gap-1.5 whitespace-nowrap overflow-hidden drop-shadow-sm ${style.text} ${
                  large ? 'px-2.5 text-xs font-bold' : 'justify-center px-1 text-2xs font-bold'
                }`}
              >
                {style.label}
                {large && position.width > 15 && <span className="text-2xs font-semibold opacity-85 truncate">{time}</span>}
              </span>
            )}
          </span>
        );
      })}
      {past && (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 bg-slate-950/60 pointer-events-none"
          style={{ width: `${past.left + past.width}%` }}
        />
      )}
      {nowAt && (
        <span
          aria-hidden
          className="absolute inset-y-0 w-[3px] -ml-[1.5px] rounded-full bg-sky-400 shadow-[0_0_8px_rgb(56_189_248/0.9)] z-10 pointer-events-none"
          style={{ left: `${nowAt.left}%` }}
        />
      )}
    </div>
  );
};

const UnavailableNotice: React.FC<{ message: string | null }> = ({ message }) => (
  <div className="h-10 rounded-xl bg-amber-500/5 border border-dashed border-amber-500/30 px-3 flex items-center gap-2 text-2xs text-amber-300/90 min-w-0">
    <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
    <span className="truncate" title={message ?? undefined}>
      {message ?? 'Availability is not shared with this connection.'}
    </span>
  </div>
);

export const DayTimeline: React.FC<{
  report: AvailabilityReport;
  members: MemberAvailability[];
  hours: [number, number];
  now: number;
  format: Intl.DateTimeFormat;
}> = ({ report, members, hours, now, format }) => {
  const day = report.days[0];
  const hourCount = hours[1] - hours[0];
  const step = hourCount > 14 ? 2 : 1;
  const nowAt = now > ms(day.start) && now < ms(day.end) ? placeIn({ start: new Date(now).toISOString(), end: day.end }, day, hours) : null;
  const columns = { gridTemplateColumns: `${NAME_COLUMN} minmax(0, 1fr)` };

  return (
    <div className="min-w-[720px]">
      <div className="grid gap-4 px-4 h-10 items-end border-b border-slate-800 sticky top-0 bg-slate-900 z-20" style={columns}>
        <span className="pb-2 text-2xs font-semibold uppercase tracking-wider text-slate-500">
          {members.length} member{members.length === 1 ? '' : 's'}
        </span>
        <div className="relative h-full">
          {Array.from({ length: hourCount + 1 }, (_, i) => hours[0] + i)
            .filter((hour) => (hour - hours[0]) % step === 0)
            .map((hour, index, all) => (
              <span
                key={hour}
                className={`absolute bottom-2 text-2xs font-medium text-slate-500 tabular-nums whitespace-nowrap ${
                  index === 0 ? '' : index === all.length - 1 ? '-translate-x-full' : '-translate-x-1/2'
                }`}
                style={{ left: `${((hour - hours[0]) / hourCount) * 100}%` }}
              >
                {hourLabel(hour)}
              </span>
            ))}
          {nowAt && (
            <span
              className="absolute bottom-1.5 -translate-x-1/2 z-10 px-1.5 py-0.5 rounded-md bg-sky-500 text-on-accent text-2xs font-bold tabular-nums shadow-md shadow-sky-500/30 whitespace-nowrap"
              style={{ left: `${nowAt.left}%` }}
            >
              {format.format(now)}
            </span>
          )}
        </div>
      </div>

      <ul className="list-none divide-y divide-slate-800/60">
        {members.map((member) => (
          <li key={member.externalId} className="grid gap-4 px-4 py-3.5 items-center hover:bg-slate-800/20 transition-colors" style={columns}>
            <MemberCell member={member} now={now} live={Boolean(nowAt)} format={format} />
            {member.status === 'unavailable' ? (
              <UnavailableNotice message={member.message} />
            ) : (
              <div className="space-y-1 min-w-0">
                <Bar member={member} day={day} hours={hours} now={now} format={format} size="lg" />
                {member.message && <p className="text-2xs text-amber-300/80 truncate">{member.message}</p>}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
};

export const WeekTimeline: React.FC<{
  report: AvailabilityReport;
  members: MemberAvailability[];
  hours: [number, number];
  now: number;
  today: string | null;
  format: Intl.DateTimeFormat;
}> = ({ report, members, hours, now, today, format }) => {
  const columns = { gridTemplateColumns: `${NAME_COLUMN} repeat(${report.days.length}, minmax(0, 1fr))` };
  const live = report.days.some((day) => day.date === today);

  return (
    <div className="min-w-[1000px]">
      <div className="grid gap-x-2 px-4 py-2 items-center border-b border-slate-800 sticky top-0 bg-slate-900 z-20" style={columns}>
        <div className="leading-tight">
          <div className="text-2xs font-semibold uppercase tracking-wider text-slate-500">
            {members.length} member{members.length === 1 ? '' : 's'}
          </div>
          <div className="text-2xs text-slate-500">
            Each day {hourLabel(hours[0], true)} – {hourLabel(hours[1], true)}
          </div>
        </div>
        {report.days.map((day) => {
          const isToday = day.date === today;
          return (
            <div key={day.date} className="flex items-center justify-center gap-1.5">
              <span className={`text-2xs font-semibold uppercase tracking-wide ${isToday ? 'text-sky-300' : 'text-slate-500'}`}>
                {dayLabel(day.date, 'weekday')}
              </span>
              <span
                className={`min-w-6 h-6 px-1 rounded-full inline-flex items-center justify-center text-xs font-bold tabular-nums ${
                  isToday ? 'bg-sky-500 text-on-accent' : 'text-slate-200'
                }`}
              >
                {Number(day.date.slice(8))}
              </span>
            </div>
          );
        })}
      </div>

      <ul className="list-none divide-y divide-slate-800/60">
        {members.map((member) => (
          <li key={member.externalId} className="grid gap-x-2 px-4 py-3.5 items-center hover:bg-slate-800/20 transition-colors" style={columns}>
            <MemberCell member={member} now={now} live={live} format={format} />
            {member.status === 'unavailable' ? (
              <div style={{ gridColumn: `span ${report.days.length}` }}>
                <UnavailableNotice message={member.message} />
              </div>
            ) : (
              report.days.map((day) => {
                const free = member.free.reduce((total, range) => total + minutesInDay(range, day), 0);
                return (
                  <div key={day.date} className="min-w-0">
                    <Bar member={member} day={day} hours={hours} now={now} format={format} size="sm" />
                    <div className={`mt-1.5 text-center text-2xs font-semibold tabular-nums ${free > 0 ? 'text-emerald-300' : 'text-slate-600'}`}>
                      {free > 0 ? `${duration(free)} free` : 'No free time'}
                    </div>
                  </div>
                );
              })
            )}
          </li>
        ))}
      </ul>
    </div>
  );
};
