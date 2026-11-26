import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { messageFor } from '../../lib/api';
import {
  assistantChatApi,
  type AssistantAction,
  type AssistantEvent,
  type AssistantMessage,
  type AssistantStatus,
  type AssistantThreadSummary,
} from '../../utils/assistantChatApi';

/** A tool the assistant ran while answering, shown as a line such as "Searching leads ✓". */
export interface Step {
  id: string;
  label: string;
  ok?: boolean;
}

export interface ChatMessage extends AssistantMessage {
  steps?: Step[];
  /** The reply being written right now. */
  pending?: boolean;
}

/**
 * Whether the assistant can be used here.
 * `off`: switched off on this server or for the office. `no_access`: this user's roles lack assistant.use.
 * `not_in_plan`: the office's plan does not include it.
 */
export type Availability = 'loading' | 'ready' | 'off' | 'not_in_plan' | 'no_access' | 'error';

export const DRAFT_ID = 'draft';

/** Puts a card on the message it belongs to, or on the reply being written when it is new. */
export const upsertAction = (messages: ChatMessage[], action: AssistantAction): ChatMessage[] => {
  const owner = messages.findIndex((m) => m.actions.some((a) => a.id === action.id));
  if (owner === -1) {
    return messages.map((m) => (m.id === DRAFT_ID ? { ...m, actions: [...m.actions, action] } : m));
  }
  return messages.map((m, i) => (i === owner ? { ...m, actions: m.actions.map((a) => (a.id === action.id ? action : a)) } : m));
};

/** Where the open chat is remembered, per user, so a reload or another page shows the same one until "New chat". */
export const chatStoreKey = (userId: string) => `ep_assistant_chat:${userId}`;

