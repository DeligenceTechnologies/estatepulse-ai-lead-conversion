import { apiFetch } from '../lib/api';

export type ActivityKind =
  | 'replied'
  | 'interested'
  | 'meeting_requested'
  | 'not_interested'
  | 'wrong_number'
  | 'opted_out'
  | 'callback'
  | 'takeover'
  | 'outreach_paused'
  | 'outreach_resumed'
  | 'meeting_booked'
  | 'meeting_canceled'
  | 'sync_done'
  | 'sync_failed';

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  at: string;
  /** One line, without the lead's name, which is shown beside it. */
  text: string;
  lead: { id: string; name: string } | null;
  tone: 'good' | 'bad' | 'neutral';
  meetingAt?: string;
}

export interface NeedsYouItem {
  actionId: string;
  threadId: string;
  title: string;
  createdAt: string;
  expiresAt: string | null;
}

export interface ActivityAlert {
  app: string;
  state: 'needs_reconnect' | 'error';
  message: string | null;
  reconnectPath: string;
}

export interface ActivityFeed {
  needsYou: NeedsYouItem[];
  alerts: ActivityAlert[];
  canReconnect: boolean;
  items: ActivityItem[];
  nextCursor: string | null;
}

export const getActivity = (before?: string) =>
  apiFetch<ActivityFeed>(`/v1/assistant/activity${before ? `?before=${encodeURIComponent(before)}` : ''}`, { auth: true });
