import type { BookedMeeting, CalendarEventType } from '../../../utils/calendarApi';

export type MeetingPhase = 'live' | 'upcoming' | 'past' | 'canceled';

export const meetingPhase = (meeting: BookedMeeting, now: number): MeetingPhase => {
  if (meeting.status === 'canceled') return 'canceled';
  if (Date.parse(meeting.end) <= now) return 'past';
  return Date.parse(meeting.start) <= now ? 'live' : 'upcoming';
};

export const isOpen = (phase: MeetingPhase) => phase === 'live' || phase === 'upcoming';

// --- ranges ------------------------------------------------------------------

export type RangeId = 'today' | 'upcoming' | 'this_week' | 'last_week' | 'date';

export interface Range {
  id: RangeId;
  /** Local midnight of the picked day, for `date`. */
  day?: number;
}

const DAY_MS = 86_400_000;

export const startOfDay = (time: number): number => {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

/** Adds whole calendar days, staying on local midnight across DST changes. */
export const addDays = (day: number, days: number): number => {
  const date = new Date(day);
  date.setDate(date.getDate() + days);
  return date.getTime();
};

/** Weeks start on Monday. */
const startOfWeek = (time: number): number => {
  const day = startOfDay(time);
  return addDays(day, -((new Date(day).getDay() + 6) % 7));
};

/** The [from, to) a range covers; `upcoming` starts at `now` and has no end. */
export const rangeBounds = (range: Range, now: number): { from: number; to: number } => {
  const today = startOfDay(now);
  switch (range.id) {
    case 'today':
      return { from: today, to: addDays(today, 1) };
    case 'date': {
      const day = range.day ?? today;
      return { from: day, to: addDays(day, 1) };
    }
    case 'this_week': {
      const week = startOfWeek(now);
      return { from: week, to: addDays(week, 7) };
    }
    case 'last_week': {
      const week = startOfWeek(now);
      return { from: addDays(week, -7), to: week };
    }
    case 'upcoming':
      return { from: now, to: Number.POSITIVE_INFINITY };
  }
};

export const inRange = (meeting: BookedMeeting, range: Range, now: number): boolean => {
  // Upcoming keeps a meeting that is running right now.
  if (range.id === 'upcoming') return Date.parse(meeting.end) > now;
  const { from, to } = rangeBounds(range, now);
  const start = Date.parse(meeting.start);
  return start >= from && start < to;
};

// --- filters -----------------------------------------------------------------

export interface MeetingFilters {
  /** Meeting type ids to show; empty shows them all. */
  types: string[];
  showCanceled: boolean;
}

export const matchesSearch = (meeting: BookedMeeting, query: string, typeName: string | null): boolean => {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [
    meeting.title,
    typeName,
    meeting.location,
    ...meeting.invitees.flatMap((p) => [p.name, p.email]),
    ...meeting.hosts.flatMap((p) => [p.name, p.email]),
  ].some((value) => value?.toLowerCase().includes(needle));
};

export const filterMeetings = (
  meetings: BookedMeeting[],
  { range, filters, query, now, typeNames }: {
    range: Range;
    filters: MeetingFilters;
    query: string;
    now: number;
    typeNames: Map<string, string>;
  },
): BookedMeeting[] =>
  meetings
    .filter((m) => inRange(m, range, now))
    .filter((m) => filters.showCanceled || m.status !== 'canceled')
    .filter((m) => !filters.types.length || (m.eventTypeId !== null && filters.types.includes(m.eventTypeId)))
    .filter((m) => matchesSearch(m, query, m.eventTypeId ? (typeNames.get(m.eventTypeId) ?? null) : null))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.id.localeCompare(b.id));

/** Upcoming (or running) meetings per meeting type id. */
export const upcomingByType = (meetings: BookedMeeting[], now: number): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const meeting of meetings) {
    if (!meeting.eventTypeId || !isOpen(meetingPhase(meeting, now))) continue;
    counts.set(meeting.eventTypeId, (counts.get(meeting.eventTypeId) ?? 0) + 1);
  }
  return counts;
};

