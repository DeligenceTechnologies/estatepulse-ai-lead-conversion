import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Ban, Bot, Inbox, Loader2, RotateCw, Send, UserRound } from 'lucide-react';
import { toast } from 'react-toastify';
import { useAuth } from '../../context/AuthContext';
import { messageFor } from '../../lib/api';
import { useLiveEvents } from '../../lib/liveEvents';
import { useLiveQuery } from '../../lib/useLiveQuery';
import { formatDateTime } from '../../lib/datetime';
import { confirmToast } from '../../lib/toast';
import { MessageThread } from '../conversations/MessageThread';
import {
  getMyConversations,
  getMyLeadMessages,
  handBackChat,
  sendChatMessage,
  takeOverChat,
  type ConversationRow,
  type MessageRow,
} from '../../utils/agentMeApi';

const TEMP_STYLES: Record<string, string> = {
  hot: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
  warm: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  cold: 'bg-sky-500/20 text-sky-300 border-sky-500/40',
};

const shortTime = (iso: string | null) =>
  iso ? formatDateTime(iso, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

/** As the server allows: about ten SMS segments. */
const MAX_CHARS = 1600;

/**
 * The agent's text box, for a chat they have taken over. A draft keeps one id
 * until its text changes or it goes out, so pressing Send again after an error
 * can never text the lead twice: the server sends a given id once.
 */
const ChatComposer: React.FC<{ leadId: string; onSent: () => void }> = ({ leadId, onSent }) => {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const draftId = useRef(crypto.randomUUID());
  const fresh = () => {
    draftId.current = crypto.randomUUID();
  };

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const row = await sendChatMessage(leadId, draftId.current, body);
      fresh();
      if (row.deliveryStatus === 'failed') {
        toast.error('The text was not sent. Check the number and try again.');
      } else {
        setText('');
      }
      onSent();
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="p-4 border-t border-slate-800 flex items-end gap-2">
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          fresh();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
        maxLength={MAX_CHARS}
        rows={2}
        placeholder="Text the lead… (Enter to send, Shift+Enter for a new line)"
        className="flex-1 resize-none bg-slate-950 border border-slate-800 focus:border-emerald-500/60 rounded-xl px-3 py-2 text-xs text-slate-100 placeholder:text-slate-600 outline-none"
      />
      <button
        type="button"
        onClick={() => void send()}
        disabled={sending || !text.trim()}
        className="px-3 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
      >
        {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
        Send
      </button>
    </div>
  );
};

/**
 * The SMS threads of the agent's own leads: what the AI and the strategy sent
 * and what the lead answered, up to the booking that brought the lead to them.
 *
 * The agent may take a chat over: the AI stops answering that lead, every
 * automated call and text to them stops, and the agent texts them from here.
 * Handing it back lets the AI answer again; automated outreach stays off.
 *
 * Every request is `/agents/me/...`, so the server decides which leads are
 * theirs; a lead reassigned to someone else disappears from here on the next
 * refresh, and the takeover ends with it.
 */
export const AgentConversations: React.FC = () => {
  const { user } = useAuth();
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

  // A text in or out, a takeover, or a reassignment: refetch what it touches. Events
  // reach every screen in the organization, so another agent's lead is skipped.
  useLiveEvents(
    useCallback(
      (e) => {
        if (e.type === 'lead.assigned') return threadsQuery.invalidate();
        if (e.type !== 'conversation.updated' || (e.leadId && !threads.some((t) => t.leadId === e.leadId))) return;
        threadsQuery.invalidate();
        if (e.leadId === selectedId) messagesQuery.invalidate();
      },
      [threads, threadsQuery, messagesQuery, selectedId],
    ),
  );

  const current = threads.find((t) => t.id === selectedId) ?? null;
  const mine = Boolean(current?.takenOver && current.takenOver.byId === user?.id);

  const [switching, setSwitching] = useState(false);
  const toggleTakeover = async () => {
    if (!current || switching) return;
    if (
      !mine &&
      !(await confirmToast(
        'Take over this chat? The AI stops answering this lead and every automated call and text to them stops. If you hand it back later, the AI answers their texts again, but automated outreach stays off.',
        'Take over',
      ))
    ) {
      return;
    }
    setSwitching(true);
    try {
      await (mine ? handBackChat(current.leadId) : takeOverChat(current.leadId));
      toast.success(mine ? 'The AI is answering this lead again.' : 'You are now texting this lead. The AI and automated outreach are off.');
      threadsQuery.refresh();
      // Taking over may have texted the lead your organization's greeting.
      messagesQuery.refresh();
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setSwitching(false);
    }
  };

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
                    {t.takenOver && (
                      <span className="text-2xs uppercase font-bold px-1.5 rounded border bg-emerald-500/20 text-emerald-300 border-emerald-500/40 flex items-center gap-0.5">
                        <UserRound className="w-2.5 h-2.5" />
                        {t.takenOver.byId === user?.id ? 'you' : 'agent'}
                      </span>
                    )}
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
                <div className="p-5 border-b border-slate-800 flex items-start justify-between gap-4">
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
                    type="button"
                    onClick={() => void toggleTakeover()}
                    disabled={switching}
                    className={`shrink-0 px-3 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50 ${
                      mine
                        ? 'bg-slate-900 border border-slate-700 hover:border-slate-600 text-slate-200'
                        : 'bg-emerald-600 hover:bg-emerald-500 text-white'
                    }`}
                  >
                    {switching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : mine ? <Bot className="w-3.5 h-3.5" /> : <UserRound className="w-3.5 h-3.5" />}
                    {mine ? 'Hand back to AI' : 'Take over chat'}
                  </button>
                </div>
                <div
                  className={`mx-5 mt-4 flex items-start gap-2 text-xs rounded-lg px-3 py-2 border ${
                    mine ? 'text-emerald-300 bg-emerald-950/40 border-emerald-800/40' : 'text-slate-400 bg-slate-950/60 border-slate-800'
                  }`}
                >
                  {mine ? <UserRound className="w-3.5 h-3.5 shrink-0 mt-0.5" /> : <Bot className="w-3.5 h-3.5 shrink-0 mt-0.5" />}
                  <span>
                    {mine
                      ? 'You are texting this lead. The AI does not answer them, and no automated call or text goes out.'
                      : 'The AI answers this lead\'s texts. Take over to text them yourself.'}
                  </span>
                </div>
                {current.dncStatus && (
                  <div className="mx-5 mt-4 flex items-start gap-2 text-xs text-rose-300 bg-rose-950/40 border border-rose-800/40 rounded-lg px-3 py-2">
                    <Ban className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span>This lead asked us to stop texting. Do not text them unless they opt back in.</span>
                  </div>
                )}
                <MessageThread messages={messagesQuery.data} className="p-5 max-h-[560px] overflow-y-auto custom-scrollbar" />
                {mine && !current.dncStatus && (
                  <ChatComposer
                    key={current.leadId}
                    leadId={current.leadId}
                    onSent={() => {
                      messagesQuery.refresh();
                      threadsQuery.refresh();
                    }}
                  />
                )}
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
