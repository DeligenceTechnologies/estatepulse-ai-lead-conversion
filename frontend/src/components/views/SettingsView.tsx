import React, { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Clock,
  Globe,
  Loader2,
  LocateFixed,
  PhoneCall,
  RotateCcw,
  Save,
  Settings2,
  ShieldAlert,
  X,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { messageFor } from '../../lib/api';
import { getOrgSettings, updateOrgSettings, type OrgSettings, type OrgSettingsUpdate } from '../../utils/orgSettingsApi';
import {
  DEFAULT_WORKING_HOURS,
  isWorkingNow,
  localTimeIn,
  normalizeWeek,
  utcOffset,
  weeklyHours,
  type WorkingDay,
} from '../../utils/workingHours';
import { TimezoneSelect } from '../common/TimezoneSelect';
import { SchedulingCards } from '../integrations/SchedulingCards';
import { TelnyxCard } from '../integrations/TelnyxCard';
import { WorkingHoursEditor, invalidDay } from '../team/WorkingHoursEditor';

type SettingsTab = 'general' | 'telnyx' | 'calendar';

const TABS: { id: SettingsTab; label: string; hint: string; icon: React.ElementType }[] = [
  { id: 'general', label: 'General', hint: 'Timezone & business hours', icon: Settings2 },
  { id: 'telnyx', label: 'Telnyx', hint: 'Calling & phone numbers', icon: PhoneCall },
  { id: 'calendar', label: 'Calendly', hint: 'Calendar & bookings', icon: CalendarDays },
];

const isTab = (value: string | null): value is SettingsTab => TABS.some((t) => t.id === value);

/** The device's zone, offered as a one-click choice. */
const browserZone = (): string | null => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
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

/**
 * General: the organization's timezone and business hours, saved to
 * `org_settings`. Edits collect in a draft; a bar at the bottom saves or
 * discards them together.
 */
const GeneralSettings: React.FC = () => {
  const { can } = useAuth();
  const canEdit = can('organization.update');

  const [saved, setSaved] = useState<OrgSettings | null>(null);
  const [timezone, setTimezone] = useState('');
  const [hours, setHours] = useState<WorkingDay[]>(DEFAULT_WORKING_HOURS);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
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

  useEffect(() => {
    if (!justSaved) return;
    const timer = setTimeout(() => setJustSaved(false), 2500);
    return () => clearTimeout(timer);
  }, [justSaved]);

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
    setSaveError(null);
    try {
      adopt(await updateOrgSettings(changes));
      setJustSaved(true);
    } catch (e) {
      setSaveError(messageFor(e));
    } finally {
      setSaving(false);
    }
  };

  const discard = (): void => {
    adopt(saved);
    setSaveError(null);
  };

  const open = isWorkingNow(hours, timezone, now);
  const local = localTimeIn(timezone, now);
  const device = browserZone();

  return (
    <div className="space-y-5">
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
        <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
          <div>
            <label htmlFor="org-timezone" className="block text-xs font-semibold text-slate-300 mb-1.5">
              Organization timezone
            </label>
            <TimezoneSelect
              id="org-timezone"
              value={timezone}
              onChange={setTimezone}
              disabled={!canEdit || saving}
              className="w-full h-10 bg-slate-950 border border-slate-800 rounded-lg px-3 text-xs text-white focus:outline-none focus:border-emerald-500 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
            />
            {canEdit && device && device !== timezone && (
              <button
                type="button"
                onClick={() => setTimezone(device)}
                disabled={saving}
                className="mt-2 inline-flex items-center gap-1.5 text-2xs font-semibold text-emerald-400 hover:text-emerald-300 cursor-pointer"
              >
                <LocateFixed className="w-3 h-3" />
                Use this device’s timezone ({device.replace(/_/g, ' ')})
              </button>
            )}
          </div>
          <div className="flex items-center gap-3 bg-slate-950/60 border border-slate-800 rounded-xl px-4 py-2.5">
            <Clock className="w-4 h-4 text-slate-500" />
            <div>
              <div className="text-base font-bold text-white tabular-nums leading-tight">{local ?? '—'}</div>
              <div className="text-2xs text-slate-500">Local time · {utcOffset(timezone, now)}</div>
            </div>
          </div>
        </div>
      </Card>

      <Card
        icon={<Clock className="w-4 h-4" />}
        title="Business hours"
        description="When your office is open. New team members start with these hours."
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
        <p className="mt-3 text-2xs text-slate-500">
          {weeklyHours(hours)} hours a week · times are in {timezone.replace(/_/g, ' ')}
        </p>
      </Card>

      {/* Save bar: appears with unsaved changes, and briefly after a save */}
      {(dirty || justSaved || saveError) && (
        <div className="sticky bottom-4 z-30 animate-fade-in">
          <div className="flex items-center gap-3 bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl px-4 py-3">
            {saveError ? (
              <>
                <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                <span className="text-xs text-rose-200 flex-1 min-w-0 truncate" title={saveError}>
                  {saveError}
                </span>
              </>
            ) : dirty ? (
              <>
                <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
                <span className="text-xs text-slate-200 flex-1">
                  {badDay ? 'Fix the highlighted day to save.' : 'You have unsaved changes'}
                </span>
              </>
            ) : (
              <>
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                <span className="text-xs text-emerald-200 flex-1">Settings saved</span>
              </>
            )}
            {dirty && (
              <>
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
              </>
            )}
            {!dirty && saveError && (
              <button
                type="button"
                onClick={() => setSaveError(null)}
                aria-label="Dismiss"
                className="p-1 rounded text-slate-400 hover:text-slate-200 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * Settings: everything about how the organization runs, in one place, one
 * section at a time — General (timezone, business hours), Telnyx (calling)
 * and Calendly (calendar and bookings). The open section is in the URL
 * (?tab=telnyx) so it can be linked to and survives a reload.
 */
export const SettingsView: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const tab: SettingsTab = isTab(requested) ? requested : 'general';
  const current = TABS.find((t) => t.id === tab) ?? TABS[0];

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
            {TABS.map(({ id, label, hint, icon: Icon }) => {
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

          {tab === 'calendar' && (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
              <SchedulingCards />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
