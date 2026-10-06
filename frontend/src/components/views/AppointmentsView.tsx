import React, { useCallback, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Calendar as CalendarIcon,
  CalendarClock,
  Clock,
  ExternalLink,
  Loader2,
  RefreshCw,
  UserCheck,
  Video,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { useLiveQuery } from '../../lib/useLiveQuery';
import { listAppointments, type Appointment } from '../../utils/calendarApi';

type Tab = 'upcoming' | 'past' | 'cancelled' | 'all';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'past', label: 'Past' },
  { id: 'cancelled', label: 'Cancelled' },
  { id: 'all', label: 'All' },
];

function statusTone(status: string): string {
  switch (status) {
    case 'scheduled':
      return 'bg-purple-500/20 text-purple-300 border-purple-500/40';
    case 'rescheduled':
      return 'bg-amber-500/20 text-amber-300 border-amber-500/40';
    case 'cancelled':
      return 'bg-rose-500/20 text-rose-300 border-rose-500/40';
    case 'completed':
      return 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40';
    default:
      return 'bg-slate-800 text-slate-400 border-slate-700';
  }
}

/**
 * Every appointment in the office.
 *
 * Rows come from the `appointments` table, which the calendar sync fills from
 * the office's ONE connected scheduling account (Calendly or Cal.com) — every
 * member's bookings on a single connection. Two consequences are worth stating in the UI rather than leaving
 * people to discover:
 *
 *  - Only bookings whose invitee matches an existing lead are stored, so this
 *    is not a mirror of anyone's full calendar.
 *  - A booking hosted by a Calendly member who is not linked to an agent here
 *    contributes nothing, which looks identical to having no bookings unless we
 *    say so.
 */
