import React, { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { Activity, CircleAlert, Loader2, MessageSquare, SquarePen, Trash2, X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { IconButton } from '../common/Button';
import { ActivityPanel } from './ActivityPanel';
import { useAssistant } from './AssistantProvider';
import { ChatMessages } from './ChatMessages';
import { Composer, type ComposerHandle } from './Composer';
import { greeting, starterPrompts, whenShort } from './starterPrompts';

const SCREEN = 'Home';
const isShortcut = (e: KeyboardEvent) => (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';

/**
 * The home page: the assistant's full-page chat. The left menu stays as on every page, the chat
 * fills the middle, and past chats sit on the right. The open chat is in the URL (`?chat=`), so a
 * refresh or a shared link reopens it.
 */
export const AssistantHome: React.FC = () => {
  const a = useAssistant();
  const { user, can } = useAuth();
  const [params, setParams] = useSearchParams();
  const chat = params.get('chat');
  const inputRef = useRef<ComposerHandle>(null);
  const endRef = useRef<HTMLDivElement>(null);
  // The right-hand panel: the office's activity (with cards waiting on the user first), or past chats.
  const [panel, setPanel] = useState<'activity' | 'chats'>('activity');

  // The URL names a chat: open it.
  useEffect(() => {
    if (chat && chat !== a.threadId) void a.openThread(chat);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat]);

  // A chat was started or opened here (or in the top bar): put it in the URL.
  useEffect(() => {
    if (a.threadId && a.threadId !== chat) setParams({ chat: a.threadId }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.threadId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [a.messages]);

  // The home page is the full chat; the panel from other pages should not reopen on its own later.
  useEffect(() => {
    a.setDockOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isShortcut(e)) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (a.availability === 'off' || a.availability === 'not_in_plan') return <Navigate to="/dashboard" replace />;
  if (a.availability === 'loading') {
    return (
      <div className="h-full flex items-center justify-center text-slate-500">
        <Loader2 className="w-5 h-5 animate-spin" aria-label="Loading" />
      </div>
    );
  }
  if (a.availability === 'error') {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center">
        <CircleAlert className="w-6 h-6 text-rose-400" aria-hidden />
        <p className="text-sm text-slate-300">The assistant could not be reached. Check your connection and reload the page.</p>
        <Link to="/dashboard" className="text-xs font-semibold text-emerald-400 hover:underline">
          Go to the Dashboard
        </Link>
      </div>
    );
  }

  const send = (text: string) => a.send(text, SCREEN);
  const newChat = () => {
    a.newChat();
    setParams({}, { replace: true });
    inputRef.current?.focus();
  };
  const remove = (id: string) => {
    if (id === chat) setParams({}, { replace: true });
    void a.removeThread(id);
  };
  const empty = a.messages.length === 0;
  // The server names a chat after its first question; until the list catches up, do the same here.
  const title = a.threads.find((t) => t.id === a.threadId)?.title ?? a.messages.find((m) => m.role === 'user')?.text.slice(0, 80) ?? 'New chat';
  const disabled = a.overBudget;
  const notice = a.overBudget ? "This month's assistant limit for your plan is used up. It resets on the 1st." : a.error;

  const composer = (
    <>
      {notice && (
        <div role="alert" className="mb-2 flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          <CircleAlert className="w-4 h-4 shrink-0" aria-hidden />
          <span className="flex-1">{notice}</span>
          {a.error && !a.overBudget && (
            <button type="button" onClick={a.dismissError} aria-label="Dismiss" className="cursor-pointer text-rose-300 hover:text-rose-100">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      )}
      <Composer
        ref={inputRef}
        large={empty}
        busy={a.busy}
        disabled={disabled}
        placeholder={empty ? 'Ask about your leads, calls or team. For example "which hot leads came in this week?"' : 'Reply, or ask something new'}
        onSend={send}
        onStop={a.stop}
      />
      <p className="mt-2 text-center text-2xs text-slate-500">The assistant can make mistakes. Every change needs your approval.</p>
    </>
  );

  return (
    <div className="h-full flex">
      <section className="flex-1 min-w-0 flex flex-col" aria-label="Ask EstatePulse">
        {empty ? (
          <div className="flex-1 overflow-y-auto custom-scrollbar flex items-center justify-center px-6 py-10">
            <div className="w-full max-w-2xl">
              <p className="text-center text-sm font-semibold text-emerald-400">
                {greeting(new Date().getHours())}
                {user?.firstName ? `, ${user.firstName}` : ''}
              </p>
              <h1 className="mt-1.5 mb-6 text-center text-3xl font-bold tracking-tight text-white">What can I help you with today?</h1>
              {composer}
              <div className="mt-7 grid gap-2.5 sm:grid-cols-2">
                {starterPrompts(can('lead.read')).map((p) => (
                  <button
                    key={p.title}
                    type="button"
                    disabled={a.busy || disabled}
                    onClick={() => send(p.title)}
                    className="cursor-pointer flex items-start gap-3 rounded-xl border border-slate-800 bg-slate-900/80 px-3.5 py-3 text-left transition-colors hover:border-emerald-500/40 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <span className="w-8 h-8 shrink-0 rounded-lg border border-emerald-500/20 bg-emerald-500/10 text-emerald-400 flex items-center justify-center">
                      <p.icon className="w-4 h-4" aria-hidden />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-slate-100">{p.title}</span>
                      <span className="block mt-0.5 text-xs text-slate-400">{p.hint}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="h-12 shrink-0 flex items-center gap-2 px-6 border-b border-slate-800/70">
              <p className="flex-1 min-w-0 truncate text-sm font-semibold text-slate-100">{title}</p>
              <IconButton size="sm" aria-label="New chat" title="New chat" icon={<SquarePen />} onClick={newChat} />
            </div>
            <div className="flex-1 overflow-y-auto custom-scrollbar px-6 py-6">
              <div className="mx-auto max-w-3xl">
                <ChatMessages messages={a.messages} busy={a.busy} onDecide={a.decide} />
                <div ref={endRef} />
              </div>
            </div>
            <div className="shrink-0 px-6 pb-4 pt-2">
              <div className="mx-auto max-w-3xl">{composer}</div>
            </div>
          </>
        )}
      </section>

      <aside className="hidden xl:flex w-[300px] shrink-0 flex-col border-l border-slate-800 bg-slate-900/60" aria-label={panel === 'activity' ? 'Activity' : 'Your chats'}>
        <div className="h-12 shrink-0 flex items-center gap-1 px-2 border-b border-slate-800" role="tablist">
          {([
            ['activity', 'Activity', Activity],
            ['chats', 'Your chats', MessageSquare],
          ] as const).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={panel === id}
              onClick={() => setPanel(id)}
              className={`cursor-pointer inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-xs font-bold transition-colors ${
                panel === id ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Icon className={`w-3.5 h-3.5 ${panel === id ? 'text-emerald-400' : ''}`} aria-hidden />
              {label}
            </button>
          ))}
          <span className="flex-1" />
          <IconButton size="sm" aria-label="New chat" title="New chat" icon={<SquarePen />} onClick={newChat} />
        </div>
        {panel === 'activity' && (
          <div className="flex-1 overflow-y-auto custom-scrollbar">
            <ActivityPanel onOpenChat={(id) => setParams({ chat: id })} refreshKey={a.busy} />
          </div>
        )}
        <div className={`flex-1 overflow-y-auto custom-scrollbar p-2 ${panel === 'chats' ? '' : 'hidden'}`}>
          {a.threads.length === 0 && <p className="p-4 text-center text-xs text-slate-500">No chats yet. Your questions will be listed here.</p>}
          <ul className="space-y-0.5">
            {a.threads.map((t) => (
              <li key={t.id} className="group flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setParams({ chat: t.id })}
                  className={`cursor-pointer flex-1 min-w-0 rounded-lg px-3 py-2 text-left transition-colors hover:bg-slate-800/70 ${
                    t.id === a.threadId ? 'bg-slate-800/80 text-slate-100' : 'text-slate-300'
                  }`}
                >
                  <span className="block truncate text-xs font-semibold">{t.title || 'Untitled chat'}</span>
                  <span className="block text-2xs text-slate-500">{whenShort(t.lastMessageAt)}</span>
                </button>
                <IconButton
                  size="sm"
                  aria-label="Delete chat"
                  title="Delete chat"
                  icon={<Trash2 />}
                  onClick={() => remove(t.id)}
                  className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                />
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
};
