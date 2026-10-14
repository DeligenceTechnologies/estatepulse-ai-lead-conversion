import React from 'react';
import { AlertTriangle, Globe, UserCheck } from 'lucide-react';
import type {
  AvailabilityReportDay,
  BusySource,
  MemberAvailability,
  TimeRange,
} from '../../../utils/calendarApi';
import { gradientFor } from '../../team/MemberParts';
import { zoneOffsetLabel } from '../../../lib/datetime';
import { dayLabel, duration, hourLabel, minutesInDay, ms, overlaps, placeIn, timeFormatter, zoneCity } from './time';

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

/** Their working hours: the band free time and meetings sit on, so the hours show even where nothing is free. */
export const WORKING_SWATCH = 'bg-slate-600 ring-1 ring-inset ring-sky-400/50';
const WORKING_FILL = 'bg-slate-600/90 shadow-[inset_0_2px_0_rgb(56_189_248/0.55),inset_0_-2px_0_rgb(56_189_248/0.55)]';

/** Their working hours that fall on this day, clipped to it. Null when the calendar gives none. */
const workingOn = (member: MemberAvailability, day: AvailabilityReportDay): TimeRange[] | null =>
  member.hours === null
    ? null
    : member.hours
        .filter((range) => overlaps(range, day))
        .map((range) => ({
          start: new Date(Math.max(ms(range.start), ms(day.start))).toISOString(),
          end: new Date(Math.min(ms(range.end), ms(day.end))).toISOString(),
        }));

const NAME_COLUMN = '16rem';

const segmentsFor = (member: MemberAvailability, day: AvailabilityReportDay): { range: TimeRange; kind: SegmentKind }[] => [
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

const isNowIn = (day: AvailabilityReportDay, now: number): boolean => now >= ms(day.start) && now < ms(day.end);

/** Where they are and what time it is there: "Toronto · GMT-4 · 5:20 AM". */
const ZoneClock: React.FC<{ timezone: string; now: number }> = ({ timezone, now }) => {
  const offset = zoneOffsetLabel(timezone, now);
  return (
    <div className="flex items-center gap-1 text-2xs text-sky-300/80 min-w-0" title={timezone.replace(/_/g, ' ')}>
      <Globe className="w-3 h-3 shrink-0" aria-hidden />
      <span className="truncate">
        {zoneCity(timezone)}
        {offset && ` · ${offset}`} · <span className="tabular-nums">{timeFormatter(timezone).format(now)}</span>
      </span>
    </div>
  );
};

const MemberCell: React.FC<{ member: MemberAvailability; now: number; live: boolean }> = ({ member, now, live }) => {
  const format = timeFormatter(member.timezone);
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
        <ZoneClock timezone={member.timezone} now={now} />
      </div>
    </div>
  );
};

const Bar: React.FC<{
  member: MemberAvailability;
  day: AvailabilityReportDay;
  hours: [number, number];
  now: number;
  size: 'lg' | 'sm';
}> = ({ member, day, hours, now, size }) => {
  const format = timeFormatter(member.timezone);
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
      {(workingOn(member, day) ?? []).map((range, index) => {
        const position = placeIn(range, day, hours);
        if (!position) return null;
        return (
          <span
            key={`working-${index}`}
            title={`${member.name} · Working hours · ${format.format(ms(range.start))} – ${format.format(ms(range.end))}`}
            className={`absolute inset-y-0 ${WORKING_FILL}`}
            style={{ left: `${position.left}%`, width: `${position.width}%` }}
          />
        );
      })}
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
  members: MemberAvailability[];
  hours: [number, number];
  now: number;
}> = ({ members, hours, now }) => {
  const hourCount = hours[1] - hours[0];
  const step = hourCount > 14 ? 2 : 1;
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
        </div>
      </div>

      <ul className="list-none divide-y divide-slate-800/60">
        {members.map((member) => {
          const day = member.days[0];
          return (
            <li key={member.externalId} className="grid gap-4 px-4 py-3.5 items-center hover:bg-slate-800/20 transition-colors" style={columns}>
              <MemberCell member={member} now={now} live={isNowIn(day, now)} />
              {member.status === 'unavailable' ? (
                <UnavailableNotice message={member.message} />
              ) : (
                <div className="space-y-1 min-w-0">
                  <Bar member={member} day={day} hours={hours} now={now} size="lg" />
                  {member.message && <p className="text-2xs text-amber-300/80 truncate">{member.message}</p>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export const WeekTimeline: React.FC<{
  dates: string[];
  members: MemberAvailability[];
  hours: [number, number];
  now: number;
  today: string;
}> = ({ dates, members, hours, now, today }) => {
  const columns = { gridTemplateColumns: `${NAME_COLUMN} repeat(${dates.length}, minmax(0, 1fr))` };

  return (
    <div className="min-w-[1000px]">
      <div className="grid gap-x-2 px-4 py-2 items-center border-b border-slate-800 sticky top-0 bg-slate-900 z-20" style={columns}>
        <div className="leading-tight">
          <div className="text-2xs font-semibold uppercase tracking-wider text-slate-500">
            {members.length} member{members.length === 1 ? '' : 's'}
          </div>
          <div className="text-2xs text-slate-500">Each day in their own timezone</div>
        </div>
        {dates.map((date) => {
          const isToday = date === today;
          return (
            <div key={date} className="flex items-center justify-center gap-1.5">
              <span className={`text-2xs font-semibold uppercase tracking-wide ${isToday ? 'text-sky-300' : 'text-slate-500'}`}>
                {dayLabel(date, 'weekday')}
              </span>
              <span
                className={`min-w-6 h-6 px-1 rounded-full inline-flex items-center justify-center text-xs font-bold tabular-nums ${
                  isToday ? 'bg-sky-500 text-on-accent' : 'text-slate-200'
                }`}
              >
                {Number(date.slice(8))}
              </span>
            </div>
          );
        })}
      </div>

      <ul className="list-none divide-y divide-slate-800/60">
        {members.map((member) => (
          <li key={member.externalId} className="grid gap-x-2 px-4 py-3.5 items-center hover:bg-slate-800/20 transition-colors" style={columns}>
            <MemberCell member={member} now={now} live={member.days.some((day) => isNowIn(day, now))} />
            {member.status === 'unavailable' ? (
              <div style={{ gridColumn: `span ${dates.length}` }}>
                <UnavailableNotice message={member.message} />
              </div>
            ) : (
              member.days.map((day) => {
                const free = member.free.reduce((total, range) => total + minutesInDay(range, day), 0);
                return (
                  <div key={day.date} className="min-w-0">
                    <Bar member={member} day={day} hours={hours} now={now} size="sm" />
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
