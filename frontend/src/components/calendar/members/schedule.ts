import type { MemberSchedule } from '../../../utils/calendarApi';

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Weeks read Monday first. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** '09:00' → '9 AM', '17:30' → '5:30 PM'. */
export const clockLabel = (time: string): string => {
  const [h, m] = time.split(':').map(Number);
  const suffix = h < 12 ? 'AM' : 'PM';
  const hour = h % 12 || 12;
  return m ? `${hour}:${String(m).padStart(2, '0')} ${suffix}` : `${hour} ${suffix}`;
};

export interface ScheduleLine {
  days: string;
  hours: string;
}

/**
 * A weekly schedule as a few readable lines: consecutive days with the same
 * hours are merged ("Mon–Fri · 9 AM – 5 PM"), days off are left out.
 */
export const summarizeSchedule = (schedule: MemberSchedule): ScheduleLine[] => {
  const hoursOf = (day: number) =>
    (schedule.weekly[String(day)] ?? []).map((span) => `${clockLabel(span.from)} – ${clockLabel(span.to)}`).join(', ');

  const lines: ScheduleLine[] = [];
  let run: { first: number; last: number; hours: string } | null = null;
  const flush = () => {
    if (!run) return;
    const days = run.first === run.last ? DAY_SHORT[run.first] : `${DAY_SHORT[run.first]}–${DAY_SHORT[run.last]}`;
    lines.push({ days, hours: run.hours });
    run = null;
  };
  for (const day of WEEK_ORDER) {
    const hours = hoursOf(day);
    if (!hours) {
      flush();
      continue;
    }
    if (run && run.hours === hours) run.last = day;
    else {
      flush();
      run = { first: day, last: day, hours };
    }
  }
  flush();
  return lines;
};
