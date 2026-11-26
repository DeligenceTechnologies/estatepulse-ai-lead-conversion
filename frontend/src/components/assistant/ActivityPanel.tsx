import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CircleAlert, Clock, Loader2, ShieldCheck } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { formatDateTime } from '../../lib/datetime';
import { useLiveEvents } from '../../lib/liveEvents';
import { getActivity, type ActivityFeed, type ActivityItem } from '../../utils/activityApi';
import { minutesLeft } from './ApprovalCard';
import { whenShort } from './starterPrompts';

const REFRESH_MS = 60_000;
/** Live events come in bursts (a call ends: status, memory, score); one fetch after the burst. */
const BATCH_MS = 2_000;

const TONE: Record<ActivityItem['tone'], string> = {
  good: 'bg-emerald-400',
  bad: 'bg-rose-400',
  neutral: 'bg-slate-500',
};

interface Props {
  /** Opens a chat (for a card waiting on the user). */
  onOpenChat: (threadId: string) => void;
  /** Changes when the chat's state does, so a decided card leaves "Needs you" at once. */
  refreshKey?: unknown;
}

/**
 * The home page's Activity panel: cards waiting on this user ("Needs you") and broken apps first,
 * then what happened in the office in the last 24 hours. Lead names open the lead. It refreshes
 * when the app's live events say something changed (batched), every minute, and on focus.
 */
export const ActivityPanel: React.FC<Props> = ({ onOpenChat, refreshKey }) => {
  const [feed, setFeed] = useState<ActivityFeed | null>(null);
  const [error, setError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    void getActivity()
      .then((f) => {
        setFeed(f);
        setError(false);
      })
      .catch(() => setError(true));
  }, []);

  useEffect(() => {
    load();
    const every = window.setInterval(load, REFRESH_MS);
    window.addEventListener('focus', load);
    return () => {
      window.clearInterval(every);
      window.removeEventListener('focus', load);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  useEffect(() => {
    load();
  }, [refreshKey, load]);

  useLiveEvents(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(load, BATCH_MS);
  });

  const more = async (): Promise<void> => {
    if (!feed?.nextCursor) return;
    setLoadingMore(true);
    try {
      const next = await getActivity(feed.nextCursor);
      setFeed({ ...feed, items: [...feed.items, ...next.items], nextCursor: next.nextCursor });
    } finally {
      setLoadingMore(false);
    }
  };

  if (!feed) {
    return (
      <div className="p-4 text-center text-xs text-slate-500">
        {error ? 'Activity could not be loaded.' : <Loader2 className="w-4 h-4 animate-spin mx-auto" aria-label="Loading" />}
      </div>
    );
  }
  return <ActivityView feed={feed} onOpenChat={onOpenChat} onMore={feed.nextCursor ? () => void more() : undefined} loadingMore={loadingMore} />;
};

/** The panel from a feed already loaded. */
export const ActivityView: React.FC<{ feed: ActivityFeed; onOpenChat: (threadId: string) => void; onMore?: () => void; loadingMore?: boolean }> = ({
  feed,
  onOpenChat,
  onMore,
  loadingMore,
}) => {
  const { setSelectedLeadId } = useApp();
  const navigate = useNavigate();

  return (
    <div className="p-3 space-y-4">
      {feed.needsYou.length > 0 && (
        <section aria-label="Needs you">
          <p className="px-1 mb-1.5 text-2xs font-bold uppercase tracking-wider text-emerald-400">Needs you</p>
          <ul className="space-y-1.5">
            {feed.needsYou.map((n) => {
              const left = minutesLeft(n.expiresAt);
              return (
                <li key={n.actionId}>
                  <button
                    type="button"
                    onClick={() => onOpenChat(n.threadId)}
                    className="cursor-pointer w-full flex items-start gap-2.5 rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-left hover:border-emerald-500/60"
                  >
                    <ShieldCheck className="w-4 h-4 shrink-0 mt-0.5 text-emerald-400" aria-hidden />
                    <span className="min-w-0">
                      <span className="block text-xs font-semibold text-slate-100 truncate">{n.title}</span>
                      <span className="block text-2xs text-slate-400">
                        Waiting for your approval{left !== null ? ` · ${left} min left` : ''}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {feed.alerts.length > 0 && (
        <section aria-label="Apps that need attention">
          <ul className="space-y-1.5">
            {feed.alerts.map((a) => (
              <li key={a.app} className="flex items-start gap-2.5 rounded-xl border border-rose-500/30 bg-rose-500/5 px-3 py-2">
                <CircleAlert className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" aria-hidden />
                <span className="flex-1 min-w-0">
                  <span className="block text-xs font-semibold text-slate-100">{a.state === 'needs_reconnect' ? `${a.app} is disconnected` : `${a.app} is not syncing`}</span>
                  {a.message && <span className="block text-2xs text-slate-400 leading-relaxed">{a.message}</span>}
                  {feed.canReconnect && (
                    <button type="button" onClick={() => navigate(a.reconnectPath)} className="mt-1 cursor-pointer text-2xs font-bold text-emerald-300 hover:text-emerald-200">
                      Reconnect
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="Last 24 hours">
        <p className="px-1 mb-1.5 text-2xs font-bold uppercase tracking-wider text-slate-500">Last 24 hours</p>
        {feed.items.length === 0 ? (
          <p className="px-1 py-3 text-xs text-slate-500">Nothing new in the last 24 hours.</p>
        ) : (
          <ul className="space-y-0.5">
            {feed.items.map((i) => (
              <li key={i.id} className="flex items-start gap-2.5 rounded-lg px-1.5 py-1.5">
                <span aria-hidden className={`shrink-0 mt-1.5 w-1.5 h-1.5 rounded-full ${TONE[i.tone]}`} />
                <span className="flex-1 min-w-0 text-xs leading-relaxed text-slate-300">
                  {i.lead && (
                    <button type="button" onClick={() => setSelectedLeadId(i.lead!.id)} className="cursor-pointer font-semibold text-slate-100 hover:text-emerald-300">
                      {i.lead.name}
                    </button>
                  )}
                  {i.lead ? ' ' : ''}
                  {i.text}
                  {i.meetingAt && (
                    <span className="block text-2xs text-slate-500">
                      <Clock className="inline w-3 h-3 mr-1 -mt-0.5" aria-hidden />
                      {formatDateTime(i.meetingAt, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-2xs text-slate-500">{whenShort(i.at)}</span>
              </li>
            ))}
          </ul>
        )}
        {onMore && (
          <button type="button" onClick={onMore} disabled={loadingMore} className="mt-2 w-full cursor-pointer text-center text-2xs font-semibold text-emerald-400 hover:underline disabled:opacity-50">
            {loadingMore ? 'Loading…' : 'Show more'}
          </button>
        )}
      </section>
    </div>
  );
};
