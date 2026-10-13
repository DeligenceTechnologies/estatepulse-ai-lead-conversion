import React, { useCallback, useEffect, useState } from 'react';
import { CalendarDays, Check, Copy, ExternalLink, RefreshCw, Users } from 'lucide-react';
import { messageFor } from '../../../lib/api';
import {
  listCalendarEventTypes,
  listCalendarMembers,
  type CalendarEventType,
  type CalendarMember,
  type CalendarProviderId,
} from '../../../utils/calendarApi';
import { CalendarMembers } from './CalendarMembers';
import { Notice, POOLING_LABEL, PROVIDERS, panel } from './ui';

type Tab = 'members' | 'meeting-types';

type Resource<T> = { data: T[] | null; error: string | null };

const EMPTY: Resource<never> = { data: null, error: null };

const settle = async <T,>(request: Promise<T[]>): Promise<Resource<T>> => {
  try {
    return { data: await request, error: null };
  } catch (e) {
    return { data: null, error: messageFor(e) };
  }
};

const SkeletonRows: React.FC = () => (
  <ul className="space-y-1.5 list-none animate-pulse" aria-hidden>
    {[0, 1, 2].map((row) => (
      <li key={row} className={`${panel} h-12`} />
    ))}
  </ul>
);

const Empty: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className={`${panel} px-4 py-6 text-center text-xs text-slate-400`}>{children}</div>
);

const CopyLink: React.FC<{ url: string; label: string }> = ({ url, label }) => {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(url).then(() => setCopied(true), () => undefined);
      }}
      title={copied ? 'Copied' : 'Copy booking link'}
      aria-label={`Copy ${label} booking link`}
      className="p-1.5 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-slate-800 transition-colors shrink-0 cursor-pointer"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
};

const OpenLink: React.FC<{ url: string; label: string }> = ({ url, label }) => (
  <a
    href={url}
    target="_blank"
    rel="noreferrer"
    title="Open booking page"
    aria-label={`Open ${label} booking page`}
    className="p-1.5 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-slate-800 transition-colors shrink-0"
  >
    <ExternalLink className="w-3.5 h-3.5" />
  </a>
);

const EventTypeList: React.FC<{ items: CalendarEventType[] }> = ({ items }) => (
  <ul className="space-y-1.5 list-none">
    {items.map((eventType) => (
      <li key={eventType.id} className={`${panel} px-3 py-2.5 flex items-center gap-3`}>
        <span className="w-8 h-8 rounded-lg bg-slate-800 text-slate-300 text-2xs font-bold flex items-center justify-center shrink-0 tabular-nums">
          {eventType.durationMinutes}m
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-semibold text-white truncate">{eventType.name}</span>
          <span className="block text-2xs text-slate-500 truncate">
            {eventType.durationMinutes} minutes{eventType.hostName ? ` · ${eventType.hostName}` : ''}
          </span>
        </span>
        {eventType.poolingType && (
          <span className="hidden sm:inline text-2xs font-semibold px-2 py-0.5 rounded-full border bg-sky-500/10 text-sky-300 border-sky-500/30 shrink-0">
            {POOLING_LABEL[eventType.poolingType]}
          </span>
        )}
        {eventType.bookingUrl && (
          <span className="flex items-center shrink-0">
            <CopyLink url={eventType.bookingUrl} label={eventType.name} />
            <OpenLink url={eventType.bookingUrl} label={eventType.name} />
          </span>
        )}
      </li>
    ))}
  </ul>
);

export const CalendarDetails: React.FC<{ provider: CalendarProviderId; personal: boolean }> = ({ provider, personal }) => {
  const label = PROVIDERS[provider].label;
  const [tab, setTab] = useState<Tab>('members');
  const [eventTypes, setEventTypes] = useState<Resource<CalendarEventType>>(EMPTY);
  const [members, setMembers] = useState<Resource<CalendarMember>>(EMPTY);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [nextEventTypes, nextMembers] = await Promise.all([
      settle(listCalendarEventTypes()),
      personal ? Promise.resolve(EMPTY) : settle(listCalendarMembers()),
    ]);
    setEventTypes(nextEventTypes);
    setMembers(nextMembers);
    setLoading(false);
  }, [personal]);

  useEffect(() => {
    void load();
  }, [load]);

  const reloadMembers = useCallback(async () => {
    setMembers(await settle(listCalendarMembers()));
  }, []);

  const tabs: { id: Tab; label: string; icon: React.ElementType; count: number | undefined }[] = [
    ...(personal ? [] : [{ id: 'members' as const, label: 'Members', icon: Users, count: members.data?.length }]),
    { id: 'meeting-types', label: 'Meetings', icon: CalendarDays, count: eventTypes.data?.length },
  ];
  const active: Tab = personal ? 'meeting-types' : tab;
  const current = active === 'meeting-types' ? eventTypes : members;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div role="tablist" aria-label="Calendar details" className="inline-flex p-0.5 rounded-lg bg-slate-950/60 border border-slate-800">
          {tabs.map(({ id, label: tabLabel, icon: Icon, count }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={active === id}
              onClick={() => setTab(id)}
              className={`h-7 px-3 rounded-md text-2xs font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-colors ${
                active === id ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {tabLabel}
              {count !== undefined && <span className="text-slate-500 tabular-nums">{count}</span>}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          aria-label="Refresh from provider"
          title={`Refresh from ${label}`}
          className="h-7 w-7 rounded-lg text-slate-400 border border-slate-800 hover:border-slate-700 hover:text-white inline-flex items-center justify-center cursor-pointer transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div role="tabpanel">
        {current.error ? (
          <Notice tone="error">{current.error}</Notice>
        ) : current.data === null ? (
          <SkeletonRows />
        ) : active === 'meeting-types' ? (
          eventTypes.data && eventTypes.data.length > 0 ? (
            <EventTypeList items={eventTypes.data} />
          ) : (
            <Empty>No meetings yet. Create one in {label} and refresh.</Empty>
          )
        ) : members.data && members.data.length > 0 ? (
          <CalendarMembers items={members.data} providerLabel={label} onUserCreated={reloadMembers} />
        ) : (
          <Empty>No members yet. Invite your agents in {label} and refresh.</Empty>
        )}
      </div>
    </div>
  );
};
