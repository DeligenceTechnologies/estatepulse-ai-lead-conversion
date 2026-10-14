import React, { useMemo, useState } from 'react';
import { Search, Users } from 'lucide-react';
import { useAuth } from '../../../context/AuthContext';
import { messageFor } from '../../../lib/api';
import { addCalendarMemberAsAgent, listCalendarMembers, type CalendarMember, type CalendarProviderId } from '../../../utils/calendarApi';
import { PanelCard, RowSkeleton, useProviderData } from '../shared/CalendarPanel';
import { Empty, Notice, PROVIDERS, SearchField, type NoticeTone } from '../shared/ui';
import { MemberList } from './MemberList';

type Filter = 'all' | 'unlinked' | 'linked';

/** Not-added people first (they are the ones to act on), then by name. */
const byNextAction = (a: CalendarMember, b: CalendarMember) =>
  Number(Boolean(a.userId)) - Number(Boolean(b.userId)) || a.name.localeCompare(b.name);

const Coverage: React.FC<{ linked: number; total: number }> = ({ linked, total }) => {
  const percent = total ? Math.round((linked / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2.5 shrink-0" title={`${percent}% of calendar members are on your team`}>
      <div
        className="w-24 h-1.5 rounded-full bg-slate-800 overflow-hidden"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Calendar members on your team"
      >
        <div className="h-full rounded-full bg-emerald-500 transition-[width] duration-500" style={{ width: `${percent}%` }} />
      </div>
      <span className="text-2xs text-slate-400 tabular-nums whitespace-nowrap">
        <span className="font-semibold text-slate-200">{linked}</span>/{total} on team
      </span>
    </div>
  );
};

/** Everyone in the connected organization or team, and whether each one is an agent here yet. */
export const CalendarMembers: React.FC<{ provider: CalendarProviderId }> = ({ provider }) => {
  const label = PROVIDERS[provider].label;
  const { can } = useAuth();
  const canAdd = can('user.create');
  const { data, error, loading, reload } = useProviderData(listCalendarMembers);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [adding, setAdding] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: NoticeTone; text: string } | null>(null);

  const members = useMemo(() => [...(data ?? [])].sort(byNextAction), [data]);
  const linked = members.filter((m) => m.userId).length;
  const counts: Record<Filter, number> = { all: members.length, unlinked: members.length - linked, linked };

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return members.filter((m) => {
      if (filter === 'linked' && !m.userId) return false;
      if (filter === 'unlinked' && m.userId) return false;
      return !query || `${m.name} ${m.email} ${m.userName ?? ''}`.toLowerCase().includes(query);
    });
  }, [members, filter, search]);

  const add = async (member: CalendarMember) => {
    if (adding) return;
    setAdding(member.externalId);
    setNotice(null);
    try {
      const { user, credentialsEmail, workingHoursFrom } = await addCalendarMemberAsAgent(member.externalId);
      const hours =
        workingHoursFrom === 'organization'
          ? ' Working hours are your organization’s defaults.'
          : ` Working hours and timezone were copied from ${PROVIDERS[workingHoursFrom]?.label ?? label}.`;
      setNotice(
        !credentialsEmail || credentialsEmail.sent
          ? {
              tone: 'success',
              text: credentialsEmail
                ? `${user.name} is now an agent. Sign-in details were emailed to ${user.email}.${hours}`
                : `${user.name} is now an agent.${hours}`,
            }
          : {
              tone: 'warning',
              text: `${user.name} is now an agent, but the sign-in email was not sent${
                credentialsEmail.reason ? ` (${credentialsEmail.reason})` : ''
              }. Set a password for them from Team.`,
            },
      );
      await reload();
    } catch (e) {
      setNotice({ tone: 'error', text: messageFor(e) });
    } finally {
      setAdding(null);
    }
  };

  const toolbar = data && data.length > 0 && (
    <div className="flex flex-col lg:flex-row lg:items-center gap-2 lg:gap-3">
      <SearchField value={search} onChange={setSearch} placeholder="Search name or email" />
      <div role="radiogroup" aria-label="Show" className="inline-flex h-9 p-0.5 rounded-lg bg-slate-950 border border-slate-800 w-fit">
        {(
          [
            { id: 'all', label: 'All' },
            { id: 'unlinked', label: 'Not added' },
            { id: 'linked', label: 'On team' },
          ] as const
        ).map(({ id, label: text }) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={filter === id}
            onClick={() => setFilter(id)}
            className={`h-8 px-3 rounded-md text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 ${
              filter === id ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {text}
            <span className="text-2xs text-slate-500 tabular-nums">{counts[id]}</span>
          </button>
        ))}
      </div>
      <div className="lg:ml-auto">
        <Coverage linked={linked} total={members.length} />
      </div>
    </div>
  );

  return (
    <PanelCard
      icon={Users}
      title="Calendar members"
      hint={`Live from ${label}. Add someone to give them an agent login.`}
      count={data?.length}
      loading={loading}
      providerLabel={label}
      onRefresh={() => void reload()}
      toolbar={toolbar}
    >
      <div className="space-y-3">
        {notice && (
          <Notice tone={notice.tone} onDismiss={() => setNotice(null)}>
            {notice.text}
          </Notice>
        )}
        {error ? (
          <Notice tone="error">{error}</Notice>
        ) : data === null ? (
          <RowSkeleton />
        ) : data.length === 0 ? (
          <Empty icon={Users} title="No members yet">
            Invite your agents in {label}, then refresh.
          </Empty>
        ) : visible.length === 0 ? (
          search.trim() ? (
            <Empty icon={Search} title="No matches">
              Nobody matches “{search.trim()}”.
            </Empty>
          ) : filter === 'unlinked' ? (
            <Empty icon={Users} title="Everyone is on your team">
              All {members.length} calendar members can sign in to EstatePulse.
            </Empty>
          ) : (
            <Empty icon={Users} title="Nobody on your team yet">
              Use “Add to team” to give a calendar member an agent login.
            </Empty>
          )
        ) : (
          <MemberList items={visible} canAdd={canAdd} adding={adding} onAdd={(member) => void add(member)} />
        )}
      </div>
    </PanelCard>
  );
};
