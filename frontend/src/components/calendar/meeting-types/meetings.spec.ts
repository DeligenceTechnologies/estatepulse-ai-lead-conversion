import { describe, expect, it } from 'vitest';
import type { BookedMeeting } from '../../../utils/calendarApi';
import {
  addDays,
  filterMeetings,
  meetingTool,
  nowLineIndex,
  rangeBounds,
  sectionsByDay,
  startOfDay,
  startsIn,
  typeColors,
  upcomingByType,
  type MeetingFilters,
  type Range,
} from './meetings';

// Wednesday 14 Oct 2026, noon local time.
const NOW = new Date(2026, 9, 14, 12, 0).getTime();
const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();

const meeting = (id: string, startH: number, overrides: Partial<BookedMeeting> = {}): BookedMeeting => ({
  id,
  eventTypeId: 'demo',
  title: 'Property tour',
  start: at(startH),
  end: at(startH + 0.5),
  status: 'scheduled',
  invitees: [{ name: 'Priya Shah', email: 'priya@example.com' }],
  hosts: [{ name: 'Rohit', email: null }],
  meetingUrl: null,
  location: null,
  rescheduleUrl: null,
  cancelUrl: null,
  canceledReason: null,
  ...overrides,
});

const ALL: MeetingFilters = { types: [], showCanceled: false };
const ids = (list: BookedMeeting[]) => list.map((m) => m.id);
const run = (meetings: BookedMeeting[], range: Range, filters = ALL, query = '') =>
  ids(filterMeetings(meetings, { range, filters, query, now: NOW, typeNames: new Map([['demo', 'Demo Meeting']]) }));

describe('ranges', () => {
  it('uses Monday-to-Sunday weeks', () => {
    const { from, to } = rangeBounds({ id: 'this_week' }, NOW);
    expect(new Date(from)).toEqual(new Date(2026, 9, 12));
    expect(new Date(to)).toEqual(new Date(2026, 9, 19));
    expect(new Date(rangeBounds({ id: 'last_week' }, NOW).from)).toEqual(new Date(2026, 9, 5));
  });

  it('filters by range, keeping a running meeting in Upcoming', () => {
    const list = [meeting('live', -0.2), meeting('earlier', -3), meeting('tomorrow', 24), meeting('lastweek', -24 * 8)];
    expect(run(list, { id: 'upcoming' })).toEqual(['live', 'tomorrow']);
    expect(run(list, { id: 'today' })).toEqual(['earlier', 'live']);
    expect(run(list, { id: 'last_week' })).toEqual(['lastweek']);
    expect(run(list, { id: 'date', day: addDays(startOfDay(NOW), 1) })).toEqual(['tomorrow']);
  });

  it('hides canceled unless asked, and filters by type and search', () => {
    const list = [meeting('a', 1), meeting('b', 2, { status: 'canceled' }), meeting('c', 3, { eventTypeId: 'call' })];
    expect(run(list, { id: 'upcoming' })).toEqual(['a', 'c']);
    expect(run(list, { id: 'upcoming' }, { types: ['demo'], showCanceled: true })).toEqual(['a', 'b']);
    expect(run(list, { id: 'upcoming' }, ALL, 'demo meeting')).toEqual(['a']);
    expect(run(list, { id: 'upcoming' }, ALL, 'PRIYA@')).toEqual(['a', 'c']);
  });
});

describe('days', () => {
  it('always shows today for Upcoming, even when empty', () => {
    const sections = sectionsByDay([meeting('t', 24)], { id: 'upcoming' }, NOW);
    expect(sections.map((s) => [s.day, s.meetings.length])).toEqual([
      [startOfDay(NOW), 0],
      [addDays(startOfDay(NOW), 1), 1],
    ]);
  });

  it('puts the now line between past and future meetings today', () => {
    const [today] = sectionsByDay([meeting('a', -2), meeting('b', 2)], { id: 'today' }, NOW);
    expect(nowLineIndex(today, NOW)).toBe(1);
  });
});

describe('meeting details', () => {
  it('counts upcoming meetings per type', () => {
    const counts = upcomingByType([meeting('a', 1), meeting('b', -5), meeting('c', 1, { eventTypeId: 'call' })], NOW);
    expect(Object.fromEntries(counts)).toEqual({ demo: 1, call: 1 });
  });

  it('says when a meeting starts and which tool it uses', () => {
    expect(startsIn(meeting('a', 0.5), NOW)).toBe('in 30 min');
    expect(startsIn(meeting('a', -0.1), NOW)).toBe('Live now');
    expect(startsIn(meeting('a', 48), NOW)).toBeNull();
    expect(meetingTool('https://us02web.zoom.us/j/1')).toBe('Zoom');
    expect(meetingTool('https://meet.google.com/abc')).toBe('Google Meet');
  });

  it('prefers the provider colour', () => {
    const colors = typeColors([
      { id: 'a', name: 'A', durationMinutes: 30, bookingUrl: null, poolingType: null, hostName: null, color: '#123456' },
      { id: 'b', name: 'B', durationMinutes: 30, bookingUrl: null, poolingType: null, hostName: null, color: null },
    ]);
    expect(colors.get('a')).toBe('#123456');
    expect(colors.get('b')).toMatch(/^#/);
  });
});
