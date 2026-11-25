import React, { useEffect, useRef, useState } from 'react';
import { Check, CircleAlert, History, Loader2, Plus, SendHorizonal, Sparkles, Square, Trash2, X } from 'lucide-react';
import { IconButton } from '../common/Button';
import { ActionCard } from './ActionCard';
import { MicButton } from './MicButton';
import { useCopilot, type ChatMessage } from './useCopilot';

const SUGGESTIONS = ['How many new leads came in today?', 'Show my hot leads with no agent', 'Summarise the last call with my newest lead'];

interface CopilotDockProps {
  /** The screen the user is on, so "this" in a request means something. */
  screen?: string;
}

const isShortcut = (e: KeyboardEvent) => (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';

export const CopilotDock: React.FC<CopilotDockProps> = ({ screen }) => {
  const [open, setOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [input, setInput] = useState('');
  const voiceBase = useRef('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const copilot = useCopilot(open);
  const { status, messages, busy, error } = copilot;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isShortcut(e)) {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open, copilot.threadId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  const unavailable = status && !status.enabled ? 'Copilot is not switched on for this workspace yet.' : status && !status.included ? 'Copilot is part of the Professional plan and above.' : null;
  const overBudget = status !== null && status.usage.usedMicros >= status.usage.budgetMicros;

  const submit = () => {
    if (!input.trim() || busy || unavailable) return;
    copilot.send(input, screen);
    setInput('');
  };

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open Copilot (Ctrl+K)"
          title="Copilot (Ctrl+K)"
          className="fixed z-40 bottom-[max(1.25rem,env(safe-area-inset-bottom))] right-[max(1.25rem,env(safe-area-inset-right))] h-12 w-12 rounded-full bg-brand-600 text-on-accent shadow-lg shadow-black/30 hover:bg-brand-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60 flex items-center justify-center transition-colors"
        >
          <Sparkles className="w-5 h-5" aria-hidden />
        </button>
      )}

      {open && (
        <section
          aria-label="Copilot"
          className="fixed z-50 inset-0 sm:inset-auto sm:bottom-5 sm:right-5 sm:w-[420px] sm:h-[min(640px,calc(100vh-2.5rem))] flex flex-col bg-slate-950 border border-slate-800 sm:rounded-2xl shadow-2xl overflow-hidden"
        >
          <header className="flex items-center gap-2 px-4 h-12 border-b border-slate-800 shrink-0">
            <Sparkles className="w-4 h-4 text-emerald-400" aria-hidden />
            <h2 className="text-sm font-bold text-slate-100 flex-1">Copilot</h2>
            <IconButton size="sm" aria-label="Chat history" icon={<History />} onClick={() => setShowHistory((s) => !s)} aria-pressed={showHistory} />
            <IconButton
              size="sm"
              aria-label="New chat"
              icon={<Plus />}
              onClick={() => {
                copilot.newChat();
                setShowHistory(false);
              }}
            />
            <IconButton size="sm" aria-label="Close Copilot" icon={<X />} onClick={() => setOpen(false)} />
          </header>

          {showHistory ? (
            <div className="flex-1 overflow-y-auto custom-scrollbar p-2">
              {copilot.threads.length === 0 && <p className="text-xs text-slate-500 p-4 text-center">No chats yet.</p>}
              <ul className="space-y-1">
                {copilot.threads.map((t) => (
                  <li key={t.id} className="group flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        void copilot.openThread(t.id);
                        setShowHistory(false);
                      }}
                      className={`flex-1 min-w-0 text-left px-3 py-2 rounded-lg text-xs hover:bg-slate-900 ${t.id === copilot.threadId ? 'bg-slate-900 text-slate-100' : 'text-slate-300'}`}
                    >
                      <span className="block truncate">{t.title || 'Untitled chat'}</span>
                      <span className="block text-2xs text-slate-500">{new Date(t.lastMessageAt).toLocaleString()}</span>
                    </button>
                    <IconButton size="sm" aria-label="Delete chat" icon={<Trash2 />} onClick={() => void copilot.removeThread(t.id)} className="opacity-60 group-hover:opacity-100" />
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto custom-scrollbar px-4 py-4 space-y-4">
              {messages.length === 0 && (
                <div className="space-y-3 pt-6">
                  <p className="text-sm text-slate-200 font-semibold">Ask about your leads, or tell Copilot what to do.</p>
                  <p className="text-xs text-slate-500">It asks you to confirm before changing anything.</p>
                  <div className="flex flex-col gap-2 pt-2">
                    {SUGGESTIONS.map((s) => (
                      <button
                        key={s}
                        type="button"
                        disabled={busy || Boolean(unavailable)}
                        onClick={() => copilot.send(s, screen)}
                        className="text-left text-xs px-3 py-2 rounded-lg border border-slate-800 text-slate-300 hover:border-emerald-500/40 hover:text-slate-100 disabled:opacity-50"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {messages.map((m) => (
                <Message key={m.id} message={m} busy={busy} onDecide={copilot.decide} />
              ))}
              <div ref={endRef} />
            </div>
          )}

          {(unavailable || overBudget || error) && (
            <div role="alert" className="mx-4 mb-2 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-2xs text-rose-200">
              <CircleAlert className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden />
              <span className="flex-1">{unavailable ?? (overBudget ? "Copilot has reached this month's limit for your plan." : error)}</span>
              {error && !unavailable && (
                <button type="button" onClick={copilot.dismissError} aria-label="Dismiss" className="text-rose-300 hover:text-rose-100">
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}

          <form
            className="border-t border-slate-800 p-3 flex items-end gap-2 shrink-0"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <label htmlFor="copilot-input" className="sr-only">
              Message Copilot
            </label>
            <textarea
              id="copilot-input"
              ref={inputRef}
              rows={1}
              value={input}
              maxLength={4000}
              disabled={Boolean(unavailable)}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder={screen ? `Ask about ${screen.toLowerCase()}…` : 'Ask Copilot…'}
              className="flex-1 resize-none max-h-32 min-h-9 rounded-lg bg-slate-900 border border-slate-800 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500/50"
            />
            <MicButton
              disabled={busy || Boolean(unavailable)}
              onStart={() => {
                voiceBase.current = input ? `${input.trimEnd()} ` : '';
              }}
              onTranscript={(t) => setInput(voiceBase.current + t)}
            />
            {busy ? (
              <IconButton variant="secondary" aria-label="Stop" icon={<Square />} onClick={copilot.stop} />
            ) : (
              <IconButton type="submit" variant="primary" aria-label="Send" icon={<SendHorizonal />} disabled={!input.trim() || Boolean(unavailable)} />
            )}
          </form>
        </section>
      )}
    </>
  );
};

const Message: React.FC<{ message: ChatMessage; busy: boolean; onDecide: (id: string, d: 'confirm' | 'reject') => void }> = ({ message, busy, onDecide }) => {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-brand-600 text-on-accent px-3 py-2 text-sm">{message.text}</p>
      </div>
    );
  }

  const thinking = message.pending && !message.text && message.actions.length === 0;
  return (
    <div className="space-y-2">
      {message.steps && message.steps.length > 0 && (
        <ul className="space-y-1">
          {message.steps.map((s) => (
            <li key={s.id} className="flex items-center gap-1.5 text-2xs text-slate-500">
              {s.ok === undefined ? (
                <Loader2 className="w-3 h-3 animate-spin" aria-hidden />
              ) : s.ok ? (
                <Check className="w-3 h-3 text-emerald-500" aria-hidden />
              ) : (
                <CircleAlert className="w-3 h-3 text-rose-400" aria-hidden />
              )}
              {s.label}
            </li>
          ))}
        </ul>
      )}
      {thinking && (
        <p className="flex items-center gap-2 text-xs text-slate-500">
          <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />
          Thinking…
        </p>
      )}
      {message.text && <p className="whitespace-pre-wrap break-words text-sm text-slate-200 leading-relaxed">{message.text}</p>}
      {message.actions.map((a) => (
        <ActionCard key={a.id} action={a} disabled={busy} onConfirm={() => onDecide(a.id, 'confirm')} onReject={() => onDecide(a.id, 'reject')} />
      ))}
    </div>
  );
};
