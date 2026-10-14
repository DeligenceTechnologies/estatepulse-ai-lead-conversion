import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, CalendarClock, CalendarDays, ChevronRight, ShieldAlert, Users } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { ApiError, messageFor } from '../../lib/api';
import { getOrganizationCalendar, type CalendarProviderId, type OrganizationCalendarStatus } from '../../utils/calendarApi';
import { TeamAvailability } from '../calendar/availability/TeamAvailability';
import { MeetingTypes } from '../calendar/meeting-types/MeetingTypes';
import { CalendarMembers } from '../calendar/members/CalendarMembers';
import { PROVIDERS } from '../calendar/shared/ui';

export type CalendarSection = 'availability' | 'meetings' | 'members';

/** One sidebar entry each, under Calendar. The page carries the full title. */
const SECTIONS: Record<CalendarSection, { title: string; subtitle: string; icon: React.ElementType }> = {
  availability: { title: 'Team Availability', subtitle: 'See who’s free and who’s busy.', icon: CalendarClock },
  meetings: { title: 'Meeting Types', subtitle: 'Booking links, and who booked them.', icon: CalendarDays },
  members: { title: 'Calendar Members', subtitle: 'Add calendar members to your team.', icon: Users },
};

const Skeleton: React.FC = () => (
  <div className="space-y-4 animate-pulse" aria-busy>
    <div className="h-10 w-72 rounded-xl bg-slate-900 border border-slate-800" />
    <div className="h-64 rounded-2xl bg-slate-900 border border-slate-800" />
  </div>
);

const EmptyState: React.FC<{ icon: React.ReactNode; title: string; children: React.ReactNode; action?: React.ReactNode }> = ({
  icon,
  title,
  children,
  action,
}) => (
  <div className="flex flex-col items-center text-center bg-slate-900/80 border border-slate-800 rounded-2xl px-6 py-16">
    <div className="w-12 h-12 rounded-2xl bg-slate-950 border border-slate-800 flex items-center justify-center mb-4">{icon}</div>
    <h3 className="text-sm font-bold text-white">{title}</h3>
    <p className="text-xs text-slate-400 mt-1.5 max-w-md leading-relaxed">{children}</p>
    {action && <div className="mt-5">{action}</div>}
  </div>
);

/** Which calendar is connected: just its name. Opens Settings → Calendar for anyone who may change it. */
const ConnectedCalendar: React.FC<{ provider: CalendarProviderId; onOpen?: () => void }> = ({ provider, onOpen }) => {
  const { label, icon: Icon, tone } = PROVIDERS[provider];
  const shell = 'h-10 pl-1.5 pr-3.5 rounded-full bg-slate-900 border border-slate-800 inline-flex items-center gap-2 shrink-0 self-start md:self-auto';
  const content = (
    <>
      <span className={`w-7 h-7 rounded-full border flex items-center justify-center shrink-0 ${tone}`}>
        <Icon className="w-3.5 h-3.5" />
      </span>
      <span className="text-xs font-bold text-white">{label}</span>
    </>
  );

  return onOpen ? (
    <button
      type="button"
      onClick={onOpen}
      title="Calendar settings"
      aria-label={`${label}. Open calendar settings`}
      className={`${shell} group cursor-pointer hover:border-slate-700 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50`}
    >
      {content}
      <ChevronRight className="w-3.5 h-3.5 -mr-1 text-slate-500 group-hover:text-slate-300 transition-colors" />
    </button>
  ) : (
    <div className={shell}>{content}</div>
  );
};

const primaryButton =
  'h-9 px-4 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-on-accent text-xs font-semibold cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400';

/**
 * The Calendar pages — Team Availability, Meeting Types, Calendar Members —
 * each its own sidebar entry, all read from the Calendly or Cal.com account
 * connected once under Settings → Calendar.
 */
export const CalendarView: React.FC<{ section: CalendarSection }> = ({ section }) => {
  const navigate = useNavigate();
  const { can } = useAuth();
  const canConnect = can('organization.update');
  const [status, setStatus] = useState<OrganizationCalendarStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setStatus(await getOrganizationCalendar());
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setForbidden(true);
      setError(messageFor(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const provider = status?.provider ?? null;
  const connection = status?.connection ?? null;
  const connected = Boolean(provider && connection?.status === 'active');
  const page = SECTIONS[section];

  const openCalendarSettings = () => navigate('/settings?tab=calendar');

  let body: React.ReactNode;
  if (forbidden) {
    body = (
      <EmptyState icon={<ShieldAlert className="w-6 h-6 text-amber-400" />} title="No access">
        Your role can’t view this page. Ask your owner for access.
      </EmptyState>
    );
  } else if (error && !status) {
    body = (
      <EmptyState
        icon={<AlertTriangle className="w-6 h-6 text-rose-400" />}
        title="Couldn’t load your calendar"
        action={
          <button
            type="button"
            onClick={() => void load()}
            className="h-9 px-4 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-100 cursor-pointer transition-colors"
          >
            Try again
          </button>
        }
      >
        {error}
      </EmptyState>
    );
  } else if (!status) {
    body = <Skeleton />;
  } else if (!connected) {
    const broken = Boolean(connection);
    body = (
      <EmptyState
        icon={<CalendarClock className="w-6 h-6 text-emerald-400" />}
        title={broken ? 'Reconnect your calendar' : 'Connect a calendar'}
        action={
          canConnect ? (
            <button type="button" onClick={openCalendarSettings} className={primaryButton}>
              {broken ? 'Reconnect calendar' : 'Connect calendar'}
            </button>
          ) : undefined
        }
      >
        {broken
          ? connection?.lastError ?? 'The connection stopped working.'
          : 'Connect Calendly or Cal.com once to see your team’s schedule here.'}
        {!canConnect && ' Ask your owner to do it.'}
      </EmptyState>
    );
  } else {
    // Keyed by connection so switching calendars never shows the old provider's rows.
    const key = connection!.connectedAt;
    body =
      section === 'availability' ? (
        <TeamAvailability key={key} />
      ) : section === 'meetings' ? (
        <MeetingTypes key={key} provider={provider!} />
      ) : (
        <CalendarMembers key={key} provider={provider!} />
      );
  }

  return (
    <div className="h-full overflow-y-auto custom-scrollbar text-slate-100">
      <div className="px-4 sm:px-6 py-6 max-w-7xl w-full mx-auto space-y-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-md shadow-emerald-500/20 shrink-0">
              <page.icon className="w-5 h-5 text-on-accent" />
            </div>
            <div className="min-w-0">
              <h2 className="text-xl font-bold text-white tracking-tight">{page.title}</h2>
              <p className="text-xs text-slate-400">{page.subtitle}</p>
            </div>
          </div>

          {provider && connected && <ConnectedCalendar provider={provider} onOpen={canConnect ? openCalendarSettings : undefined} />}
        </div>

        {body}
      </div>
    </div>
  );
};
