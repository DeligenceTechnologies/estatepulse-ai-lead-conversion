import React from 'react';
import { Check, CircleAlert, Loader2, Sparkles } from 'lucide-react';
import { ApprovalCard } from './ApprovalCard';
import type { RefLink } from '../../utils/assistantChatApi';
import type { ChatMessage } from './AssistantProvider';
import { RichText } from './RichText';

interface ChatMessagesProps {
  messages: ChatMessage[];
  busy: boolean;
  onDecide: (actionId: string, decision: 'confirm' | 'reject', count?: number) => void;
  /** The drop-down under the top bar: no avatars, tighter spacing. */
  compact?: boolean;
  /** Links for the leads the answers name. */
  refs?: Record<string, RefLink>;
}

export const ChatMessages: React.FC<ChatMessagesProps> = ({ messages, busy, onDecide, compact = false, refs = {} }) => (
  <div className={compact ? 'space-y-3' : 'space-y-5'} aria-live="polite">
    {messages.map((m) => (
      <Message key={m.id} message={m} busy={busy} onDecide={onDecide} compact={compact} refs={refs} />
    ))}
  </div>
);

const Message: React.FC<{ message: ChatMessage; busy: boolean; onDecide: ChatMessagesProps['onDecide']; compact: boolean; refs: Record<string, RefLink> }> = ({
  message,
  busy,
  onDecide,
  compact,
  refs,
}) => {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <p className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-emerald-800/40 bg-emerald-950/50 px-3.5 py-2.5 text-sm text-slate-100 leading-relaxed">
          {message.text}
        </p>
      </div>
    );
  }

  const thinking = message.pending && !message.text && message.actions.length === 0;
  const body = (
    <div className="min-w-0 flex-1 space-y-3">
      {message.steps && message.steps.length > 0 && (
        <ul className="space-y-1">
          {message.steps.map((s) => (
            <li key={s.id} className="flex items-center gap-1.5 text-xs text-slate-500">
              {s.ok === undefined ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />
              ) : s.ok ? (
                <Check className="w-3.5 h-3.5 text-emerald-500" aria-hidden />
              ) : (
                <CircleAlert className="w-3.5 h-3.5 text-rose-400" aria-hidden />
              )}
              {s.label}
            </li>
          ))}
        </ul>
      )}
      {thinking && (
        <p className="flex items-center gap-2 text-sm text-slate-500">
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
          Thinking…
        </p>
      )}
      {message.text && <RichText text={message.text} refs={refs} />}
      {message.actions.map((a) => (
        <ApprovalCard key={a.id} action={a} disabled={busy} onDecide={(d, count) => onDecide(a.id, d, count)} />
      ))}
    </div>
  );

  if (compact) return body;
  return (
    <div className="flex gap-3">
      <span className="w-8 h-8 shrink-0 rounded-xl bg-slate-950 border border-slate-800 text-emerald-400 flex items-center justify-center">
        <Sparkles className="w-4 h-4" aria-hidden />
      </span>
      {body}
    </div>
  );
};