/** Browser storage can be off or full; the chat then simply is not remembered across reloads. */
export const readRememberedChat = (key: string | null): string | null => {
  if (!key) return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

export const rememberChat = (key: string | null, threadId: string | null): void => {
  if (!key) return;
  try {
    if (threadId) localStorage.setItem(key, threadId);
    else localStorage.removeItem(key);
  } catch {
    /* not remembered, nothing else breaks */
  }
};

export const availabilityOf = (status: AssistantStatus | null): Availability =>
  !status ? 'loading' : !status.enabled ? 'off' : status.allowed === false ? 'no_access' : !status.included ? 'not_in_plan' : 'ready';

const draft = (): ChatMessage => ({
  id: DRAFT_ID,
  role: 'assistant',
  text: '',
  createdAt: new Date().toISOString(),
  actions: [],
  steps: [],
  pending: true,
});

export interface AssistantContextValue {
  availability: Availability;
  status: AssistantStatus | null;
  /** This month's allowance is used up; asking is disabled until the 1st. */
  overBudget: boolean;
  threads: AssistantThreadSummary[];
  threadId: string | null;
  messages: ChatMessage[];
  busy: boolean;
  error: string | null;
  /** `screen` names the page the question was asked from, so "these leads" means something. */
  send: (text: string, screen?: string) => void;
  /** `count`: what the user typed to approve a bulk card above 10 leads. */
  decide: (actionId: string, decision: 'confirm' | 'reject', count?: number) => void;
  openThread: (id: string) => Promise<void>;
  newChat: () => void;
  removeThread: (id: string) => Promise<void>;
  stop: () => void;
  dismissError: () => void;
  /** The chat panel on every page but the home page; the header button and the corner icon both open it. */
  dockOpen: boolean;
  setDockOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

const noop = () => undefined;
const OFF: AssistantContextValue = {
  availability: 'off',
  status: null,
  overBudget: false,
  threads: [],
  threadId: null,
  messages: [],
  busy: false,
  error: null,
  send: noop,
  decide: noop,
  openThread: async () => undefined,
  newChat: noop,
  removeThread: async () => undefined,
  stop: noop,
  dismissError: noop,
  dockOpen: false,
  setDockOpen: noop,
};

const AssistantContext = createContext<AssistantContextValue | null>(null);

/** Outside the provider (a signed-out page, a test) the assistant is simply off. */
export const useAssistant = (): AssistantContextValue => useContext(AssistantContext) ?? OFF;

/**
 * One conversation for the whole signed-in app. The home page and the bar at the top of every
 * other page read and write the same chat, so a question asked from the Leads page carries on,
 * word for word, when "Continue in full chat" opens it on the home page.
 */
export const AssistantProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();
  const storeKey = user?.id ? chatStoreKey(user.id) : null;
  // Read once, before the effect below starts writing the (still empty) current chat.
  const [restoreId] = useState(() => readRememberedChat(storeKey));
  const [dockOpen, setDockOpen] = useState(false);
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [threads, setThreads] = useState<AssistantThreadSummary[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const threadRef = useRef<string | null>(null);
  threadRef.current = threadId;

  const availability: Availability = statusFailed ? 'error' : availabilityOf(status);
  const ready = availability === 'ready';
  const overBudget = status !== null && status.usage.usedMicros >= status.usage.budgetMicros;

  const loadThreads = useCallback(() => {
    assistantChatApi.threads().then(setThreads).catch(() => setThreads([]));
  }, []);

  const loadStatus = useCallback(() => {
    assistantChatApi
      .status()
      .then((s) => {
        setStatus(s);
        setStatusFailed(false);
      })
      .catch(() => setStatusFailed(true));
  }, []);

  useEffect(loadStatus, [loadStatus]);
  useEffect(() => {
    if (ready) loadThreads();
  }, [ready, loadThreads]);
  useEffect(() => () => abort.current?.abort(), []);

  // The open chat is the same on every page and after a reload, until the user starts a new one.
  useEffect(() => rememberChat(storeKey, threadId), [storeKey, threadId]);

  // Reopen the remembered chat, unless a page (the home page's ?chat=) already opened one.
  useEffect(() => {
    if (!ready || !restoreId || threadRef.current) return;
    const id = restoreId;
    setThreadId(id);
    threadRef.current = id;
    assistantChatApi
      .thread(id)
      .then((view) => {
        if (threadRef.current === id) setMessages(view.messages);
      })
      .catch(() => {
        // Deleted, or another user's on a shared browser: start fresh without an error.
        if (threadRef.current !== id) return;
        setThreadId(null);
        threadRef.current = null;
        setMessages([]);
      });
  }, [ready, restoreId]);

  const reload = useCallback(async (id: string) => {
    const view = await assistantChatApi.thread(id);
    if (threadRef.current === id) setMessages(view.messages);
  }, []);

  const onEvent = useCallback((event: AssistantEvent) => {
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
          // The saved chat is the truth: it replaces the streamed draft with what the server stored.
          if (id) await reload(id).catch(() => undefined);
          loadThreads();
          loadStatus();
        }
      }
    },
    [reload, loadThreads, loadStatus],
  );

  const send = useCallback(
    (text: string, screen?: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy || !ready || overBudget) return;
      setMessages((ms) => [
        ...ms.filter((m) => m.id !== DRAFT_ID),
        { id: `local-${Date.now()}`, role: 'user', text: trimmed, createdAt: new Date().toISOString(), actions: [] },
        draft(),
      ]);
      void run((signal) => assistantChatApi.send({ threadId: threadRef.current ?? undefined, text: trimmed, screen }, onEvent, signal));
    },
    [busy, ready, overBudget, run, onEvent],
  );

  const decide = useCallback(
    (actionId: string, decision: 'confirm' | 'reject', count?: number) => {
      if (busy) return;
      setMessages((ms) => [...ms.filter((m) => m.id !== DRAFT_ID), draft()]);
      void run((signal) =>
        decision === 'confirm' ? assistantChatApi.confirm(actionId, onEvent, signal, count) : assistantChatApi.reject(actionId, onEvent, signal),
      );
    },
    [busy, run, onEvent],
  );

  const openThread = useCallback(
    async (id: string) => {
      if (threadRef.current === id) return;
      // Stops reading the current stream only; a turn still running on the server finishes and is saved.
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
      await assistantChatApi.removeThread(id).catch((e) => setError(messageFor(e)));
      if (threadRef.current === id) newChat();
      loadThreads();
    },
    [newChat, loadThreads],
  );

  // Closing the stream alone does not stop the server: a turn finishes and is saved even if the
  // browser goes away. Stop tells the server, then stops reading.
  const stop = useCallback(() => {
    const id = threadRef.current;
    if (id) void assistantChatApi.stop(id).catch(() => undefined);
    abort.current?.abort();
    setBusy(false);
    setMessages((ms) => ms.map((m) => (m.id === DRAFT_ID ? { ...m, pending: false } : m)));
  }, []);

  const value = useMemo<AssistantContextValue>(
    () => ({
      availability,
      status,
      overBudget,
      threads,
      threadId,
      messages,
      busy,
      error,
      send,
      decide,
      openThread,
      newChat,
      removeThread,
      stop,
      dismissError: () => setError(null),
      dockOpen,
      setDockOpen,
    }),
    [availability, status, overBudget, threads, threadId, messages, busy, error, send, decide, openThread, newChat, removeThread, stop, dockOpen],
  );

  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
};
