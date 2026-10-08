import { apiFetch } from '../lib/api';

/**
 * Call and message history. Same shape as agentsApi and strategiesApi: a thin
 * wrapper over apiFetch, which attaches the token and decodes the
 * {error:{code}} envelope, so nothing here does its own error handling.
 *
 * Every read is scoped server-side by role — an owner sees the office, an agent
 * sees only leads assigned to them. The UI never asks for a scope and cannot
 * widen one.
 */

/** Only the outcomes the backend can honestly derive from what we store. */
export type CallOutcome =
  | 'ANSWERED'
  | 'NO_ANSWER'
  | 'QUALIFIED'
  | 'APPOINTMENT_BOOKED'
  | 'HUMAN_HANDOFF'
  | 'NOT_INTERESTED'
  | 'FAILED'
  | 'IN_PROGRESS';

export interface CallRow {
  id: string;
  leadId: string;
  leadName: string;
  leadPhone: string | null;
  temperature: string | null;
  provider: string;
  providerCallId: string | null;
  direction: string;
  status: string;
  outcome: CallOutcome;
  durationSeconds: number | null;
  /** Null when the office has recording off, or the file has not landed yet. */
  recordingUrl: string | null;
  /** Lets the list show a transcript affordance without fetching every transcript. */
  hasTranscript: boolean;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  agentId: string | null;
  agentName: string | null;
}

export interface CallDetail extends CallRow {
  transcript: string | null;
  aiSummary: string | null;
  extractedIntel: unknown;
  handoffRequested: boolean;
  dncDetected: boolean;
}

export interface ConversationRow {
  id: string;
  leadId: string;
  leadName: string;
  leadPhone: string | null;
  temperature: string | null;
  status: string;
  channel: string;
  messageCount: number;
  lastMessageAt: string | null;
  lastMessageBody: string | null;
  lastMessageDirection: string | null;
  hasInboundReply: boolean;
  dncStatus: boolean;
  createdAt: string;
}

export interface MessageRow {
  id: string;
  direction: string;
  senderType: string;
  channel: string;
  body: string;
  deliveryStatus: string;
  sentAt: string | null;
  deliveredAt: string | null;
  failedAt: string | null;
  createdAt: string;
}

export interface CallFilters {
  /** Index signature so the filters can be handed straight to `query`. */
  [key: string]: string | number | undefined;
  limit?: number;
  agentId?: string;
  outcome?: string;
  temperature?: string;
  from?: string;
  to?: string;
  q?: string;
  /** One lead's calls; the server keeps it inside your org and visibility. */
  leadId?: string;
}

const query = (params: Record<string, string | number | undefined>): string => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
};

export const listCalls = (filters: CallFilters = {}): Promise<CallRow[]> =>
  apiFetch<CallRow[]>(`/v1/calls${query(filters)}`, { auth: true });

/**
 * Separate from the list because a transcript is a few kilobytes: fetching two
 * hundred of them to render a list nobody has expanded is the difference
 * between a page that loads and one that does not.
 */
export const getCall = (id: string): Promise<CallDetail> =>
  apiFetch<CallDetail>(`/v1/calls/${id}`, { auth: true });

export const listConversations = (limit?: number, leadId?: string): Promise<ConversationRow[]> =>
  apiFetch<ConversationRow[]>(`/v1/conversations${query({ limit, leadId })}`, { auth: true });

export const listMessages = (conversationId: string): Promise<MessageRow[]> =>
  apiFetch<MessageRow[]>(`/v1/conversations/${conversationId}/messages`, { auth: true });

/**
 * Every SMS message of one lead, across all its threads, in one request — the
 * same messages as listConversations(200, leadId) followed by listMessages for
 * each SMS thread, without the per-thread round trips.
 */
export const listLeadMessages = (leadId: string): Promise<MessageRow[]> =>
  apiFetch<MessageRow[]>(`/v1/messages${query({ leadId })}`, { auth: true });
