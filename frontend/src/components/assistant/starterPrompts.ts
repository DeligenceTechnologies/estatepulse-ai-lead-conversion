import { BarChart3, Flame, PhoneCall, UserPlus, type LucideIcon } from 'lucide-react';

export interface StarterPrompt {
  icon: LucideIcon;
  /** Sent as the question, word for word. */
  title: string;
  hint: string;
}

/**
 * The four ideas on an empty home page. Each one is answerable with the tools the assistant has
 * today (lead search, counts, calls); add new ones as tools arrive, never ahead of them.
 */
export const starterPrompts = (seesAllLeads: boolean): StarterPrompt[] =>
  seesAllLeads
    ? [
        { icon: Flame, title: 'Which hot leads came in this week?', hint: 'And who each one is assigned to' },
        { icon: UserPlus, title: 'Which leads have no agent yet?', hint: 'So you can hand them out' },
        { icon: BarChart3, title: 'How many leads did we get in the last 7 days?', hint: 'By status and temperature' },
        { icon: PhoneCall, title: 'Summarise the latest AI call', hint: 'What the lead wants and what happens next' },
      ]
    : [
        { icon: Flame, title: 'Show my hot leads', hint: 'Newest first' },
        { icon: PhoneCall, title: 'Which of my leads did the AI call today?', hint: 'With how each call went' },
        { icon: BarChart3, title: 'How many leads do I have, by status?', hint: 'A quick count' },
        { icon: UserPlus, title: 'Summarise my newest lead', hint: 'What they want and their budget' },
      ];

/** "Good morning" and so on, in the browser's time. */
export const greeting = (hour: number): string => (hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening');

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** When a chat was last used, short enough for the chat list: "2:27 PM", "Yesterday", "Mon", "24 Nov". */
export const whenShort = (iso: string, now = new Date()): string => {
  const at = new Date(iso);
  if (sameDay(at, now)) return at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(at, yesterday)) return 'Yesterday';
  const days = (now.getTime() - at.getTime()) / 86_400_000;
  if (days < 7) return at.toLocaleDateString(undefined, { weekday: 'short' });
  return at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};
