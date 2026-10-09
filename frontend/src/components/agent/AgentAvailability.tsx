import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CalendarCheck,
  CalendarX,
  CheckCircle2,
  ExternalLink,
  Loader2,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { ApiError, messageFor } from '../../lib/api';
import {
  DAY_NAMES,
  getMyAvailability,
  getMyCalendar,
  saveMyAvailability,
  type Availability,
  type AvailabilityDay,
  type CalendarStatus,
} from '../../utils/calendarApi';

const field =
  'bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 ' +
  'focus:outline-none focus:border-emerald-500/60 disabled:opacity-40 cursor-pointer';

/** "2 minutes ago" — good enough, and it never claims more precision than it has. */
function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const secs = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

/** What the office actually uses, so this screen never sends anyone to the wrong tool. */
const PROVIDER_LABEL: Record<string, string> = {
  calendly: 'Calendly',
  cal: 'Cal.com',
};

/**
 * The agent's own calendar settings: where they stand on the office's
 * scheduling account, and the working hours the office routes leads by.
 *
 * There is nothing to connect here. Scheduling belongs to the ORGANIZATION —
 * the owner connects one account in Settings, Calendly or Cal.com, and
 * invites the agents onto that team — so this screen only reports whether the
 * office is connected and whether this agent is on it.
 *
 * Every label below is derived from `status.provider` rather than written in.
 * An office on Cal.com being told to check Calendly would send an agent looking
 * for an account they do not have.
 *
 * Working hours are NOT the provider's. They are what the assignment engine
 * evaluates, in this agent's own timezone, to decide who is on shift, and they
 * matter whether or not a calendar is connected at all.
 */
