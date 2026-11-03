import React from 'react';
import { CheckCircle2, Clock, XCircle } from 'lucide-react';
import type { MessageRow } from '../../utils/historyApi';
import { formatDateTime } from '../../lib/datetime';

/** Who wrote a message, as the person reading the thread would say it. */
const SENDER_LABEL: Record<string, string> = { ai: 'AI assistant', lead: 'Lead', user: 'Agent' };

const DeliveryMark: React.FC<{ m: MessageRow }> = ({ m }) => {
  if (m.direction === 'inbound') return null;
  if (m.failedAt || m.deliveryStatus === 'failed') {
    return (
      <span className="flex items-center gap-1 text-rose-400">
        <XCircle className="w-3 h-3" />
        failed
      </span>
    );
  }
  if (m.deliveredAt) {
    return (
      <span className="flex items-center gap-1 text-emerald-400">
        <CheckCircle2 className="w-3 h-3" />
        delivered
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-slate-500">
      <Clock className="w-3 h-3" />
      {m.deliveryStatus}
    </span>
  );
};

/**
 * One SMS thread as chat bubbles: the lead on the left, everything we sent (the
 * strategy, the nurture runner, the AI assistant) on the right with its
 * delivery state. `messages` null means it is still loading.
 */
export const MessageThread: React.FC<{ messages: MessageRow[] | null; className?: string }> = ({ messages, className = '' }) => (
  <div className={`space-y-3 ${className}`}>
    {(messages === null || messages.length === 0) && (
      <p className="text-xs text-slate-500 text-center py-8">{messages === null ? 'Loading…' : 'No messages in this thread.'}</p>
    )}

    {(messages ?? []).map((m) => {
      const inbound = m.direction === 'inbound';
      return (
        <div key={m.id} className={`flex ${inbound ? 'justify-start' : 'justify-end'}`}>
          <div
            className={`max-w-[75%] rounded-2xl px-3.5 py-2.5 space-y-1 border ${
              inbound ? 'bg-slate-950 border-slate-800' : 'bg-emerald-950/50 border-emerald-800/40'
            }`}
          >
            <p className="text-xs text-slate-100 leading-relaxed whitespace-pre-wrap">{m.body}</p>
            <div className="flex items-center gap-2 text-2xs text-slate-500">
              <span className="uppercase font-semibold">{SENDER_LABEL[m.senderType] ?? m.senderType}</span>
              <span>
                {formatDateTime(m.sentAt ?? m.createdAt, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </span>
              <DeliveryMark m={m} />
            </div>
          </div>
        </div>
      );
    })}
  </div>
);
