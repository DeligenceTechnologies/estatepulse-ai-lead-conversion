import React, { useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Ban, Inbox, RotateCw } from 'lucide-react';
import { useLiveQuery } from '../../lib/useLiveQuery';
import { formatDateTime } from '../../lib/datetime';
import { MessageThread } from '../conversations/MessageThread';
import { getMyConversations, getMyLeadMessages, type ConversationRow, type MessageRow } from '../../utils/agentMeApi';

const TEMP_STYLES: Record<string, string> = {
  hot: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
  warm: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  cold: 'bg-sky-500/20 text-sky-300 border-sky-500/40',
};

const shortTime = (iso: string | null) =>
  iso ? formatDateTime(iso, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

/**
 * The SMS threads of the agent's own leads: what the AI and the strategy sent
 * and what the lead answered, up to the booking that brought the lead to them.
 *
 * Read-only, like the office's Conversations screen. Every request is
 * `/agents/me/...`, so the server decides which leads are theirs; a lead
 * reassigned to someone else disappears from here on the next refresh.
 */
export const AgentConversations: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('lead');
  const select = (id: string) => setParams({ lead: id }, { replace: true });

  const fetchThreads = useCallback(() => getMyConversations(), []);
  const threadsQuery = useLiveQuery<ConversationRow[]>(fetchThreads);
  const threads = threadsQuery.data ?? [];

  const fetchMessages = useCallback(() => (selectedId ? getMyLeadMessages(selectedId) : Promise.resolve([])), [selectedId]);
  const messagesQuery = useLiveQuery<MessageRow[]>(fetchMessages, { refreshKey: selectedId });

  // Open the newest thread when none (or one no longer theirs) is selected.
  useEffect(() => {
    if (threadsQuery.data === null) return;
    if (threads.length === 0) {
      if (selectedId) setParams({}, { replace: true });
      return;
    }
    if (!selectedId || !threads.some((t) => t.id === selectedId)) setParams({ lead: threads[0].id }, { replace: true });
  }, [threads, threadsQuery.data, selectedId, setParams]);

  const current = threads.find((t) => t.id === selectedId) ?? null;

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto text-slate-100">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight">Conversations</h2>
          <p className="text-xs text-slate-400">Text threads of the leads assigned to you, including the AI&apos;s chat before you got them.</p>
        </div>
        <button
          onClick={threadsQuery.refresh}
          className="px-3 py-2 bg-slate-900 border border-slate-800 hover:border-slate-700 text-slate-300 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
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

      {threadsQuery.data !== null && threads.length === 0 ? (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-8 text-center space-y-3">
          <Inbox className="w-6 h-6 text-slate-600 mx-auto" />
          <p className="text-xs text-slate-400 leading-relaxed max-w-md mx-auto">
            No text conversations yet.
            <span className="block text-slate-500 mt-1">When a lead who texted with the AI is assigned to you, the whole chat shows up here.</span>
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-4 bg-slate-900/90 border border-slate-800 rounded-2xl p-4 space-y-2 shadow-xl max-h-[640px] overflow-y-auto custom-scrollbar">
            {threadsQuery.data === null && <p className="text-xs text-slate-500 py-8 text-center">Loading…</p>}
            {threads.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => select(t.id)}
                className={`w-full text-left p-3 rounded-xl border transition-all cursor-pointer space-y-1.5 ${
                  t.id === selectedId ? 'bg-slate-800/90 border-emerald-500/60' : 'bg-slate-950/60 border-slate-800/80 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold text-xs text-white truncate">{t.leadName}</span>
                  <div className="flex items-center gap-1 shrink-0">
                    {t.dncStatus && (
                      <span className="text-2xs uppercase font-bold px-1.5 rounded border bg-rose-500/20 text-rose-300 border-rose-500/40 flex items-center gap-0.5">
                        <Ban className="w-2.5 h-2.5" />
                        stop
                      </span>
                    )}
                    {t.temperature && (
                      <span className={`text-2xs uppercase font-bold px-1.5 rounded border ${TEMP_STYLES[t.temperature] ?? 'bg-slate-800 text-slate-400 border-slate-700'}`}>
                        {t.temperature}
                      </span>
                    )}
                  </div>
                </div>
                <p className="text-xs text-slate-400 truncate">
                  {t.lastMessageDirection === 'inbound' && <span className="text-emerald-400 font-semibold">↩ </span>}
                  {t.lastMessageBody ?? 'No messages yet'}
                </p>
                <div className="flex items-center justify-between text-2xs text-slate-500">
                  <span className="font-mono">{t.leadPhone ?? '—'}</span>
                  <span>{shortTime(t.lastMessageAt)}</span>
                </div>
              </button>
            ))}
          </div>

          <div className="lg:col-span-8 bg-slate-900/90 border border-slate-800 rounded-2xl shadow-xl flex flex-col">
            {current ? (
              <>
                <div className="p-5 border-b border-slate-800">
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-bold text-white">{current.leadName}</h3>
                    <span className="text-xs font-mono text-cyan-400">{current.leadPhone}</span>
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {current.messageCount} message{current.messageCount === 1 ? '' : 's'}
                    {current.hasInboundReply && <> • the lead has replied</>}
                  </p>
                </div>
                {current.dncStatus && (
                  <div className="mx-5 mt-4 flex items-start gap-2 text-xs text-rose-300 bg-rose-950/40 border border-rose-800/40 rounded-lg px-3 py-2">
                    <Ban className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span>This lead asked us to stop texting. Do not text them unless they opt back in.</span>
                  </div>
                )}
                <MessageThread messages={messagesQuery.data} className="p-5 max-h-[560px] overflow-y-auto custom-scrollbar" />
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center p-12 text-xs text-slate-500">Select a conversation.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
