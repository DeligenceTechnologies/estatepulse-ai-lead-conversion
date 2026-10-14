import React, { useMemo, useRef, useState } from 'react';
import { CalendarCheck2, CalendarX2, ChevronDown } from 'lucide-react';
import type { BookedMeeting, CalendarEventType } from '../../../utils/calendarApi';
import { PanelCard, RowSkeleton } from '../shared/CalendarPanel';
import { Empty, Notice, SearchField } from '../shared/ui';
import { FilterMenu } from './FilterMenu';
import { MeetingRow } from './MeetingRow';
import {
  UNKNOWN_TYPE_COLOR,
  dayParts,
  filterMeetings,
  isToday,
  nowLineIndex,
  sectionsByDay,
  startOfDay,
  type DaySection,
  type MeetingFilters,
  type Range,
  type RangeId,
} from './meetings';

const RANGES: { id: Exclude<RangeId, 'date'>; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'this_week', label: 'This week' },
  { id: 'last_week', label: 'Last week' },
];

const toInputDate = (time: number) => {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const fromInputDate = (value: string): number | null => {
  const [y, m, d] = value.split('-').map(Number);
  return y && m && d ? new Date(y, m - 1, d).getTime() : null;
};

/** The day the list is on, as a button that opens the native date picker. */
const DayPicker: React.FC<{ day: number; min: string; max: string; onPick: (day: number) => void }> = ({
  day,
  min,
  max,
  onPick,
}) => {
  const input = useRef<HTMLInputElement>(null);
  const open = () => {
    const el = input.current;
    if (!el) return;
    try {
      el.showPicker();
    } catch {
      el.focus();
    }
  };
  return (
    <div className="relative">
      <button
        type="button"
        onClick={open}
        className="h-9 px-2 -ml-2 rounded-lg text-sm font-bold text-white inline-flex items-center gap-1.5 hover:bg-slate-800/70 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
      >
        {new Date(day).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
        <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
      </button>
      <input
        ref={input}
        type="date"
        tabIndex={-1}
        aria-label="Go to date"
        value={toInputDate(day)}
        min={min}
        max={max}
        onChange={(e) => {
          const picked = fromInputDate(e.target.value);
          if (picked !== null) onPick(picked);
        }}
        className="absolute left-0 bottom-0 w-full h-0 opacity-0 pointer-events-none"
      />
    </div>
  );
};

const RangeChip: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode }> = ({
  active,
  onClick,
  children,
}) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={`h-8 px-3 rounded-lg border text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 whitespace-nowrap ${
      active
        ? 'bg-white text-slate-900 border-white'
        : 'border-slate-700 text-slate-300 hover:border-slate-500 hover:text-white'
    }`}
  >
    {children}
  </button>
);

const NowLine: React.FC = () => (
  <li aria-hidden className="relative h-0 list-none !border-0 z-10">
    <span className="absolute -left-[5px] -top-[4px] w-2 h-2 rounded-full bg-rose-500" />
    <span className="absolute left-0 right-0 -top-px h-0.5 bg-rose-500" />
  </li>
);

const DayHeader: React.FC<{ day: number; now: number }> = ({ day, now }) => {
  const { weekday, date, tag } = dayParts(day, now);
  return (
    <h4 className="flex items-center gap-2 mb-2">
      <span className="text-sm font-bold text-white">{weekday}</span>
      <span className="text-sm font-semibold text-slate-400">{date}</span>
      {tag && (
        <span
          className={`text-2xs font-semibold px-1.5 py-0.5 rounded-md border ${
            tag === 'Today' ? 'bg-sky-500/15 text-sky-300 border-sky-500/30' : 'bg-slate-800 text-slate-300 border-slate-700'
          }`}
        >
          {tag}
        </span>
      )}
    </h4>
  );
};

const DayBlock: React.FC<{
  section: DaySection;
  now: number;
  typesById: Map<string, CalendarEventType>;
  colors: Map<string, string>;
  expanded: Set<string>;
  onToggle: (id: string) => void;
}> = ({ section, now, typesById, colors, expanded, onToggle }) => {
  const line = nowLineIndex(section, now);
  const today = isToday(section.day, now);

  return (
    <section aria-label={dayParts(section.day, now).date}>
      <DayHeader day={section.day} now={now} />
      {section.meetings.length === 0 ? (
        <ul className="list-none">
          {today && <NowLine />}
          <li className="rounded-xl border border-slate-800 px-5 py-4 text-xs text-slate-400">
            {today ? 'No meetings today' : 'No meetings on this day'}
          </li>
        </ul>
      ) : (
        <ul className="rounded-xl border border-slate-800 divide-y divide-slate-800 list-none overflow-visible">
          {section.meetings.map((meeting, index) => (
            <React.Fragment key={meeting.id}>
              {line === index && <NowLine />}
              <MeetingRow
                meeting={meeting}
                eventType={meeting.eventTypeId ? (typesById.get(meeting.eventTypeId) ?? null) : null}
                color={(meeting.eventTypeId && colors.get(meeting.eventTypeId)) || UNKNOWN_TYPE_COLOR}
                now={now}
                expanded={expanded.has(meeting.id)}
                onToggle={() => onToggle(meeting.id)}
              />
            </React.Fragment>
          ))}
          {line === section.meetings.length && <NowLine />}
        </ul>
      )}
    </section>
  );
};

