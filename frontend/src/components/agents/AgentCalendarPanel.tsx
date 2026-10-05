import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CalendarClock, Loader2, X } from 'lucide-react';
import { ApiError, messageFor } from '../../lib/api';
import { DAY_SHORT, getAgentCalendar, type AgentCalendar } from '../../utils/calendarApi';

interface Props {
  /** users.id of the member whose calendar to show. */
  userId: string;
  memberName: string;
  onClose: () => void;
}

/**
 * The owner's read-only view of one agent's calendar.
 *
 * Read-only on purpose. Scheduling belongs to the ORGANIZATION — one account,
 * Calendly or Cal.com, connected once on Integrations — so there is nothing
 * per-agent to connect here. What is per-agent is whether they are on that
 * team, which is what decides whether their bookings can be attributed to them
 * at all.
 */
export const AgentCalendarPanel: React.FC<Props> = ({ userId, memberName, onClose }) => {
  const [data, setData] = useState<AgentCalendar | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await getAgentCalendar(userId));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? messageFor(e) : String(e));
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Escape closes, and the page behind must not scroll while this is open —
  // the same convention the integration panels use.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-start justify-center p-6 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-2xl shadow-2xl my-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-5 border-b border-slate-800">
          <div>
            <h3 className="text-sm font-bold text-white">{memberName}</h3>
            <p className="text-xs text-slate-400">Calendar and working hours</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {error && (
            <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 flex items-start gap-2 text-xs text-rose-200">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {!data && !error ? (
            <Loader2 className="w-5 h-5 animate-spin text-slate-500" />
          ) : data ? (
            <>
              {/* Connection */}
              <section className="space-y-2">
                <h4 className="text-xs uppercase tracking-wider font-semibold text-slate-400">
                  Calendar
                </h4>
                {data.schedulingUserId ? (
                  <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-3 space-y-1.5 text-xs">
                    <Row label="Scheduling" value="On the office account" />
                    {data.schedulingUrl && <Row label="Booking page" value={data.schedulingUrl} />}
                  </div>
                ) : (
                  <p className="text-xs text-slate-400 bg-slate-950/60 border border-slate-800/80 rounded-xl p-3 leading-relaxed">
                    This agent is not on the office’s scheduling team, so bookings cannot be
                    attributed to them. Invite them in Calendly or Cal.com using their email, then
                    press <span className="text-slate-200">Match to agents</span> on Integrations.
                  </p>
                )}
              </section>

              {/* Working hours */}
              <section className="space-y-2">
                <h4 className="text-xs uppercase tracking-wider font-semibold text-slate-400">
                  Working hours{' '}
                  <span className="text-slate-500 normal-case font-normal">
                    ({data.availability.timezone})
                  </span>
                </h4>
                <div className="grid grid-cols-7 gap-1.5">
                  {data.availability.days.map((d) => (
                    <div
                      key={d.dayOfWeek}
                      className={`rounded-lg border p-2 text-center ${
                        d.isAvailable
                          ? 'bg-emerald-500/10 border-emerald-500/30'
                          : 'bg-slate-950 border-slate-800/80'
                      }`}
                    >
                      <div className="text-2xs uppercase font-semibold text-slate-400">
                        {DAY_SHORT[d.dayOfWeek]}
                      </div>
                      {d.isAvailable ? (
                        <div className="text-2xs font-mono text-emerald-300 mt-1 leading-tight">
                          {d.startTime}
                          <br />
                          {d.endTime}
                        </div>
                      ) : (
                        <div className="text-2xs text-slate-600 mt-1">Off</div>
                      )}
                    </div>
                  ))}
                </div>
              </section>

              {/* Upcoming */}
              <section className="space-y-2">
                <h4 className="text-xs uppercase tracking-wider font-semibold text-slate-400">
                  Upcoming appointments
                </h4>
                {data.upcoming.length === 0 ? (
                  <p className="text-xs text-slate-500 bg-slate-950/60 border border-slate-800/80 rounded-xl p-3">
                    Nothing scheduled.
                    {data.schedulingUserId && (
                      <span className="block text-slate-600 mt-1">
                        Only bookings linked to one of your leads appear here.
                      </span>
                    )}
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {data.upcoming.map((a) => (
                      <div
                        key={a.id}
                        className="bg-slate-950 border border-slate-800/80 rounded-xl p-3 flex items-center gap-3 text-xs"
                      >
                        <CalendarClock className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="text-slate-200 font-semibold truncate">{a.leadName}</div>
                          {a.appointmentType && (
                            <div className="text-xs text-slate-500 truncate">
                              {a.appointmentType}
                            </div>
                          )}
                        </div>
                        <div className="text-right shrink-0 text-slate-300">
                          <div>
                            {new Date(a.startTime).toLocaleDateString([], {
                              month: 'short',
                              day: 'numeric',
                            })}
                          </div>
                          <div className="text-xs text-slate-500">
                            {new Date(a.startTime).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
};

const Row: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex justify-between gap-3">
    <span className="text-slate-500">{label}</span>
    <span className="text-slate-200 truncate">{value}</span>
  </div>
);