export const AppointmentsView: React.FC = () => {
  const { setSelectedLeadId, setActiveView } = useApp();
  // Set when the owner also takes leads: their own bookings get a "Mine" entry.
  const { agentProfileId } = useAuth();
  const [tab, setTab] = useState<Tab>('upcoming');
  const [agentId, setAgentId] = useState<string>('all');

  const load = useCallback(() => listAppointments(), []);
  const { data, error, refreshing, stale, refresh } = useLiveQuery<Appointment[]>(load, {
    baseIntervalMs: 15_000,
  });

  const rows = data ?? [];

  // Agent options come from the rows themselves rather than a second request:
  // an agent with no appointments has nothing to filter to anyway. The
  // reader's own bookings, when they take leads, are listed first as "Mine".
  const agents = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows) seen.set(r.agentId, r.agentId === agentProfileId ? 'Mine' : r.agentName);
    return [...seen.entries()].sort(
      (a, b) => Number(b[0] === agentProfileId) - Number(a[0] === agentProfileId) || a[1].localeCompare(b[1]),
    );
  }, [rows, agentProfileId]);

  const filtered = useMemo(() => {
    const now = Date.now();
    return rows.filter((r) => {
      if (agentId !== 'all' && r.agentId !== agentId) return false;
      const starts = Date.parse(r.startTime);
      switch (tab) {
        case 'upcoming':
          return starts >= now && r.status !== 'cancelled';
        case 'past':
          return starts < now && r.status !== 'cancelled';
        case 'cancelled':
          return r.status === 'cancelled';
        default:
          return true;
      }
    });
  }, [rows, tab, agentId]);

  const countFor = (t: Tab) => {
    const now = Date.now();
    return rows.filter((r) => {
      const starts = Date.parse(r.startTime);
      if (t === 'upcoming') return starts >= now && r.status !== 'cancelled';
      if (t === 'past') return starts < now && r.status !== 'cancelled';
      if (t === 'cancelled') return r.status === 'cancelled';
      return true;
    }).length;
  };

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto text-slate-100">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-bold text-white tracking-tight">Scheduled Appointments</h2>
            <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded bg-emerald-950/80 text-emerald-400 border border-emerald-800/40">
              Live
            </span>
          </div>
          <p className="text-xs text-slate-400">
            Synced from the office calendar, linked to the lead who booked.
          </p>
        </div>

        <button
          onClick={refresh}
          disabled={refreshing}
          className="text-xs text-slate-300 bg-slate-900 border border-slate-800 hover:border-slate-700 px-3 py-1.5 rounded-xl flex items-center gap-2 transition-colors cursor-pointer disabled:opacity-50 h-fit"
        >
          {refreshing ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RefreshCw className="w-3.5 h-3.5" />
          )}
          Refresh
        </button>
      </div>

      {error && (
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 flex items-start gap-2 text-xs text-rose-200">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}
      {stale && !error && (
        <p className="text-xs text-amber-300/90">
          Showing the last good result — the most recent refresh did not come back.
        </p>
      )}

      {/* Filters */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-3 flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                tab === t.id
                  ? 'bg-purple-600/20 text-purple-300 border border-purple-500/40'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 border border-transparent'
              }`}
            >
              {t.label}
              <span className="ml-1.5 text-slate-500">{countFor(t.id)}</span>
            </button>
          ))}
        </div>

        {agents.length > 1 && (
          <select
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            className="bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-purple-500/60 cursor-pointer ml-auto"
          >
            <option value="all">All agents</option>
            {agents.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Body */}
      {data === null && !error ? (
        <Loader2 className="w-5 h-5 animate-spin text-slate-500" />
      ) : rows.length === 0 ? (
        <EmptyState onGoToAgents={() => setActiveView('agents')} />
      ) : filtered.length === 0 ? (
        <p className="text-xs text-slate-500 py-8 text-center">
          Nothing matches this filter.
        </p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((appt) => {
            const cancelled = appt.status === 'cancelled';
            return (
              <div
                key={appt.id}
                className={`bg-slate-900/90 border border-slate-800 hover:border-purple-500/40 rounded-2xl p-5 space-y-4 shadow-xl transition-all flex flex-col justify-between ${
                  cancelled ? 'opacity-70' : ''
                }`}
              >
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`text-[10px] uppercase font-bold tracking-wider px-2.5 py-0.5 rounded-full border ${statusTone(appt.status)}`}
                    >
                      {appt.status}
                    </span>
                    {appt.appointmentType && (
                      <span className="text-[11px] text-slate-400 truncate max-w-[55%]">
                        {appt.appointmentType}
                      </span>
                    )}
                  </div>

                  <div>
                    <h3 className="text-base font-bold text-white truncate">{appt.leadName}</h3>
                    <p className="text-xs text-slate-400 flex items-center gap-1.5 mt-0.5">
                      <UserCheck className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                      <span className="truncate">
                        Agent: <strong className="text-slate-200">{appt.agentName}</strong>
                      </span>
                    </p>
                  </div>

                  <div className="bg-slate-950 border border-slate-800/80 p-3 rounded-xl space-y-1.5 text-xs">
                    <div className="flex items-center gap-2 text-slate-300">
                      <CalendarIcon className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                      <span>
                        {new Date(appt.startTime).toLocaleDateString([], {
                          weekday: 'short',
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-slate-300">
                      <Clock className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                      {/* Struck through rather than hidden: a cancellation is
                          information the office needs to see. */}
                      <span className={cancelled ? 'line-through text-slate-500' : ''}>
                        {new Date(appt.startTime).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}{' '}
                        –{' '}
                        {new Date(appt.endTime).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                  </div>

                  {cancelled && appt.canceledReason && (
                    <p className="text-[11px] text-slate-400 italic bg-slate-950/40 p-2 rounded-lg border border-slate-800/50">
                      "{appt.canceledReason}"
                    </p>
                  )}
                </div>

                <div className="pt-3 border-t border-slate-800 flex items-center justify-between gap-2">
                  <button
                    onClick={() => setSelectedLeadId(appt.leadId)}
                    className="text-xs text-slate-400 hover:text-white transition-colors cursor-pointer"
                  >
                    View Lead Profile →
                  </button>

                  {!cancelled && appt.meetingUrl && (
                    <a
                      href={appt.meetingUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
                    >
                      <Video className="w-3.5 h-3.5" />
                      <span>Join Link</span>
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

/**
 * Nothing at all. The likeliest cause is that no agent has connected a
 * calendar, which only they can do — so this points at the roster rather than
 * offering a button that would not work.
 */
const EmptyState: React.FC<{ onGoToAgents: () => void }> = ({ onGoToAgents }) => (
  <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-10 text-center space-y-4">
    <CalendarClock className="w-7 h-7 text-slate-600 mx-auto" />
    <div className="text-xs text-slate-400 leading-relaxed max-w-md mx-auto space-y-2">
      <p className="text-slate-300 font-semibold">No appointments yet.</p>
      <p>
        Appointments appear here once the office calendar is connected on Integrations, your
        agents are invited onto it, and someone books with them.
      </p>
      <p className="text-slate-500">
        Bookings are linked to a lead by the invitee's email or phone. A booking that matches no
        lead is not recorded.
      </p>
    </div>
    <button
      onClick={onGoToAgents}
      className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold inline-flex items-center gap-1.5 transition-colors cursor-pointer"
    >
      <ExternalLink className="w-3.5 h-3.5" />
      See which agents have connected
    </button>
  </div>
);
