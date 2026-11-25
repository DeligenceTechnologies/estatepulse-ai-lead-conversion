import { ApiError, apiFetch, decodeError, endSessionIfUnauthenticated, getFreshToken, hasStoredSession, refreshAccessToken } from '../lib/api';

const BASE = `${import.meta.env.VITE_API_URL ?? ''}/api`;

export type ActionStatus = 'proposed' | 'executing' | 'executed' | 'rejected' | 'expired' | 'failed';

export interface CopilotAction {
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
}

export interface CopilotMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  actions: CopilotAction[];
}

export interface CopilotThreadSummary {
  id: string;
  title: string | null;
  lastMessageAt: string;
  createdAt: string;
}

export interface CopilotStatus {
  enabled: boolean;
  included: boolean;
  usage: { period: string; usedMicros: number; budgetMicros: number };
}

export type CopilotEvent =
  | { type: 'thread'; threadId: string; title: string | null }
  | { type: 'text'; text: string }
  | { type: 'tool.started'; toolUseId: string; tool: string; label: string }
  | { type: 'tool.finished'; toolUseId: string; tool: string; ok: boolean }
  | { type: 'action'; action: CopilotAction }
  | { type: 'done'; awaitingConfirmation: boolean }
  | { type: 'error'; code: string; message: string };

export const copilotApi = {
  status: () => apiFetch<CopilotStatus>('/v1/assistant/status', { auth: true }),
  threads: () => apiFetch<CopilotThreadSummary[]>('/v1/assistant/threads', { auth: true }),
  thread: (id: string) =>
    apiFetch<{ thread: CopilotThreadSummary; messages: CopilotMessage[] }>(`/v1/assistant/threads/${id}`, { auth: true }),
  removeThread: (id: string) => apiFetch<void>(`/v1/assistant/threads/${id}`, { method: 'DELETE', auth: true }),
  stop: (threadId: string) => apiFetch<void>(`/v1/assistant/threads/${threadId}/stop`, { method: 'POST', auth: true }),

  send: (body: { threadId?: string; text: string; screen?: string }, onEvent: (e: CopilotEvent) => void, signal: AbortSignal) =>
    stream('/v1/assistant/messages', body, onEvent, signal),
  confirm: (actionId: string, onEvent: (e: CopilotEvent) => void, signal: AbortSignal) =>
    stream(`/v1/assistant/actions/${actionId}/confirm`, undefined, onEvent, signal),
  reject: (actionId: string, onEvent: (e: CopilotEvent) => void, signal: AbortSignal) =>
    stream(`/v1/assistant/actions/${actionId}/reject`, undefined, onEvent, signal),
};

/** POSTs and reads the text/event-stream answer. A failure before the stream opens rejects with an ApiError. */
async function stream(path: string, body: unknown, onEvent: (e: CopilotEvent) => void, signal: AbortSignal): Promise<void> {
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

function parseFrame(frame: string): CopilotEvent | null {
  const data = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data) return null;
  try {
    return JSON.parse(data) as CopilotEvent;
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
