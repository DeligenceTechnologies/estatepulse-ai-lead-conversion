import { useCallback, useEffect, useRef, useState } from 'react';
import { messageFor } from '../../lib/api';
import { copilotApi, type CopilotAction, type CopilotEvent, type CopilotMessage, type CopilotStatus, type CopilotThreadSummary } from '../../utils/copilotApi';

export interface Step {
  id: string;
  label: string;
  ok?: boolean;
}

export interface ChatMessage extends CopilotMessage {
  steps?: Step[];
  pending?: boolean;
}

const DRAFT_ID = 'draft';

const upsertAction = (messages: ChatMessage[], action: CopilotAction): ChatMessage[] => {
  const owner = messages.findIndex((m) => m.actions.some((a) => a.id === action.id));
  if (owner === -1) {
    return messages.map((m) => (m.id === DRAFT_ID ? { ...m, actions: [...m.actions, action] } : m));
  }
  return messages.map((m, i) => (i === owner ? { ...m, actions: m.actions.map((a) => (a.id === action.id ? action : a)) } : m));
};

const draft = (): ChatMessage => ({
  id: DRAFT_ID,
  role: 'assistant',
  text: '',
  createdAt: new Date().toISOString(),
  actions: [],
  steps: [],
  pending: true,
});

export function useCopilot(open: boolean) {
  const [status, setStatus] = useState<CopilotStatus | null>(null);
  const [threads, setThreads] = useState<CopilotThreadSummary[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const threadRef = useRef<string | null>(null);
  threadRef.current = threadId;

  const loadThreads = useCallback(() => {
    copilotApi.threads().then(setThreads).catch(() => setThreads([]));
  }, []);

  useEffect(() => {
    if (!open) return;
    copilotApi
      .status()
      .then(setStatus)
      .catch((e) => setError(messageFor(e)));
    loadThreads();
  }, [open, loadThreads]);

  useEffect(() => () => abort.current?.abort(), []);

  const reload = useCallback(async (id: string) => {
    const view = await copilotApi.thread(id);
    if (threadRef.current === id) setMessages(view.messages);
  }, []);

  const onEvent = useCallback((event: CopilotEvent) => {
    switch (event.type) {
      case 'thread':
        setThreadId(event.threadId);
        threadRef.current = event.threadId;
        break;
      case 'text':
        setMessages((ms) => ms.map((m) => (m.id === DRAFT_ID ? { ...m, text: m.text + event.text } : m)));
        break;
      case 'tool.started':
        setMessages((ms) =>
          ms.map((m) => (m.id === DRAFT_ID ? { ...m, steps: [...(m.steps ?? []), { id: event.toolUseId, label: event.label }] } : m)),
        );
        break;
      case 'tool.finished':
        setMessages((ms) =>
          ms.map((m) =>
            m.id === DRAFT_ID ? { ...m, steps: (m.steps ?? []).map((s) => (s.id === event.toolUseId ? { ...s, ok: event.ok } : s)) } : m,
          ),
        );
        break;
      case 'action':
        setMessages((ms) => upsertAction(ms, event.action));
        break;
      case 'error':
        setError(event.message);
        break;
      case 'done':
        break;
    }
  }, []);

  const run = useCallback(
    async (start: (signal: AbortSignal) => Promise<void>) => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setBusy(true);
      setError(null);
      try {
        await start(controller.signal);
      } catch (e) {
        if (!controller.signal.aborted) setError(messageFor(e));
      } finally {
        if (abort.current === controller) {
          setBusy(false);
          const id = threadRef.current;
          if (id) await reload(id).catch(() => undefined);
          loadThreads();
        }
      }
    },
    [reload, loadThreads],
  );

  const send = useCallback(
    (text: string, screen?: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      setMessages((ms) => [
        ...ms.filter((m) => m.id !== DRAFT_ID),
        { id: `local-${Date.now()}`, role: 'user', text: trimmed, createdAt: new Date().toISOString(), actions: [] },
        draft(),
      ]);
      void run((signal) => copilotApi.send({ threadId: threadRef.current ?? undefined, text: trimmed, screen }, onEvent, signal));
    },
    [busy, run, onEvent],
  );

  const decide = useCallback(
    (actionId: string, decision: 'confirm' | 'reject') => {
      if (busy) return;
      setMessages((ms) => [...ms.filter((m) => m.id !== DRAFT_ID), draft()]);
      void run((signal) =>
        decision === 'confirm' ? copilotApi.confirm(actionId, onEvent, signal) : copilotApi.reject(actionId, onEvent, signal),
      );
    },
    [busy, run, onEvent],
  );

  const openThread = useCallback(
    async (id: string) => {
      abort.current?.abort();
      setBusy(false);
      setError(null);
      setThreadId(id);
      threadRef.current = id;
      setMessages([]);
      await reload(id).catch((e) => setError(messageFor(e)));
    },
    [reload],
  );

  const newChat = useCallback(() => {
    abort.current?.abort();
    setBusy(false);
    setError(null);
    setThreadId(null);
    threadRef.current = null;
    setMessages([]);
  }, []);

  const removeThread = useCallback(
    async (id: string) => {
      await copilotApi.removeThread(id).catch((e) => setError(messageFor(e)));
      if (threadRef.current === id) newChat();
      loadThreads();
    },
    [newChat, loadThreads],
  );

  // Closing the stream alone no longer stops the server: a turn finishes and is saved even if the
  // browser goes away. Stop tells the server, then stops reading.
  const stop = useCallback(() => {
    const id = threadRef.current;
    if (id) void copilotApi.stop(id).catch(() => undefined);
    abort.current?.abort();
  }, []);

  return { status, threads, threadId, messages, busy, error, send, decide, openThread, newChat, removeThread, stop, dismissError: () => setError(null) };
}
