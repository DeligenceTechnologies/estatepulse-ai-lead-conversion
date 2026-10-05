import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Ban, CheckCircle2, Clock, RotateCw, Search, XCircle } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { useLiveQuery } from '../../lib/useLiveQuery';
import {
  listConversations,
  listMessages,
  type ConversationRow,
  type MessageRow,
} from '../../utils/historyApi';

/**
 * SMS history for the office.
 *
 * Read-only, and deliberately so. The previous version of this screen had a
 * compose box, a "take over" button and an automation toggle, all of which
 * wrote to localStorage and none of which sent anything — the backend has no
 * agent-send endpoint, and inventing one is a different piece of work from
 * showing the history. A composer that silently does nothing is worse than no
 * composer.
 *
 * What IS real: every outbound message the engine and the nurture runner sent,
 * every inbound reply, delivery state, and whether the lead has opted out.
 */

const TEMP_STYLES: Record<string, string> = {
  hot: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
  warm: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  cold: 'bg-sky-500/20 text-sky-300 border-sky-500/40',
};

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

export const ConversationsView: React.FC = () => {
  const { setSelectedLeadId } = useApp();
  const [q, setQ] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const fetchThreads = useCallback(() => listConversations(), []);
  const threadsQuery = useLiveQuery<ConversationRow[]>(fetchThreads);
  const all = threadsQuery.data ?? [];

  // Filtered in the browser: the thread list is capped at 200 and the filter is
  // a substring match, so a round trip per keystroke would buy nothing.
  const needle = q.trim().toLowerCase();
  const threads = needle
    ? all.filter(
        (t) =>
          t.leadName.toLowerCase().includes(needle) || (t.leadPhone ?? '').includes(needle),
      )
    : all;

  const fetchMessages = useCallback(
    () => (selectedId ? listMessages(selectedId) : Promise.resolve([])),
    [selectedId],
  );
  const messagesQuery = useLiveQuery<MessageRow[]>(fetchMessages, { refreshKey: selectedId });
  const messages = messagesQuery.data ?? [];

  useEffect(() => {
    if (threads.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!selectedId || !threads.some((t) => t.id === selectedId)) setSelectedId(threads[0].id);
  }, [threads, selectedId]);

  const current = threads.find((t) => t.id === selectedId) ?? null;

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto text-slate-100">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight">Conversations</h2>
          <p className="text-xs text-slate-400">
            Every SMS thread — what we sent, what came back, and who asked us to stop.
          </p>
        </div>
        <button
          onClick={threadsQuery.refresh}
          className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium border border-slate-700 flex items-center gap-1.5 transition-colors cursor-pointer"
        >
          <RotateCw className={`w-3.5 h-3.5 ${threadsQuery.refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {threadsQuery.stale && (
        <div className="flex items-center gap-2 text-xs text-amber-300 bg-amber-950/40 border border-amber-800/40 rounded-lg px-3 py-2">
          <AlertTriangle className="w-3.5 h-3.5" />
          Showing the last good result — the most recent refresh failed.
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Threads */}
        <div className="lg:col-span-4 bg-slate-900/90 border border-slate-800 rounded-2xl p-4 space-y-3 shadow-xl">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name or number"
              className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-2 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-emerald-600"
            />
          </div>

          <div className="space-y-2 max-h-[580px] overflow-y-auto custom-scrollbar pr-1">
            {threads.length === 0 && (
              <div className="text-xs text-slate-500 py-8 text-center">
                {threadsQuery.data === null
                  ? 'Loading…'
                  : needle
                    ? 'No threads match.'
                    : 'No SMS threads yet.'}
              </div>
            )}

            {threads.map((t) => (
              <div
                key={t.id}
                onClick={() => setSelectedId(t.id)}
                className={`p-3 rounded-xl border transition-all cursor-pointer space-y-1.5 ${
                  t.id === selectedId
                    ? 'bg-slate-800/90 border-emerald-500/60'
                    : 'bg-slate-950/60 border-slate-800/80 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold text-xs text-white truncate">{t.leadName}</span>
                  <div className="flex items-center gap-1 shrink-0">
                    {t.dncStatus && (
                      <span
                        title="Opted out"
                        className="text-2xs uppercase font-bold px-1.5 rounded border bg-rose-500/20 text-rose-300 border-rose-500/40 flex items-center gap-0.5"
                      >
                        <Ban className="w-2.5 h-2.5" />
                        stop
                      </span>
                    )}
                    {t.temperature && (
                      <span
                        className={`text-2xs uppercase font-bold px-1.5 rounded border ${
                          TEMP_STYLES[t.temperature] ?? 'bg-slate-800 text-slate-400 border-slate-700'
                        }`}
                      >
                        {t.temperature}
                      </span>
                    )}
                  </div>
                </div>

                <p className="text-xs text-slate-400 truncate">
                  {t.lastMessageDirection === 'inbound' && (
                    <span className="text-emerald-400 font-semibold">↩ </span>
                  )}
                  {t.lastMessageBody ?? 'No messages yet'}
                </p>

                <div className="flex items-center justify-between text-2xs text-slate-500">
                  <span className="font-mono">{t.leadPhone ?? '—'}</span>
                  <span>
                    {t.lastMessageAt
                      ? new Date(t.lastMessageAt).toLocaleString([], {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })
                      : ''}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Thread */}
        {current ? (
          <div className="lg:col-span-8 bg-slate-900/90 border border-slate-800 rounded-2xl shadow-xl flex flex-col">
            <div className="flex flex-wrap items-center justify-between gap-3 p-5 border-b border-slate-800">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-bold text-white">{current.leadName}</h3>
                  <span className="text-xs font-mono text-cyan-400">{current.leadPhone}</span>
                </div>
                <p className="text-xs text-slate-400 mt-0.5">
                  {current.messageCount} message{current.messageCount === 1 ? '' : 's'}
                  {current.hasInboundReply && <> • the lead has replied</>}
                </p>
              </div>
              <button
                onClick={() => setSelectedLeadId(current.leadId)}
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium border border-slate-700 transition-colors cursor-pointer"
              >
                View Lead Dossier
              </button>
            </div>

            {current.dncStatus && (
              <div className="mx-5 mt-4 flex items-start gap-2 text-xs text-rose-300 bg-rose-950/40 border border-rose-800/40 rounded-lg px-3 py-2">
                <Ban className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>
                  This lead has opted out. Every scheduled step was cancelled and nothing further
                  will be sent without explicit re-consent.
                </span>
              </div>
            )}

            <div className="p-5 space-y-3 max-h-[520px] overflow-y-auto custom-scrollbar">
              {messages.length === 0 && (
                <p className="text-xs text-slate-500 text-center py-8">
                  {messagesQuery.data === null ? 'Loading…' : 'No messages in this thread.'}
                </p>
              )}

              {messages.map((m) => {
                const inbound = m.direction === 'inbound';
                return (
                  <div key={m.id} className={`flex ${inbound ? 'justify-start' : 'justify-end'}`}>
                    <div
                      className={`max-w-[75%] rounded-2xl px-3.5 py-2.5 space-y-1 border ${
                        inbound
                          ? 'bg-slate-950 border-slate-800'
                          : 'bg-emerald-950/50 border-emerald-800/40'
                      }`}
                    >
                      <p className="text-xs text-slate-100 leading-relaxed whitespace-pre-wrap">
                        {m.body}
                      </p>
                      <div className="flex items-center gap-2 text-2xs text-slate-500">
                        <span className="uppercase font-semibold">{m.senderType}</span>
                        <span>
                          {new Date(m.sentAt ?? m.createdAt).toLocaleString([], {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                        <DeliveryMark m={m} />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="lg:col-span-8 flex items-center justify-center p-12 text-xs text-slate-500">
            Select a conversation.
          </div>
        )}
      </div>
    </div>
  );
};
