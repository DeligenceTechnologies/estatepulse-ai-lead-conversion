import React, { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  CalendarDays,
  ChevronDown,
  Clock,
  Globe,
  Loader2,
  LocateFixed,
  Mail,
  PhoneCall,
  RotateCcw,
  Save,
  Settings2,
  ShieldAlert,
  UserCheck,
} from 'lucide-react';
import { toast } from 'react-toastify';
import { useAuth } from '../../context/AuthContext';
import { messageFor } from '../../lib/api';
import {
  getOrgSettings,
  setLeadAssignment,
  updateOrgSettings,
  type OrgSettings,
  type OrgSettingsUpdate,
} from '../../utils/orgSettingsApi';
import {
  DEFAULT_WORKING_HOURS,
  isWorkingNow,
  localTimeIn,
  normalizeWeek,
  utcOffset,
  type WorkingDay,
} from '../../utils/workingHours';
import { TimezoneSelect } from '../common/TimezoneSelect';
import { ConnectCalendar } from '../calendar/connect/ConnectCalendar';
import { CallingSettings } from '../integrations/CallingSettings';
import { TelnyxCard } from '../integrations/TelnyxCard';
import { WorkingHoursEditor, invalidDay } from '../team/WorkingHoursEditor';
import { useCallingProvider } from '../../utils/callingProviderApi';

type SettingsTab = 'general' | 'telnyx' | 'calendar' | 'calling';

const TABS: { id: SettingsTab; label: string; hint: string; icon: React.ElementType }[] = [
  { id: 'general', label: 'General', hint: 'Timezone & business hours', icon: Settings2 },
  { id: 'calendar', label: 'Calendar', hint: 'Calendly or Cal.com, and booked meetings', icon: CalendarDays },
  { id: 'telnyx', label: 'Telnyx', hint: 'Calling & phone numbers', icon: PhoneCall },
];

/** Where Retell is enabled on the server, one Calling section (Telnyx or Retell) takes the Telnyx section's place. */
const CALLING_TAB = { id: 'calling' as const, label: 'Calling', hint: 'Telnyx or Retell, and phone numbers', icon: PhoneCall };

/** The device's zone, offered as a one-click choice. */
const browserZone = (): string | null => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
};

const localDateIn = (timeZone: string, now: Date): string => {
  try {
    return now.toLocaleDateString('en-US', { timeZone, weekday: 'short', day: 'numeric', month: 'short' });
  } catch {
    return '';
  }
};

const sameWeek = (a: readonly WorkingDay[], b: readonly WorkingDay[]): boolean =>
  JSON.stringify(normalizeWeek(a)) === JSON.stringify(normalizeWeek(b));

/** A titled card on the settings page. */
const Card: React.FC<{
  icon: React.ReactNode;
  title: string;
  description: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}> = ({ icon, title, description, aside, children }) => (
  <section className="bg-slate-900/80 border border-slate-800 rounded-2xl overflow-hidden">
    <header className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-800">
      <div className="flex items-start gap-3 min-w-0">
        <span className="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0">
          {icon}
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-white">{title}</h3>
          <p className="text-xs text-slate-400 mt-0.5">{description}</p>
        </div>
      </div>
      {aside}
    </header>
    <div className="p-5">{children}</div>
  </section>
);

const AGENT_ROLE = 'agent';

const LeadAssignmentCard: React.FC = () => {
  const { roles, refreshSession } = useAuth();
  const [busy, setBusy] = useState(false);
  const enabled = roles.some((role) => !role.isSystem && role.name.toLowerCase() === AGENT_ROLE);

  const toggle = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await setLeadAssignment(!enabled);
      await refreshSession();
      toast.success(enabled ? 'Lead assignment turned off.' : 'Lead assignment turned on.');
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      icon={<UserCheck className="w-4 h-4" />}
      title="Lead assignment"
      description="Leads are assigned to members with the Agent role."
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-slate-200">Assign leads to me</div>
          <p className="text-2xs text-slate-500 mt-0.5">
            {enabled ? 'You hold the Agent role and can receive leads.' : 'Turn on to add the Agent role to your account.'}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Assign leads to me"
          aria-busy={busy || undefined}
          onClick={() => void toggle()}
          disabled={busy}
          className={`relative w-10 h-[22px] rounded-full shrink-0 transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 ${
            enabled ? 'bg-emerald-600' : 'bg-slate-700'
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-[18px] h-[18px] rounded-full bg-white shadow flex items-center justify-center transition-transform ${
              enabled ? 'translate-x-[18px]' : ''
            }`}
          >
            {busy && <Loader2 className="w-3 h-3 text-slate-500 animate-spin" />}
          </span>
        </button>
      </div>
    </Card>
  );
};