// --- days --------------------------------------------------------------------

export interface DaySection {
  day: number;
  meetings: BookedMeeting[];
}

/**
 * Meetings by local day. Days the range is "about" (today for Today and
 * Upcoming, the picked day for a date) are kept even when empty, so the
 * page can say "No meetings today".
 */
export const sectionsByDay = (meetings: BookedMeeting[], range: Range, now: number): DaySection[] => {
  const byDay = new Map<number, BookedMeeting[]>();
  const pinned =
    range.id === 'date' ? (range.day ?? startOfDay(now)) : range.id === 'today' || range.id === 'upcoming' ? startOfDay(now) : null;
  if (pinned !== null) byDay.set(pinned, []);
  for (const meeting of meetings) {
    const day = startOfDay(Date.parse(meeting.start));
    byDay.set(day, [...(byDay.get(day) ?? []), meeting]);
  }
  return [...byDay.entries()].sort(([a], [b]) => a - b).map(([day, items]) => ({ day, meetings: items }));
};

/** Index in a day's (start-sorted) meetings where the "now" line goes; -1 when now is not that day. */
export const nowLineIndex = (section: DaySection, now: number): number => {
  if (section.day !== startOfDay(now)) return -1;
  const index = section.meetings.findIndex((m) => Date.parse(m.start) > now);
  return index === -1 ? section.meetings.length : index;
};

export const isToday = (day: number, now: number) => day === startOfDay(now);

export const dayParts = (day: number, now: number): { weekday: string; date: string; tag: string | null } => {
  const date = new Date(day);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return {
    weekday: date.toLocaleDateString(undefined, { weekday: 'short' }),
    date: date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) }),
    tag: isToday(day, now) ? 'Today' : day === addDays(startOfDay(now), 1) ? 'Tomorrow' : null,
  };
};

// --- formatting --------------------------------------------------------------

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

export const timeRange = (start: string, end: string): string =>
  `${timeFormat.format(new Date(start))} – ${timeFormat.format(new Date(end))}`;

export const durationLabel = (minutes: number): string => {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
};

export const meetingMinutes = (meeting: BookedMeeting) =>
  Math.max(0, Math.round((Date.parse(meeting.end) - Date.parse(meeting.start)) / 60_000));

/** "in 25 min", "in 3 h", "Live now"; null when it is more than a day away or over. */
export const startsIn = (meeting: BookedMeeting, now: number): string | null => {
  const phase = meetingPhase(meeting, now);
  if (phase === 'live') return 'Live now';
  if (phase !== 'upcoming') return null;
  const minutes = Math.round((Date.parse(meeting.start) - now) / 60_000);
  if (minutes < 1) return 'Starting now';
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `in ${hours} h` : null;
};

/** Which video tool a join link opens, for the button label. */
export const meetingTool = (url: string): string => {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'Meeting link';
  }
  if (host.endsWith('zoom.us')) return 'Zoom';
  if (host === 'meet.google.com') return 'Google Meet';
  if (host.endsWith('teams.microsoft.com') || host.endsWith('teams.live.com')) return 'Teams';
  if (host.endsWith('webex.com')) return 'Webex';
  if (host.endsWith('cal.com') || host.endsWith('cal.video')) return 'Cal Video';
  return 'Meeting link';
};

// --- meeting type colours ----------------------------------------------------

const PALETTE = ['#8b5cf6', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#6366f1', '#14b8a6', '#f97316'];
export const UNKNOWN_TYPE_COLOR = '#64748b';

/** The provider's colour, else a stable one from the palette by position. */
export const typeColors = (eventTypes: CalendarEventType[]): Map<string, string> =>
  new Map(eventTypes.map((type, index) => [type.id, type.color ?? PALETTE[index % PALETTE.length]]));
