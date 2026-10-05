import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CalendarClock, Clock, Loader2, Video } from 'lucide-react';
import { ApiError, messageFor } from '../../lib/api';
import { getMyAppointments, type Appointment } from '../../utils/calendarApi';

/** Tone per appointment status, using the same palette as the rest of the shell. */
function statusTone(status: string): string {
  switch (status) {
    case 'scheduled':
      return 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40';
    case 'rescheduled':
      return 'bg-amber-500/20 text-amber-300 border-amber-500/40';
    case 'cancelled':
      return 'bg-rose-500/20 text-rose-300 border-rose-500/40';
    case 'completed':
      return 'bg-sky-500/20 text-sky-300 border-sky-500/40';
    default:
      return 'bg-slate-800 text-slate-400 border-slate-700';
  }
}

/**
 * The agent's own appointments.
 *
 * Replaces the placeholder this screen used to be. It is a real list from a
 * real table now, so when it is empty that is a fact about the calendar rather
 * than a fact about the feature — and the empty state says which.
 */
export const AgentAppointments: React.FC = () => {
  const [rows, setRows] = useState<Appointment[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await getMyAppointments());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? messageFor(e) : String(e));
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const now = Date.now();
  const upcoming = (rows ?? []).filter(
    (a) => Date.parse(a.startTime) >= now && a.status !== 'cancelled',
  );
  const past = (rows ?? []).filter(
    (a) => Date.parse(a.startTime) < now || a.status === 'cancelled',
  );

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto text-slate-100">
      <div>
        <h2 className="text-xl font-bold text-white tracking-tight">My Appointments</h2>
        <p className="text-xs text-slate-400">Consultations booked with you.</p>
      </div>

      {error && (
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 flex items-start gap-2 text-xs text-rose-200">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {rows === null ? (
        <Loader2 className="w-5 h-5 animate-spin text-slate-500" />
      ) : rows.length === 0 ? (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-8 text-center space-y-3">
          <CalendarClock className="w-6 h-6 text-slate-600 mx-auto" />
          <div className="text-xs text-slate-400 leading-relaxed max-w-md mx-auto">
            No appointments yet.
            <span className="block text-slate-500 mt-1">
              Bookings on the office calendar appear here once you are on it and their invitee
              matches one of your office's leads. Availability shows whether you are linked.
            </span>
          </div>
        </div>
      ) : (
        <>
          <Section title="Upcoming" rows={upcoming} emptyNote="Nothing scheduled ahead." />
          {past.length > 0 && <Section title="Past &amp; cancelled" rows={past} dim />}
        </>
      )}
    </div>
  );
};

const Section: React.FC<{
  title: string;
  rows: Appointment[];
  dim?: boolean;
  emptyNote?: string;
}> = ({ title, rows, dim, emptyNote }) => (
  <section className="space-y-3">
    <h3 className="text-xs uppercase tracking-wider font-semibold text-slate-400">{title}</h3>

    {rows.length === 0 ? (
      <p className="text-xs text-slate-500">{emptyNote}</p>
    ) : (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {rows.map((a) => {
          const cancelled = a.status === 'cancelled';
          return (
            <div
              key={a.id}
              className={`bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-3 shadow-xl ${
                dim ? 'opacity-70' : ''
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className={`text-2xs uppercase font-bold tracking-wider px-2 py-0.5 rounded-full border ${statusTone(a.status)}`}
                >
                  {a.status}
                </span>
                {a.appointmentType && (
                  <span className="text-xs text-slate-400 truncate">{a.appointmentType}</span>
                )}
              </div>

              <div>
                <h4 className="text-base font-bold text-white truncate">{a.leadName}</h4>
                {a.leadEmail && (
                  <p className="text-xs text-slate-500 truncate">{a.leadEmail}</p>
                )}
              </div>

              <div className="bg-slate-950 border border-slate-800/80 p-3 rounded-xl space-y-1.5 text-xs">
                <div className="flex items-center gap-2 text-slate-300">
                  <CalendarClock className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>
                    {new Date(a.startTime).toLocaleDateString([], {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-slate-300">
                  <Clock className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  {/* A cancelled slot is information, not noise: it is struck
                      through rather than hidden. */}
                  <span className={cancelled ? 'line-through text-slate-500' : ''}>
                    {new Date(a.startTime).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}{' '}
                    –{' '}
                    {new Date(a.endTime).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
              </div>

              {cancelled && a.canceledReason && (
                <p className="text-xs text-slate-400 italic">"{a.canceledReason}"</p>
              )}

              {!cancelled && a.meetingUrl && (
                <a
                  href={a.meetingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-on-accent text-xs font-semibold inline-flex items-center gap-1.5 transition-colors cursor-pointer"
                >
                  <Video className="w-3.5 h-3.5" />
                  Join
                </a>
              )}
            </div>
          );
        })}
      </div>
    )}
  </section>
);