/** "21:00" → "9:00 PM". */
const clock12 = (time: string): string => {
  const [h, m] = time.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

/** Mirrors the server: a send time before noon covers the whole previous day. */
const coverageOf = (time: string): string =>
  Number(time.split(':')[0]) < 12 ? 'the whole previous day' : `today, from midnight to ${clock12(time)}`;

/**
 * The owners' daily summary email: on/off and the time it goes out. Saves on
 * its own, apart from the timezone/hours draft below it, so using it never
 * saves or discards those edits.
 */
const DailySummaryCard: React.FC<{
  enabled: boolean;
  time: string;
  timezone: string;
  canEdit: boolean;
  onSaved: (settings: OrgSettings) => void;
}> = ({ enabled, time, timezone, canEdit, onSaved }) => {
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(time);

  // A save, or another tab's, replaces the draft with what the server holds.
  useEffect(() => setDraft(time), [time]);

  const valid = /^([01]\d|2[0-3]):[0-5]\d$/.test(draft);
  const timeChanged = valid && draft !== time;
  const zone = timezone.replace(/_/g, ' ');

  const save = async (update: OrgSettingsUpdate, message: string): Promise<void> => {
    if (busy || !canEdit) return;
    setBusy(true);
    try {
      onSaved(await updateOrgSettings(update));
      toast.success(message);
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      icon={<Mail className="w-4 h-4" />}
      title="Daily summary email"
      description={`Every owner gets the day's leads, AI calls, texts and meetings by email, in ${zone} time.`}
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-slate-200">Send the daily summary</div>
            <p className="text-2xs text-slate-500 mt-0.5">
              {enabled
                ? `On: sent every day at ${clock12(time)}. Days with no activity are skipped.`
                : 'Off: no summary emails are sent to this organization.'}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Send the daily summary"
            aria-busy={busy || undefined}
            onClick={() =>
              void save(
                { dailySummaryEnabled: !enabled },
                enabled ? 'Daily summary email turned off.' : 'Daily summary email turned on.',
              )
            }
            disabled={busy || !canEdit}
            className={`relative w-10 h-[22px] rounded-full shrink-0 transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 ${
              enabled ? 'bg-emerald-600' : 'bg-slate-700'
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-[18px] h-[18px] rounded-full bg-white shadow flex items-center justify-center transition-transform ${
                enabled ? 'translate-x-[18px]' : ''
              }`}
            >
              {busy && <Loader2 className="w-3 h-3 text-slate-500 animate-spin" />}
            </span>
          </button>
        </div>

        {enabled && (
          <form
            className="border-t border-slate-800 pt-4 flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (timeChanged) void save({ dailySummaryTime: draft }, `Daily summary will be sent at ${clock12(draft)}.`);
            }}
          >
            <label className="min-w-0">
              <span className="block text-xs font-semibold text-slate-300 mb-1.5">Send at</span>
              <div className="relative">
                <Clock className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="time"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  disabled={busy || !canEdit}
                  required
                  className="h-11 w-40 bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-3 text-xs text-white tabular-nums focus:outline-none focus:border-emerald-500 hover:border-slate-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                />
              </div>
            </label>
            {timeChanged && (
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  disabled={busy}
                  className="h-11 px-4 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-on-accent cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-1.5"
                >
                  {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                  Save time
                </button>
                <button
                  type="button"
                  onClick={() => setDraft(time)}
                  disabled={busy}
                  className="h-11 px-3 rounded-xl text-xs font-semibold text-slate-300 bg-slate-800 hover:bg-slate-700 cursor-pointer disabled:opacity-60 transition-colors"
                >
                  Cancel
                </button>
              </div>
            )}
            <p className="basis-full text-2xs text-slate-500">
              {valid
                ? `At ${clock12(draft)} ${zone} time, covering ${coverageOf(draft)}. Pick a time before noon to get the previous day's full summary in the morning.`
                : 'Enter a time.'}
            </p>
          </form>
        )}
      </div>
    </Card>
  );
};

/**
 * General: the organization's timezone and business hours, saved to
 * `org_settings`. Edits collect in a draft; a bar at the bottom saves or
 * discards them together.
 */
const GeneralSettings: React.FC = () => {
  const { can, roles } = useAuth();
  const canEdit = can('organization.update');
  const isOwner = roles.some((role) => role.isSystem);

  const [saved, setSaved] = useState<OrgSettings | null>(null);
  const [timezone, setTimezone] = useState('');
  const [hours, setHours] = useState<WorkingDay[]>(DEFAULT_WORKING_HOURS);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [now, setNow] = useState(() => new Date());

  const adopt = (settings: OrgSettings): void => {
    setSaved(settings);
    setTimezone(settings.timezone);
    setHours(normalizeWeek(settings.workingHours));
  };

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      adopt(await getOrgSettings());
    } catch (e) {
      setLoadError(messageFor(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The preview clock.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (loadError) {
    return (
      <div role="alert" className="bg-rose-500/10 border border-rose-500/30 rounded-2xl p-5 flex items-start gap-3">
        <AlertTriangle className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" />
        <div className="text-xs text-rose-200 leading-relaxed flex-1">
          <div className="font-semibold text-rose-100">Settings could not be loaded</div>
          {loadError}
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold text-rose-100 bg-rose-500/20 hover:bg-rose-500/30 cursor-pointer transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!saved) {
    return (
      <div className="space-y-5">
        {[0, 1].map((i) => (
          <div key={i} className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 space-y-4 animate-pulse">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-slate-800" />
              <div className="space-y-2">
                <div className="h-3 w-36 rounded bg-slate-800" />
                <div className="h-2.5 w-56 rounded bg-slate-800/70" />
              </div>
            </div>
            <div className="h-24 rounded-xl bg-slate-800/50" />
          </div>
        ))}
      </div>
    );
  }

  const changes: OrgSettingsUpdate = {};
  if (timezone !== saved.timezone) changes.timezone = timezone;
  if (!sameWeek(hours, saved.workingHours)) changes.workingHours = hours;
  const dirty = Object.keys(changes).length > 0;
  const badDay = invalidDay(hours) !== -1;

  const save = async (): Promise<void> => {
    if (!dirty || badDay || saving) return;
    setSaving(true);
    try {
      adopt(await updateOrgSettings(changes));
      toast.success('Settings saved.');
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setSaving(false);
    }
  };

  const discard = (): void => {
    adopt(saved);
  };

  const open = isWorkingNow(hours, timezone, now);
  const local = localTimeIn(timezone, now);
  const device = browserZone();

  return (
    <div className="space-y-5">
      {isOwner && <LeadAssignmentCard />}

      {!canEdit && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 flex items-center gap-2 text-xs text-amber-200">
          <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0" />
          You can view these settings. Changing them needs the “Edit organization settings” permission.
        </div>
      )}

      <Card
        icon={<Globe className="w-4 h-4" />}
        title="Timezone"
        description="Business hours, reports and schedules are read in this zone."
      >
        <div className="grid gap-4 md:grid-cols-2">
          <div className="min-w-0">
            <label htmlFor="org-timezone" className="block text-xs font-semibold text-slate-300 mb-1.5">
              Organization timezone
            </label>
            <div className="relative">
              <Globe className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <TimezoneSelect
                id="org-timezone"
                value={timezone}
                onChange={setTimezone}
                disabled={!canEdit || saving}
                className="w-full h-11 appearance-none bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-9 text-xs text-white truncate focus:outline-none focus:border-emerald-500 hover:border-slate-700 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
              />
              <ChevronDown className="w-4 h-4 text-slate-500 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            </div>
          </div>

          <div className="min-w-0">
            <span className="block text-xs font-semibold text-slate-300 mb-1.5">Current local time</span>
            <div className="h-11 flex items-center gap-3 bg-slate-950/60 border border-slate-800 rounded-xl px-3">
              <Clock className="w-4 h-4 text-emerald-400 shrink-0" />
              <span className="text-sm font-bold text-white tabular-nums">{local ?? '—'}</span>
              <span className="text-2xs text-slate-500 truncate">{localDateIn(timezone, now)}</span>
              <span className="ml-auto text-2xs font-semibold text-slate-400 bg-slate-800/80 rounded-md px-1.5 py-0.5 shrink-0 tabular-nums">
                {utcOffset(timezone, now) || 'UTC'}
              </span>
            </div>
          </div>
        </div>

        {canEdit && device && device !== timezone && (
          <button
            type="button"
            onClick={() => setTimezone(device)}
            disabled={saving}
            className="mt-3 inline-flex items-center gap-1.5 text-2xs font-semibold text-emerald-400 hover:text-emerald-300 cursor-pointer disabled:opacity-60"
          >
            <LocateFixed className="w-3 h-3" />
            Use this device’s timezone ({device.replace(/_/g, ' ')})
          </button>
        )}
      </Card>

      <Card
        icon={<Clock className="w-4 h-4" />}
        title="Business hours"
        description={`When your office is open, in ${timezone.replace(/_/g, ' ')} time. New team members start with these hours.`}
        aside={
          <span
            className={`inline-flex items-center gap-1.5 text-2xs font-semibold px-2 py-1 rounded-full whitespace-nowrap ${
              open ? 'bg-emerald-500/10 text-emerald-300' : 'bg-slate-800 text-slate-400'
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${open ? 'bg-emerald-400' : 'bg-slate-500'}`} />
            {open ? 'Open now' : 'Closed now'}
          </span>
        }
      >
        <div className="text-xs">
          <WorkingHoursEditor value={hours} onChange={setHours} disabled={!canEdit || saving} />
        </div>
      </Card>

      <DailySummaryCard
        enabled={saved.dailySummaryEnabled}
        time={saved.dailySummaryTime}
        timezone={saved.timezone}
        canEdit={canEdit}
        onSaved={(next) =>
          setSaved((prev) =>
            prev ? { ...prev, dailySummaryEnabled: next.dailySummaryEnabled, dailySummaryTime: next.dailySummaryTime } : prev,
          )
        }
      />

      {/* Save bar: appears with unsaved changes */}
      {dirty && (
        <div className="sticky bottom-4 z-30 animate-fade-in">
          <div className="flex items-center gap-3 bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl px-4 py-3">
            <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
            <span className="text-xs text-slate-200 flex-1">
              {badDay ? 'Fix the highlighted day to save.' : 'You have unsaved changes'}
            </span>
            <button
              type="button"
              onClick={discard}
              disabled={saving}
              className="h-8 px-3 rounded-lg text-xs font-semibold text-slate-300 hover:bg-slate-800 flex items-center gap-1.5 cursor-pointer transition-colors disabled:opacity-60"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Discard
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || badDay}
              className="h-8 px-4 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-on-accent text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              Save changes
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * Settings: everything about how the organization runs, in one place, one
 * section at a time — General (timezone, business hours), Calendar (Calendly
 * or Cal.com) and Telnyx (calling); where the server enables Retell, Calling
 * (Telnyx or Retell) in Telnyx's place. The open section is in the URL
 * (?tab=telnyx) so it can be linked to and survives a reload.
 */
export const SettingsView: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const calling = useCallingProvider();
  const tabs = calling?.enabled ? TABS.map((t) => (t.id === 'telnyx' ? CALLING_TAB : t)) : TABS;
  const requested = params.get('tab');
  // With Retell on, links to ?tab=telnyx or ?tab=retell open Calling with that provider chosen.
  const providerLink = requested === 'telnyx' || requested === 'retell' ? requested : undefined;
  const asked = calling?.enabled && providerLink ? 'calling' : requested;
  const tab: SettingsTab = tabs.find((t) => t.id === asked)?.id ?? 'general';
  const current = tabs.find((t) => t.id === tab) ?? TABS[0];

  const select = (id: SettingsTab): void => {
    setParams(id === 'general' ? {} : { tab: id }, { replace: true });
  };

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto text-slate-100">
      <div className="mb-6">
        <h2 className="text-xl font-bold text-white tracking-tight">Settings</h2>
        <p className="text-xs text-slate-400">Your organization’s timezone, business hours, calling and calendar.</p>
      </div>

      <div className="flex flex-col lg:flex-row gap-6">
        {/* Section nav: a column on desktop, a scrolling row on phones */}
        <nav aria-label="Settings sections" className="lg:w-60 shrink-0">
          <ul className="flex lg:flex-col gap-1.5 overflow-x-auto custom-scrollbar -mx-1 px-1 pb-1 lg:pb-0 list-none">
            {tabs.map(({ id, label, hint, icon: Icon }) => {
              const active = id === tab;
              return (
                <li key={id} className="shrink-0">
                  <button
                    type="button"
                    onClick={() => select(id)}
                    aria-current={active ? 'page' : undefined}
                    className={`w-full flex items-center gap-3 text-left rounded-xl px-3 py-2.5 border transition-colors cursor-pointer ${
                      active
                        ? 'bg-emerald-500/10 border-emerald-500/30'
                        : 'border-transparent hover:bg-slate-900 hover:border-slate-800'
                    }`}
                  >
                    <span
                      className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                        active ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-800/70 text-slate-400'
                      }`}
                    >
                      <Icon className="w-4 h-4" />
                    </span>
                    <span className="min-w-0">
                      <span className={`block text-xs font-bold ${active ? 'text-emerald-200' : 'text-slate-200'}`}>
                        {label}
                      </span>
                      <span className="block text-2xs text-slate-500 truncate">{hint}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="flex-1 min-w-0">
          <div className="mb-4 hidden lg:block">
            <h3 className="text-base font-bold text-white">{current.label}</h3>
            <p className="text-xs text-slate-400">{current.hint}</p>
          </div>

          {tab === 'general' && <GeneralSettings />}

          {tab === 'telnyx' && (
            <div className="grid grid-cols-1 gap-5">
              <TelnyxCard />
            </div>
          )}

          {tab === 'calling' && <CallingSettings initial={providerLink} />}

          {tab === 'calendar' && <ConnectCalendar />}
        </div>
      </div>
    </div>
  );
};