export const AgentAvailability: React.FC = () => {
  // Also rendered for an owner who takes leads. The facts are identical; only
  // "ask your owner" is wrong when the reader IS the owner, so those few lines
  // say what to do instead.
  const isOwner = useAuth().role === 'owner';
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [days, setDays] = useState<AvailabilityDay[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, a] = await Promise.all([getMyCalendar(), getMyAvailability()]);
      setStatus(s);
      setAvailability(a);
      setDays(a.days);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? messageFor(e) : String(e));
      setStatus(
        (prev) =>
          prev ?? {
            organizationConnected: false,
            provider: null,
            syncEnabled: false,
            schedulingUserId: null,
            schedulingUrl: null,
            lastSyncedAt: null,
          },
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? messageFor(e) : String(e));
    } finally {
      setBusy(null);
    }
  };

  const patchDay = (dayOfWeek: number, patch: Partial<AvailabilityDay>) =>
    setDays((prev) => prev.map((d) => (d.dayOfWeek === dayOfWeek ? { ...d, ...patch } : d)));

  const saveHours = () =>
    run('hours', async () => {
      await saveMyAvailability(days);
      setSavedAt(Date.now());
    });

  const dirty =
    availability !== null && JSON.stringify(days) !== JSON.stringify(availability.days);
  const invalidDay = days.find((d) => d.endTime <= d.startTime);
  // 'Scheduling' only while nothing is connected — there is no provider to name
  // yet, and inventing one would be a guess the agent might act on.
  const providerLabel = status?.provider ? PROVIDER_LABEL[status.provider] : 'Scheduling';

  if (!status) {
    return (
      <div className="p-6 max-w-7xl mx-auto text-slate-100">
        <Loader2 className="w-5 h-5 animate-spin text-slate-500" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto text-slate-100">
      <div>
        <h2 className="text-xl font-bold text-white tracking-tight">Availability</h2>
        <p className="text-xs text-slate-400">
          Tell the office when you work, and see where you stand on its calendar.
        </p>
      </div>

      {error && (
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 flex items-start gap-2 text-xs text-rose-200">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Scheduling — the office's account, not yours                      */}
      {/* ---------------------------------------------------------------- */}
      <section className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center shrink-0">
              <CalendarCheck className="w-4 h-4 text-emerald-400" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">{providerLabel}</h3>
              <p className="text-xs text-slate-400">
                {isOwner
                  ? 'The office’s one scheduling account. You are matched onto it like any agent.'
                  : 'Your office connects one scheduling account and invites you onto it.'}
              </p>
            </div>
          </div>

          {status.organizationConnected && status.schedulingUserId ? (
            <span className="text-2xs uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 h-fit">
              Linked
            </span>
          ) : status.organizationConnected ? (
            <span className="text-2xs uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40 h-fit">
              Not linked
            </span>
          ) : (
            <span className="text-2xs uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700 h-fit">
              Not connected
            </span>
          )}
        </div>

        {/* Three genuinely different states, and none of them is something this
            screen can fix — so each says who can, rather than offering a button
            that would fail. */}
        {!status.organizationConnected ? (
          <p className="text-xs text-slate-400 bg-slate-950/60 border border-slate-800/80 rounded-lg p-3 leading-relaxed">
            {isOwner
              ? 'No scheduling account is connected yet. Connect Calendly or Cal.com in Settings → Calendly, then press Sync agents — your bookings appear here once you are matched.'
              : 'Your office has not connected a scheduling account yet. Once the owner connects Calendly or Cal.com in Settings and invites you, your bookings appear here.'}
          </p>
        ) : !status.schedulingUserId ? (
          <p className="text-xs text-amber-200 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 leading-relaxed">
            {isOwner
              ? `You are not matched to a ${providerLabel} member yet, so bookings cannot be attributed to you. Make sure your ${providerLabel} email matches your agent profile email, then press Sync agents in Settings → Calendly.`
              : `You are not on your office's ${providerLabel} yet, so bookings cannot be attributed to you. Ask your owner to invite you in ${providerLabel} using this account's email address.`}
          </p>
        ) : (
          <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-3 space-y-1.5 text-xs">
            <div className="flex justify-between gap-3">
              <span className="text-slate-500">Last synced</span>
              <span className="text-slate-200">{relativeTime(status.lastSyncedAt)}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-slate-500">Updates</span>
              <span className="text-slate-200">
                {status.syncEnabled
                  ? 'Checked automatically'
                  : isOwner
                    ? 'Checked when you press Sync now'
                    : 'Checked when your owner syncs'}
              </span>
            </div>
            {status.schedulingUrl && (
              <div className="flex justify-between gap-3 items-center">
                <span className="text-slate-500">Booking page</span>
                <a
                  href={status.schedulingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-emerald-300 hover:text-emerald-200 flex items-center gap-1 truncate"
                >
                  <span className="truncate max-w-[200px]">{status.schedulingUrl}</span>
                  <ExternalLink className="w-3 h-3 shrink-0" />
                </a>
              </div>
            )}
          </div>
        )}

        {/* Only appointments tied to a lead are stored. Saying so here stops the
            list reading as though bookings had gone missing. */}
        {status.schedulingUserId && (
          <p className="text-xs text-slate-500 leading-relaxed">
            Set your availability in {providerLabel} itself — that is what decides when you can be
            booked. Only bookings whose invitee matches one of your office's leads are shown here;
            personal events on the same account stay private and are never stored.
          </p>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Working hours                                                     */}
      {/* ---------------------------------------------------------------- */}
      <section className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h3 className="text-sm font-bold text-white">Working hours</h3>
            <p className="text-xs text-slate-400">
              Times are in your own timezone
              {availability?.timezone ? (
                <span className="text-slate-300"> ({availability.timezone})</span>
              ) : null}
              .
            </p>
          </div>
          {savedAt && !dirty && (
            <span className="text-xs text-emerald-300 flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5" /> Saved
            </span>
          )}
        </div>

        <div className="space-y-1.5">
          {days.map((d) => (
            <div
              key={d.dayOfWeek}
              className="flex items-center gap-3 bg-slate-950 border border-slate-800/80 rounded-xl px-3 py-2"
            >
              <label className="flex items-center gap-2 w-32 shrink-0 cursor-pointer">
                <input
                  type="checkbox"
                  checked={d.isAvailable}
                  onChange={(e) => patchDay(d.dayOfWeek, { isAvailable: e.target.checked })}
                  className="accent-emerald-500 cursor-pointer"
                />
                <span
                  className={`text-xs font-medium ${d.isAvailable ? 'text-slate-200' : 'text-slate-500'}`}
                >
                  {DAY_NAMES[d.dayOfWeek]}
                </span>
              </label>

              <input
                type="time"
                value={d.startTime}
                disabled={!d.isAvailable}
                onChange={(e) => patchDay(d.dayOfWeek, { startTime: e.target.value })}
                className={field}
              />
              <span className="text-slate-600 text-xs">to</span>
              <input
                type="time"
                value={d.endTime}
                disabled={!d.isAvailable}
                onChange={(e) => patchDay(d.dayOfWeek, { endTime: e.target.value })}
                className={field}
              />

              {d.endTime <= d.startTime && (
                <span className="text-xs text-rose-300">End must be after start</span>
              )}
            </div>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={saveHours}
            disabled={!dirty || Boolean(invalidDay) || busy === 'hours'}
            className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-on-accent text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            {busy === 'hours' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Save working hours
          </button>
          {dirty && !invalidDay && (
            <span className="text-xs text-slate-500">Unsaved changes</span>
          )}
        </div>

        {/* An honest note: nothing consumes these yet. Better than implying the
            hours already change how leads are routed. */}
        <p className="text-xs text-slate-500 flex items-start gap-1.5">
          <CalendarX className="w-3.5 h-3.5 shrink-0 mt-0.5 text-slate-600" />
          <span>
            Your office can see these hours. They are not yet used to route leads automatically.
          </span>
        </p>
      </section>
    </div>
  );
};
