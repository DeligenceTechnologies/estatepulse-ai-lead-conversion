import React, { useEffect, useState } from 'react';
import { AlertTriangle, CalendarCheck, CheckCircle2, Loader2 } from 'lucide-react';
import { messageFor } from '../../lib/api';
import {
  disableInCallBooking,
  enableInCallBooking,
  getInCallBooking,
  type InCallBookingStatus,
} from '../../utils/inCallBookingApi';

/**
 * In-call booking: when a caller asks for a meeting, the AI checks real open
 * times on the chosen Calendly round-robin event type and books it during the
 * call. Calendly picks the agent; the lead is assigned to them and the meeting
 * shows on their dashboard right away.
 */
export const InCallBookingCard: React.FC = () => {
  const [status, setStatus] = useState<InCallBookingStatus | null>(null);
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = (s: InCallBookingStatus) => {
    setStatus(s);
    setChoice(s.eventType?.uri ?? s.eventTypes[0]?.uri ?? '');
  };

  useEffect(() => {
    getInCallBooking()
      .then(apply)
      .catch((e) => setError(messageFor(e)));
  }, []);

  const run = async (fn: () => Promise<InCallBookingStatus>) => {
    setBusy(true);
    setError(null);
    try {
      apply(await fn());
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  };

  // What must be true before it can be switched on, in the order to fix it.
  const blocker = !status
    ? null
    : !status.calendly.connected
      ? 'Connect Calendly on Integrations first.'
      : !status.calendly.scopesOk
        ? 'Calendly has not granted booking permission yet: add availability:read and scheduled_events:write to your Calendly OAuth app, set CALENDLY_BOOKING_SCOPES=1 in the backend .env, restart, then reconnect Calendly on Integrations.'
        : !status.telnyx.connected || !status.telnyx.hasAssistant
          ? 'Connect Telnyx and create your AI assistant first.'
          : status.eventTypes.length === 0
            ? 'No round-robin or multi-pool event type found in Calendly. Create one (Calendly Teams plan) with your agents in a rotating host pool.'
            : null;

  const changed = status?.enabled && choice !== status.eventType?.uri;

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
      <div>
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <CalendarCheck className="w-4 h-4 text-emerald-400" />
          In-call booking
        </h3>
        <p className="text-[11px] text-slate-400 mt-1">
          When a caller asks for a meeting, the AI offers real open times and books it during the call. Calendly&apos;s
          round robin picks the agent; the lead is assigned to them and the meeting appears on their dashboard
          immediately.
        </p>
        <p className="text-[11px] text-slate-500 mt-1">
          Turning it on adds a marked &ldquo;appointment booking&rdquo; section to the end of your AI prompt, telling
          the AI when and how to book; turning it off removes just that section. The rest of your prompt is never
          changed.
        </p>
      </div>

      {error && (
        <div className="text-xs text-rose-300 bg-rose-950/40 border border-rose-800/40 rounded-lg px-3 py-2">{error}</div>
      )}

      {!status ? (
        !error && (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Loading…
          </div>
        )
      ) : (
        <>
          {status.enabled && status.eventType && (
            <p className="text-xs text-emerald-300 flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5" />
              On — booking &ldquo;{status.eventType.name}&rdquo; ({status.eventType.durationMinutes} min)
            </p>
          )}

          {blocker ? (
            <p className="text-[11px] text-amber-300 flex items-start gap-1.5 leading-relaxed">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              {blocker}
            </p>
          ) : (
            <div className="text-xs">
              <label className="block text-slate-300 font-semibold mb-1">
                Event type <span className="text-slate-500 font-normal">— a Calendly round robin with your agents as hosts</span>
              </label>
              <select
                value={choice}
                onChange={(e) => setChoice(e.target.value)}
                className="w-full md:w-96 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-600"
              >
                {status.eventTypes.map((et) => (
                  <option key={et.uri} value={et.uri}>
                    {et.name} · {et.durationMinutes} min
                  </option>
                ))}
              </select>
            </div>
          )}

          {status.unlinkedMembers.length > 0 && (
            <p className="text-[11px] text-amber-300 flex items-start gap-1.5 leading-relaxed">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              Not linked to an agent: {status.unlinkedMembers.join(', ')}. A meeting Calendly gives them is booked, but
              cannot be assigned here — press Sync agents on Integrations.
            </p>
          )}

          {status.problem && <p className="text-[11px] text-rose-300">{status.problem}</p>}

          <div className="flex items-center justify-end gap-2 pt-1 border-t border-slate-800">
            {status.enabled && (
              <button
                type="button"
                onClick={() => void run(disableInCallBooking)}
                disabled={busy}
                className="px-4 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:text-white hover:border-slate-600 text-xs font-semibold cursor-pointer disabled:opacity-40"
              >
                Turn off
              </button>
            )}
            {(!status.enabled || changed) && (
              <button
                type="button"
                onClick={() => void run(() => enableInCallBooking(choice))}
                disabled={busy || !!blocker || !choice}
                className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-semibold cursor-pointer flex items-center gap-1.5"
              >
                {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {status.enabled ? 'Switch event type' : 'Turn on'}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
};
