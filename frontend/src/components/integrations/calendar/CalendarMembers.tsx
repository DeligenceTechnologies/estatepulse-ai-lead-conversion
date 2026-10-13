import React, { useState } from 'react';
import { ExternalLink, Loader2, UserPlus } from 'lucide-react';
import { useAuth } from '../../../context/AuthContext';
import { messageFor } from '../../../lib/api';
import { addCalendarMemberAsAgent, type CalendarMember } from '../../../utils/calendarApi';
import { Notice, ROLE_LABEL, panel, type NoticeTone } from './ui';

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase() || '?';

export const CalendarMembers: React.FC<{
  items: CalendarMember[];
  providerLabel: string;
  onUserCreated: () => Promise<void>;
}> = ({ items, providerLabel, onUserCreated }) => {
  const { can } = useAuth();
  const canAdd = can('user.create');
  const [adding, setAdding] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: NoticeTone; text: string } | null>(null);

  const unlinked = items.filter((member) => !member.userId).length;

  const add = async (member: CalendarMember) => {
    if (adding) return;
    setAdding(member.externalId);
    setNotice(null);
    try {
      const { user, credentialsEmail } = await addCalendarMemberAsAgent(member.externalId);
      setNotice(
        credentialsEmail.sent
          ? { tone: 'success', text: `${user.name} is now an agent. Sign-in details were emailed to ${user.email}.` }
          : {
              tone: 'warning',
              text: `${user.name} is now an agent, but the sign-in email was not sent${
                credentialsEmail.reason ? ` (${credentialsEmail.reason})` : ''
              }. Set a password for them from Team.`,
            },
      );
      await onUserCreated();
    } catch (e) {
      setNotice({ tone: 'error', text: messageFor(e) });
    } finally {
      setAdding(null);
    }
  };

  return (
    <div className="space-y-2">
      {notice && (
        <Notice tone={notice.tone} onDismiss={() => setNotice(null)}>
          {notice.text}
        </Notice>
      )}

      <ul className="space-y-1.5 list-none">
        {items.map((member) => (
          <li key={member.externalId} className={`${panel} px-3 py-2.5 flex items-center gap-3`}>
            <span className="w-8 h-8 rounded-full bg-slate-800 text-slate-300 text-2xs font-bold flex items-center justify-center shrink-0">
              {initials(member.name)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 min-w-0">
                <span className="text-xs font-semibold text-white truncate">{member.name}</span>
                <span className="text-2xs font-semibold text-slate-500 uppercase shrink-0">{ROLE_LABEL[member.role]}</span>
              </span>
              <span className="block text-2xs text-slate-500 truncate">{member.email}</span>
            </span>

            {member.userId ? (
              <span
                title={`Matched to ${member.userName} by email`}
                className="hidden sm:inline text-2xs font-semibold px-2 py-0.5 rounded-full border bg-emerald-500/10 text-emerald-300 border-emerald-500/30 shrink-0 max-w-[10rem] truncate"
              >
                {member.userName}
              </span>
            ) : canAdd && member.email ? (
              <button
                type="button"
                onClick={() => void add(member)}
                disabled={adding !== null}
                aria-busy={adding === member.externalId || undefined}
                title={`Create an EstatePulse agent for ${member.email}`}
                className="h-7 px-2.5 rounded-lg text-2xs font-semibold text-emerald-200 bg-emerald-500/10 border border-emerald-500/30 hover:bg-emerald-500/20 inline-flex items-center gap-1.5 shrink-0 cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {adding === member.externalId ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <UserPlus className="w-3 h-3" />
                )}
                {adding === member.externalId ? 'Adding…' : 'Add as agent'}
              </button>
            ) : (
              <span className="hidden sm:inline text-2xs font-semibold px-2 py-0.5 rounded-full border bg-slate-800 text-slate-400 border-slate-700 shrink-0">
                Not on EstatePulse
              </span>
            )}

            {member.schedulingUrl && (
              <a
                href={member.schedulingUrl}
                target="_blank"
                rel="noreferrer"
                title="Open booking page"
                aria-label={`Open ${member.name} booking page`}
                className="p-1.5 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-slate-800 transition-colors shrink-0"
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
          </li>
        ))}
      </ul>

      {unlinked > 0 && (
        <p className="text-2xs text-slate-500">
          {unlinked} {providerLabel} member{unlinked === 1 ? ' is' : 's are'} not on EstatePulse yet.
          {canAdd && ' “Add as agent” creates their account with the name, email and timezone from the calendar.'}
        </p>
      )}
    </div>
  );
};