/** Booked meetings: pick a range, filter, search, and open one to see its meeting type and details. */
export const MeetingsPanel: React.FC<{
  meetings: BookedMeeting[] | null;
  window: { from: string; to: string } | null;
  eventTypes: CalendarEventType[];
  colors: Map<string, string>;
  error: string | null;
  now: number;
  filters: MeetingFilters;
  onFiltersChange: (filters: MeetingFilters) => void;
  loading: boolean;
  providerLabel: string;
  onRefresh: () => void;
}> = ({ meetings, window: span, eventTypes, colors, error, now, filters, onFiltersChange, loading, providerLabel, onRefresh }) => {
  const [range, setRange] = useState<Range>({ id: 'upcoming' });
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const typesById = useMemo(() => new Map(eventTypes.map((t) => [t.id, t])), [eventTypes]);
  const typeNames = useMemo(() => new Map(eventTypes.map((t) => [t.id, t.name])), [eventTypes]);
  const visible = useMemo(
    () => (meetings ? filterMeetings(meetings, { range, filters, query, now, typeNames }) : []),
    [meetings, range, filters, query, now, typeNames],
  );
  const sections = useMemo(() => sectionsByDay(visible, range, now), [visible, range, now]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const pickedDay = range.id === 'date' && range.day !== undefined ? range.day : startOfDay(now);
  const narrowed = Boolean(query.trim()) || filters.types.length > 0;

  const toolbar = (
    <div className="space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        <SearchField value={query} onChange={setQuery} placeholder="Search meetings, people or email" />
        <FilterMenu eventTypes={eventTypes} colors={colors} value={filters} onChange={onFiltersChange} />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <DayPicker
          day={pickedDay}
          min={span ? span.from.slice(0, 10) : ''}
          max={span ? span.to.slice(0, 10) : ''}
          onPick={(day) => setRange({ id: 'date', day })}
        />
        <span className="hidden sm:block w-px h-6 bg-slate-800" aria-hidden />
        <div className="flex flex-wrap items-center gap-1.5">
          {RANGES.map(({ id, label }) => (
            <RangeChip key={id} active={range.id === id} onClick={() => setRange({ id })}>
              {label}
            </RangeChip>
          ))}
        </div>
        {meetings && (
          <span className="sm:ml-auto text-2xs text-slate-400 tabular-nums" aria-live="polite">
            Displaying {visible.length} {visible.length === 1 ? 'meeting' : 'meetings'}
          </span>
        )}
      </div>
    </div>
  );

  return (
    <PanelCard
      icon={CalendarCheck2}
      title="Meetings"
      hint="Who booked, when, and the link to join."
      count={undefined}
      loading={loading}
      providerLabel={providerLabel}
      onRefresh={onRefresh}
      toolbar={toolbar}
    >
      <div className="space-y-6">
        {error && <Notice tone="warning">{error}</Notice>}
        {meetings === null ? (
          <RowSkeleton />
        ) : sections.length === 0 ? (
          narrowed ? (
            <Empty icon={CalendarX2} title="No matching meetings">
              Try another search or clear the filters.
            </Empty>
          ) : (
            <Empty icon={CalendarX2} title="No meetings">
              Nothing booked in this range.
            </Empty>
          )
        ) : (
          <>
            {sections.map((section) => (
              <DayBlock
                key={section.day}
                section={section}
                now={now}
                typesById={typesById}
                colors={colors}
                expanded={expanded}
                onToggle={toggle}
              />
            ))}
            {range.id === 'upcoming' && !error && (
              <div className="flex items-center gap-3 text-2xs text-slate-500" role="note">
                <span className="flex-1 h-px bg-slate-800" />
                {narrowed ? 'No more matching meetings' : 'No more upcoming meetings in the next 30 days'}
                <span className="flex-1 h-px bg-slate-800" />
              </div>
            )}
          </>
        )}
      </div>
    </PanelCard>
  );
};
