import type { UpcomingMeeting } from '@/lead/upcoming-meeting';
import { fullName } from '@/lead/lead-scope';
import { spoken } from './booking-time';

/** A meeting the lead already has, as the AI reads it: when, with whom, and the provider's links to move or cancel it. */
export interface MeetingFacts {
  meeting: string;
  with: string;
  reschedule_link: string;
  cancel_link: string;
}

export function meetingFacts(m: UpcomingMeeting, timeZone: string): MeetingFacts {
  const host = Array.isArray(m.hosts) ? (m.hosts[0] as { name?: unknown } | undefined) : undefined;
  const hostName = m.hostUser ? fullName(m.hostUser.firstName, m.hostUser.lastName) : '';
  return {
    meeting: spoken(m.startsAt, timeZone),
    with: hostName || (typeof host?.name === 'string' ? host.name : ''),
    reschedule_link: m.rescheduleUrl ?? '',
    cancel_link: m.cancelUrl ?? '',
  };
}

/**
 * What the AI does about a meeting the lead already has. It never books a
 * second one, and it cannot move or cancel one itself: the lead does, with the
 * provider's own links (Calendly or Cal.com then updates the calendar, tells
 * the agent, and our sync follows).
 */
export function existingMeetingSay(f: MeetingFacts): string {
  const when = `They already have a meeting with us on ${f.meeting}${f.with ? ` with ${f.with}` : ''}. Never book another one, and never say you moved or cancelled it yourself.`;
  if (!f.reschedule_link && !f.cancel_link) return `${when} If they want to change it, say someone from the team will get back to them about it.`;
  return `${when} To move it, they pick a new time at reschedule_link; to cancel it, cancel_link. In a text chat, send them that link; on a call, tell them both links are in their confirmation email.`;
}
