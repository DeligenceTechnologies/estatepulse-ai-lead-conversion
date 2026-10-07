import React, { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Calendar,
  ExternalLink,
  Loader2,
  RotateCw,
} from "lucide-react";
import { messageFor } from "../../lib/api";
import {
  getLeadAppointments,
  getLeadBookingOptions,
  type Appointment,
  type LeadBookingOptions,
} from "../../utils/calendarApi";

/**
 * Booking a meeting for one lead, and the lead's real appointments.
 *
 * The flow: the lead has an assigned agent → pick one of that agent's event
 * types → the agent's Calendly / Cal.com page opens with this lead's name and
 * email filled in and the lead's id carried in the link. Whoever picks the time
 * (the agent on the phone, or the lead from a link sent to them), the booking
 * comes back through the regular sync and appears on this lead.
 *
 * `agentKey` is the assigned agent's id: assigning someone else re-reads the
 * options, since they are that agent's pages.
 */

const PROVIDER_LABEL: Record<string, string> = {
  calendly: "Calendly",
  cal: "Cal.com",
};

function blockerText(o: LeadBookingOptions): string {
  const provider =
    PROVIDER_LABEL[o.provider ?? ""] ?? "your scheduling account";
  const agent = o.agent?.name ?? "The agent";
  switch (o.blocker) {
    case "no_agent":
      return "Assign an agent first — meetings are booked with the lead’s assigned agent.";
    case "no_calendar":
      return "No scheduling account is connected. Connect Calendly or Cal.com on Integrations.";
    case "agent_not_linked":
      return `${agent} is not linked to a ${provider} team member. On Integrations, open ${provider} and press Sync agents — their ${provider} email must match their EstatePulse email.`;
    case "no_event_types":
      return `${agent} has no event type of their own in ${provider}. Create one there (for example a 30 minute meeting), then reopen this lead.`;
    default:
      return "";
  }
}

export const LeadBookMeeting: React.FC<{
  leadId: string;
  agentKey: string | null;
}> = ({ leadId, agentKey }) => {
  const [options, setOptions] = useState<LeadBookingOptions | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setOptions(null);
    setError(null);
    getLeadBookingOptions(leadId)
      .then((o) => alive && setOptions(o))
      .catch((e) => alive && setError(messageFor(e)));
    return () => {
      alive = false;
    };
  }, [leadId, agentKey]);

  return (
    <div className="bg-gradient-to-r from-emerald-950/40 via-teal-950/40 to-slate-950 border border-emerald-500/30 p-4 rounded-xl space-y-3">
      <div>
        <h4 className="text-xs font-bold text-emerald-300 flex items-center gap-1.5">
          <Calendar className="w-3.5 h-3.5" />
          Book a meeting
        </h4>
        <p className="text-xs text-slate-400">
          {options?.agent
            ? `With ${options.agent.name}, the assigned agent. The booking page opens with this lead's details filled in; the appointment shows up here within a few minutes of booking.`
            : "Meetings are booked with the lead’s assigned agent."}
        </p>
      </div>

      {error ? (
        <p className="text-xs text-rose-300 flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          {error}
        </p>
      ) : !options ? (
        <p className="text-xs text-slate-500 flex items-center gap-1.5">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading booking
          options…
        </p>
      ) : options.blocker ? (
        <p className="text-xs text-amber-300 flex items-start gap-1.5 leading-relaxed">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          {blockerText(options)}
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {options.eventTypes.map((et) => (
            <a
              key={et.id}
              href={et.bookingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-on-accent text-xs font-semibold rounded-lg shadow-md transition-colors flex items-center gap-1.5"
            >
              <span>
                {et.name} · {et.durationMinutes} min
              </span>
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          ))}
        </div>
      )}
    </div>
  );
};

/** Only real web links become buttons; a location can also be a phone number or an address. */
const isWebLink = (u: string | null): u is string =>
  !!u && /^https:\/\//i.test(u);

const STATUS_STYLES: Record<string, string> = {
  scheduled: "bg-emerald-950 text-emerald-400",
  rescheduled: "bg-sky-950 text-sky-300",
  cancelled: "bg-rose-950 text-rose-300",
  completed: "bg-slate-800 text-slate-300",
  no_show: "bg-amber-950 text-amber-300",
};

export const LeadAppointments: React.FC<{
  leadId: string;
  agentKey: string | null;
}> = ({ leadId, agentKey }) => {
  const [rows, setRows] = useState<Appointment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getLeadAppointments(leadId)
      .then(setRows)
      .catch((e) => setError(messageFor(e)))
      .finally(() => setLoading(false));
  }, [leadId]);

  useEffect(load, [load]);

  return (
    <div className="space-y-4">
      <LeadBookMeeting leadId={leadId} agentKey={agentKey} />

      <div className="flex items-center justify-between">
        <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">
          Appointments
        </h4>
        <button
          onClick={load}
          disabled={loading}
          className="text-xs text-slate-400 hover:text-slate-200 flex items-center gap-1 cursor-pointer disabled:opacity-50"
        >
          <RotateCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />{" "}
          Refresh
        </button>
      </div>

      {error && <p className="text-xs text-rose-300">{error}</p>}

      {rows === null ? (
        !error && (
          <p className="text-xs text-slate-500 flex items-center gap-1.5">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading
            appointments…
          </p>
        )
      ) : rows.length === 0 ? (
        <div className="p-6 text-center bg-slate-950 border border-slate-800 rounded-xl">
          <Calendar className="w-7 h-7 text-slate-600 mx-auto mb-2" />
          <p className="text-xs text-slate-400">No appointments yet.</p>
          <p className="text-xs text-slate-500 mt-1">
            Bookings sync every few minutes; press Refresh after the lead books.
          </p>
        </div>
      ) : (
        rows.map((appt) => {
          // Nothing to join or reschedule once the meeting is over.
          const live =
            appt.status !== "cancelled" &&
            new Date(appt.endTime).getTime() >= Date.now();
          return (
            <div
              key={appt.id}
              className="bg-slate-950/80 border border-slate-800 p-4 rounded-xl flex items-center justify-between gap-3"
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-xl bg-purple-500/20 text-purple-400 flex items-center justify-center shrink-0">
                  <Calendar className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h4 className="text-xs font-bold text-white truncate">
                      {appt.appointmentType ?? "Meeting"}
                    </h4>
                    <span
                      className={`text-2xs px-2 py-0.5 rounded font-mono ${STATUS_STYLES[appt.status] ?? "bg-slate-800 text-slate-300"}`}
                    >
                      {appt.status.replace("_", " ").toUpperCase()}
                    </span>
                  </div>
                  <div className="text-xs text-slate-300 mt-0.5">
                    {new Date(appt.startTime).toLocaleString([], {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </div>
                  <div className="text-xs text-slate-400">
                    Agent: {appt.agentName}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {isWebLink(appt.rescheduleUrl) && live && (
                  <a
                    href={appt.rescheduleUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium border border-slate-700 transition-colors"
                  >
                    Reschedule
                  </a>
                )}
                {isWebLink(appt.meetingUrl) && live && (
                  <a
                    href={appt.meetingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium border border-slate-700 transition-colors"
                  >
                    Join meeting
                  </a>
                )}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
};
