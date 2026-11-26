import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CircleAlert, History, Maximize2, Mic, Sparkles, SquarePen, Trash2, X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { IconButton } from '../common/Button';
import { useAssistant } from './AssistantProvider';
import { ChatMessages } from './ChatMessages';
import { Composer, type ComposerHandle } from './Composer';
import { starterPrompts, whenShort } from './starterPrompts';
import { speechSupported } from './useSpeechInput';

/** A press longer than this is a hold: it speaks instead of opening the chat. */
export const HOLD_MS = 350;

export const dockHint = (canSpeak: boolean): string => (canSpeak ? 'Tap to type · Hold to speak' : 'Tap to ask');

const isShortcut = (e: KeyboardEvent) => (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';

interface AssistantDockProps {
  /** The page the chat was opened on, e.g. "All Leads". It goes with each question. */
  screen?: string;
}

/**
 * The assistant on every page but the home page: a button in the corner that opens a small chat
 * over the page. Tap it to type; hold it to speak, and the words land in the box to send. It is the
 * same chat as the home page, so "Open in full chat" carries on there.
 */
export const AssistantDock: React.FC<AssistantDockProps> = ({ screen }) => {
  const a = useAssistant();
  const { can } = useAuth();
  const navigate = useNavigate();
  // Shared with the header's Ask EstatePulse button, which opens the same panel.
  const { dockOpen: open, setDockOpen: setOpen } = a;
  const [showHistory, setShowHistory] = useState(false);
  const [holding, setHolding] = useState(false);
  const composer = useRef<ComposerHandle>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const holdTimer = useRef<number | null>(null);
  // The press turned into a hold, so the click that follows it is not a tap.
  const wasHold = useRef(false);
  // A hold opened the panel; start listening once the box is on screen.
  const listenOnOpen = useRef(false);
  // Hold-to-speak needs the browser's speech input and the office's microphone setting.
  const canSpeak = speechSupported() && a.status?.voiceEnabled !== false;

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
  }, [setOpen]);

  useEffect(() => {
    if (!open) return;
    if (listenOnOpen.current) {
      listenOnOpen.current = false;
      composer.current?.startVoice();
    } else {
      composer.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ block: 'end' });
  }, [a.messages, open, showHistory]);

  useEffect(() => () => {
    if (holdTimer.current) window.clearTimeout(holdTimer.current);
  }, []);

  const endPress = () => {
    if (holdTimer.current) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    if (wasHold.current) {
      composer.current?.stopVoice();
      setHolding(false);
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!canSpeak || e.button !== 0) return;
    wasHold.current = false;
    // On a phone the panel opens over the button, so the release is caught on the window.
    const release = () => {
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      endPress();
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = null;
      wasHold.current = true;
      setHolding(true);
      setShowHistory(false);
      if (open) composer.current?.startVoice();
      else {
        listenOnOpen.current = true;
        setOpen(true);
      }
    }, HOLD_MS);
  };

  const onClick = () => {
    if (wasHold.current) {
      wasHold.current = false;
      return;
    }
    setOpen((o) => !o);
  };

  const openFullChat = () => {
    setOpen(false);
    navigate(a.threadId ? `/assistant?chat=${a.threadId}` : '/assistant');
  };

  const notice = a.overBudget ? "This month's assistant limit for your plan is used up. It resets on the 1st." : a.error;

  return (
    <>
      {open && (
        <section
          aria-label="Ask EstatePulse"
          className="fixed z-50 inset-0 sm:inset-auto sm:right-5 sm:bottom-24 sm:w-[420px] sm:h-[min(640px,calc(100vh-8rem))] flex flex-col bg-slate-950 border border-slate-800 sm:rounded-2xl shadow-2xl overflow-hidden"
        >
          <header className="flex items-center gap-1.5 px-4 h-12 border-b border-slate-800 shrink-0">
            <Sparkles className="w-4 h-4 text-emerald-400" aria-hidden />
            <h2 className="text-sm font-bold text-slate-100 flex-1 truncate">Ask EstatePulse</h2>
            <IconButton size="sm" aria-label="Past chats" title="Past chats" icon={<History />} onClick={() => setShowHistory((s) => !s)} aria-pressed={showHistory} />
            <IconButton
              size="sm"
              aria-label="New chat"
              title="New chat"
              icon={<SquarePen />}
              onClick={() => {
                a.newChat();
                setShowHistory(false);
                composer.current?.focus();
              }}
            />
            <IconButton size="sm" aria-label="Open in full chat" title="Open in full chat" icon={<Maximize2 />} onClick={openFullChat} />
            <IconButton size="sm" aria-label="Close" title="Close" icon={<X />} onClick={() => setOpen(false)} />
          </header>

          {showHistory ? (
            <div className="flex-1 overflow-y-auto custom-scrollbar p-2">
              {a.threads.length === 0 && <p className="p-4 text-center text-xs text-slate-500">No chats yet.</p>}
              <ul className="space-y-0.5">
                {a.threads.map((t) => (
                  <li key={t.id} className="group flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        void a.openThread(t.id);
                        setShowHistory(false);
                      }}
                      className={`cursor-pointer flex-1 min-w-0 rounded-lg px-3 py-2 text-left hover:bg-slate-900 ${t.id === a.threadId ? 'bg-slate-900 text-slate-100' : 'text-slate-300'}`}
                    >
                      <span className="block truncate text-xs font-semibold">{t.title || 'Untitled chat'}</span>
                      <span className="block text-2xs text-slate-500">{whenShort(t.lastMessageAt)}</span>
                    </button>
                    <IconButton
                      size="sm"
                      aria-label="Delete chat"
                      icon={<Trash2 />}
                      onClick={() => void a.removeThread(t.id)}
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    />
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto custom-scrollbar px-4 py-4">
              {a.messages.length === 0 ? (
                <div className="space-y-3 pt-4">
                  <p className="text-sm font-semibold text-slate-200">
                    {screen ? `Ask about ${screen.toLowerCase()}, or anything else.` : 'Ask about your leads, or tell the assistant what to do.'}
                  </p>
                  <p className="text-xs text-slate-500">It asks you to approve before it changes anything.</p>
                  <div className="flex flex-col gap-2 pt-2">
                    {starterPrompts(can('lead.read'))
                      .slice(0, 3)
                      .map((p) => (
                        <button
                          key={p.title}
                          type="button"
                          disabled={a.busy || a.overBudget}
                          onClick={() => a.send(p.title, screen)}
                          className="cursor-pointer flex items-center gap-2.5 text-left text-xs px-3 py-2 rounded-lg border border-slate-800 text-slate-300 hover:border-emerald-500/40 hover:text-slate-100 disabled:opacity-50"
                        >
                          <p.icon className="w-3.5 h-3.5 shrink-0 text-emerald-400" aria-hidden />
                          {p.title}
                        </button>
                      ))}
                  </div>
                </div>
              ) : (
                <ChatMessages compact messages={a.messages} busy={a.busy} onDecide={a.decide} />
              )}
              <div ref={endRef} />
            </div>
          )}

          {notice && (
            <div role="alert" className="mx-4 mb-2 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-2xs text-rose-200">
              <CircleAlert className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden />
              <span className="flex-1">{notice}</span>
              {a.error && !a.overBudget && (
                <button type="button" onClick={a.dismissError} aria-label="Dismiss" className="cursor-pointer text-rose-300 hover:text-rose-100">
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}
          <div className="shrink-0 px-3 pb-3">
            <Composer
              voice={a.status?.voiceEnabled !== false}
              ref={composer}
              busy={a.busy}
              disabled={a.overBudget}
              placeholder={screen ? `Ask about ${screen.toLowerCase()}…` : 'Ask EstatePulse…'}
              onSend={(text) => {
                setShowHistory(false);
                a.send(text, screen);
              }}
              onStop={a.stop}
            />
            <p className="mt-1.5 text-center text-2xs text-slate-500">Every change needs your approval.</p>
          </div>
        </section>
      )}

      <div className="fixed z-40 right-[max(1.25rem,env(safe-area-inset-right))] bottom-[max(0.75rem,env(safe-area-inset-bottom))] flex flex-col items-end gap-1.5 select-none">
        <button
          type="button"
          onClick={onClick}
          onPointerDown={onPointerDown}
          onContextMenu={(e) => e.preventDefault()}
          aria-label={open ? 'Close Ask EstatePulse' : 'Ask EstatePulse'}
          aria-expanded={open}
          title={`Ask EstatePulse · ${dockHint(canSpeak)}`}
          className={`cursor-pointer h-14 w-14 rounded-full bg-brand-600 text-on-accent shadow-lg shadow-black/40 hover:bg-brand-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60 flex items-center justify-center transition-colors touch-none ${
            holding ? 'ring-4 ring-emerald-400/40 animate-pulse' : ''
          }`}
        >
          {holding ? <Mic className="w-6 h-6" aria-hidden /> : open ? <X className="w-6 h-6" aria-hidden /> : <Sparkles className="w-6 h-6" aria-hidden />}
        </button>
        {!open && (
          <span className="hidden sm:block rounded-full bg-slate-950/85 px-2 py-0.5 text-2xs text-slate-400 backdrop-blur pointer-events-none">
            {dockHint(canSpeak)}
          </span>
        )}
        {holding && (
          <span className="rounded-full bg-slate-950/85 px-2 py-0.5 text-2xs font-semibold text-emerald-300 backdrop-blur pointer-events-none">
            Listening… release to stop
          </span>
        )}
      </div>
    </>
  );
};
