import { ApiError, apiFetch, decodeError, endSessionIfUnauthenticated, getFreshToken, hasStoredSession, refreshAccessToken } from '../lib/api';

const BASE = `${import.meta.env.VITE_API_URL ?? ''}/api`;

export type ActionStatus = 'proposed' | 'executing' | 'executed' | 'rejected' | 'expired' | 'failed';

export interface AssistantAction {
  id: string;
  messageId: string;
  tool: string;
  status: ActionStatus;
  title: string;
  summary: string | null;
  changes: { field: string; from: string | null; to: string | null }[];
  error: string | null;
  expiresAt: string | null;
  decidedAt: string | null;
  /** A bulk card: how many leads, a few names, what was left out; `status` is its job's once approved. */
  bulk?: { total: number; status: BulkJobStatus | null; sample?: string[]; skipped?: Record<string, number> };
}

export type BulkJobStatus = 'queued' | 'running' | 'done' | 'cancelled' | 'stopped';

/** Where a bulk card's background job is. */
export interface BulkProgress {
  actionId: string;
  status: BulkJobStatus | null;
  total: number;
  done: number;
  failed: number;
  skipped: number;
  notAttempted: number;
  pending: number;
  problems: { leadId: string; name: string; status: string; reason: string | null }[];
}

export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  actions: AssistantAction[];
}

export interface AssistantThreadSummary {
  id: string;
  title: string | null;
  lastMessageAt: string;
  createdAt: string;
}

export interface AssistantStatus {
  /** On for this server and for this office. */
  enabled: boolean;
  /** The owner's switch in Settings > Ask EstatePulse. */
  officeEnabled?: boolean;
  /** The office's microphone setting. */
  voiceEnabled?: boolean;
  /** This user's roles let them use it (assistant.use). Missing from an older server means yes. */
  allowed?: boolean;
  included: boolean;
  usage: { period: string; usedMicros: number; budgetMicros: number };
}

/** A lead an answer names ("Maria Lopez [L1]"), for the chat to link to. */
export interface RefLink {
  kind: 'lead';
  id: string;
  name: string;
}

export type AssistantEvent =
  | { type: 'thread'; threadId: string; title: string | null }
  | { type: 'refs'; refs: Record<string, RefLink> }
  | { type: 'text'; text: string }
  | { type: 'tool.started'; toolUseId: string; tool: string; label: string }
  | { type: 'tool.finished'; toolUseId: string; tool: string; ok: boolean }
  | { type: 'action'; action: AssistantAction }
  | { type: 'done'; awaitingConfirmation: boolean }
  | { type: 'error'; code: string; message: string };

export const assistantChatApi = {
  status: () => apiFetch<AssistantStatus>('/v1/assistant/status', { auth: true }),
  threads: () => apiFetch<AssistantThreadSummary[]>('/v1/assistant/threads', { auth: true }),
  thread: (id: string) =>
    apiFetch<{ thread: AssistantThreadSummary; messages: AssistantMessage[]; refs?: Record<string, RefLink> }>(`/v1/assistant/threads/${id}`, { auth: true }),
  removeThread: (id: string) => apiFetch<void>(`/v1/assistant/threads/${id}`, { method: 'DELETE', auth: true }),
  stop: (threadId: string) => apiFetch<void>(`/v1/assistant/threads/${threadId}/stop`, { method: 'POST', auth: true }),

  send: (body: { threadId?: string; text: string; screen?: string }, onEvent: (e: AssistantEvent) => void, signal: AbortSignal) =>
    stream('/v1/assistant/messages', body, onEvent, signal),
  /** `count` is the number of leads the user typed to approve a bulk card above 10 leads. */
  confirm: (actionId: string, onEvent: (e: AssistantEvent) => void, signal: AbortSignal, count?: number) =>
    stream(`/v1/assistant/actions/${actionId}/confirm`, count === undefined ? undefined : { count }, onEvent, signal),
  bulkProgress: (actionId: string) => apiFetch<BulkProgress>(`/v1/assistant/actions/${actionId}/progress`, { auth: true }),
  stopBulk: (actionId: string) => apiFetch<BulkProgress>(`/v1/assistant/actions/${actionId}/stop`, { method: 'POST', auth: true }),
  reject: (actionId: string, onEvent: (e: AssistantEvent) => void, signal: AbortSignal) =>
    stream(`/v1/assistant/actions/${actionId}/reject`, undefined, onEvent, signal),
};

/** POSTs and reads the text/event-stream answer. A failure before the stream opens rejects with an ApiError. */
async function stream(path: string, body: unknown, onEvent: (e: AssistantEvent) => void, signal: AbortSignal): Promise<void> {
  const send = async (token: string | null) => {
    try {
      return await fetch(`${BASE}${path}`, {
        method: 'POST',
        signal,
        headers: {
          Accept: 'text/event-stream',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ApiError('NETWORK', 'Cannot reach the server. Check your connection.', 0);
    }
  };

  let res = await send(await getFreshToken());
  if (res.status === 401 && hasStoredSession()) {
    const first = decodeError(401, await readJson(res));
    if (first.code !== 'TOKEN_EXPIRED') {
      endSessionIfUnauthenticated(401, first.code);
      throw first;
    }
    res = await send(await refreshAccessToken());
  }
  if (!res.ok || !res.body) {
    const error = decodeError(res.status, await readJson(res));
    endSessionIfUnauthenticated(res.status, error.code);
    throw error;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let split = buffer.indexOf('\n\n');
    while (split !== -1) {
      const event = parseFrame(buffer.slice(0, split));
      buffer = buffer.slice(split + 2);
      if (event) onEvent(event);
      split = buffer.indexOf('\n\n');
    }
  }
}

function parseFrame(frame: string): AssistantEvent | null {
  const data = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data) return null;
  try {
    return JSON.parse(data) as AssistantEvent;
  } catch {
    return null;
  }
}

async function readJson(res: Response): Promise<unknown> {
  try {
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}
