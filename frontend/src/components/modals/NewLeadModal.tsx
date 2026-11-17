import React, { useEffect, useRef, useState } from 'react';
import { Loader2, Pencil, UserPlus } from 'lucide-react';
import { toast } from 'react-toastify';
import {
  LEADS_CHANGED_EVENT,
  leadsApi,
  type LeadPatch,
  type LeadUpdateResult,
  type LiveLead,
  type NewLeadInput,
} from '../../api/client';
import { TimezoneSelect } from '../common/TimezoneSelect';
import { Select } from '../common/Select';
import { SheetError, SheetModal, errorDetails, errorText } from '../sheets/SheetModal';
import { Button } from '../common/Button';

interface CreateProps {
  mode?: 'create';
  onClose: () => void;
  /** Called with the new lead's id once it is saved. */
  onCreated: (leadId: string) => void;
}

interface EditProps {
  mode: 'edit';
  /** A database lead; the form loads it fresh rather than trusting whatever copy the screen holds. */
  leadId: string;
  /** Opened to fix the phone (from the review banner or the time zone card): the cursor starts there. */
  focus?: 'phone';
  onClose: () => void;
  /** Called once the server has saved the change, with what it answered. */
  onSaved?: (result: LeadUpdateResult) => void;
}

type NewLeadModalProps = CreateProps | EditProps;

/** The backend stores budgets as Decimal(12, 2). */
const MAX_BUDGET = 9_999_999_999;

const TIMELINES = ['ASAP', '1-3 months', '3-6 months', '6-12 months', '12+ months', 'Just browsing'];

/** The values the intake pipeline maps financing answers to (ingest/processing/heuristics.ts). */
const FINANCING = [
  { value: 'pre_approved', label: 'Pre-approved' },
  { value: 'cash_buyer', label: 'Cash buyer' },
  { value: 'needs_lender', label: 'Needs a lender' },
  { value: 'not_preapproved', label: 'Not pre-approved' },
];

const input =
  'w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-500';
const label = 'block text-xs text-slate-300 font-semibold mb-1';

const EMPTY_FORM = {
  firstName: '',
  lastName: '',
  phone: '',
  email: '',
  location: '',
  timeline: '',
  minBudget: '',
  maxBudget: '',
  bedrooms: '',
  financingStatus: '',
  notes: '',
  timezone: '',
};
type Form = typeof EMPTY_FORM;

/** Empty input -> left out of the request; anything else -> trimmed text or a whole number. */
const optionalText = (value: string): string | undefined => value.trim() || undefined;
const optionalNumber = (value: string): number | undefined => {
  const n = Number(value.replace(/[,\s]/g, ''));
  return value.trim() && Number.isFinite(n) ? Math.round(n) : undefined;
};
/** Typed in, but not a number: said out loud rather than quietly dropped. */
const notANumber = (value: string): boolean => Boolean(value.trim()) && optionalNumber(value) === undefined;

/** "under_30_days" -> "under 30 days": a stored value the fixed list does not have still reads as words. */
const humanize = (v: string) => v.replace(/_/g, ' ');

/** The lead as the form's text boxes hold it. */
const formOf = (l: LiveLead): Form => ({
  firstName: l.firstName ?? '',
  lastName: l.lastName ?? '',
  phone: l.phone ?? '',
  email: l.email ?? '',
  location: l.location ?? '',
  timeline: l.timeline ?? '',
  minBudget: l.minBudget != null ? String(l.minBudget) : '',
  maxBudget: l.maxBudget != null ? String(l.maxBudget) : '',
  bedrooms: l.bedrooms != null ? String(l.bedrooms) : '',
  financingStatus: l.financingStatus ?? '',
  notes: l.motivation ?? '',
  timezone: '',
});

/**
 * Only what differs from the lead as loaded; an emptied box is null, which clears it. Compared
 * after the same trimming and number parsing the server does, so retyping a value is no change.
 */
function patchOf(before: Form, after: Form): LeadPatch {
  const patch: LeadPatch = {};
  const texts = ['firstName', 'lastName', 'phone', 'email', 'location', 'timeline', 'financingStatus', 'notes'] as const;
  for (const key of texts) {
    const was = optionalText(before[key]) ?? null;
    const now = optionalText(after[key]) ?? null;
    if (was !== now) Object.assign(patch, { [key]: now });
  }
  for (const key of ['minBudget', 'maxBudget', 'bedrooms'] as const) {
    const was = optionalNumber(before[key]) ?? null;
    const now = optionalNumber(after[key]) ?? null;
    if (was !== now) patch[key] = now;
  }
  return patch;
}

/** The options of a fixed list, plus the lead's own value when the list does not have it. */
const withCurrent = (options: { value: string; label: string }[], current: string) =>
  current && !options.some((o) => o.value === current) ? [...options, { value: current, label: humanize(current) }] : options;

/**
 * Adds one lead by hand, or corrects one that exists (`mode="edit"`).
 *
 * Adding goes through the same pipeline as a form submission: with outreach on, the AI picks it
 * up like any new lead. Editing changes the lead's own details only — consent and outreach are
 * not on this form, and the time zone keeps its own control on the lead — and sends just the
 * fields that changed.
 */
export const NewLeadModal: React.FC<NewLeadModalProps> = (props) => {
  const editing = props.mode === 'edit';
  const leadId = editing ? props.leadId : null;
  const focusPhone = editing && props.focus === 'phone';

  const [form, setForm] = useState<Form>(EMPTY_FORM);
  // Edit mode: the lead as loaded, which the form is compared with to send only the changes.
  const [loaded, setLoaded] = useState<Form | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [startOutreach, setStartOutreach] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; details: string[] } | null>(null);
  const phoneRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!leadId) return;
    let alive = true;
    leadsApi
      .get(leadId)
      .then((lead) => {
        if (!alive) return;
        const initial = formOf(lead);
        setLoaded(initial);
        setForm(initial);
      })
      .catch((err) => { if (alive) setLoadError(errorText(err)); });
    return () => { alive = false; };
  }, [leadId]);

  // The fields only exist once the lead has loaded, so autoFocus alone would miss them.
  useEffect(() => {
    if (focusPhone && loaded) phoneRef.current?.focus();
  }, [focusPhone, loaded]);

  const set = (key: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const hasContact = Boolean(form.phone.trim() || form.email.trim());
  const patch = editing && loaded ? patchOf(loaded, form) : null;
  const unchanged = patch !== null && Object.keys(patch).length === 0;

  /** The checks both modes share; the server makes them again. */
  const invalid = (): string | null => {
    if (!form.firstName.trim()) return 'Enter a first name.';
    if (!hasContact) return 'Enter a phone number or an email address.';
    if (notANumber(form.minBudget) || notANumber(form.maxBudget)) return 'Enter the budget as a number, e.g. 650000.';
    if (notANumber(form.bedrooms)) return 'Enter the bedrooms as a number.';
    const minBudget = optionalNumber(form.minBudget);
    const maxBudget = optionalNumber(form.maxBudget);
    if ((minBudget ?? 0) > MAX_BUDGET || (maxBudget ?? 0) > MAX_BUDGET) return 'Budget is too large. Enter the amount in full, e.g. 650000.';
    if (minBudget !== undefined && maxBudget !== undefined && minBudget > maxBudget) return 'Budget min cannot be more than budget max.';
    return null;
  };

  const create = async () => {
    const body: NewLeadInput = {
      firstName: form.firstName.trim(),
      lastName: optionalText(form.lastName),
      phone: optionalText(form.phone),
      email: optionalText(form.email),
      location: optionalText(form.location),
      timeline: optionalText(form.timeline),
      minBudget: optionalNumber(form.minBudget),
      maxBudget: optionalNumber(form.maxBudget),
      bedrooms: optionalNumber(form.bedrooms),
      notes: optionalText(form.notes),
      timezone: optionalText(form.timezone),
      consent,
      startOutreach: consent && startOutreach,
    };
    const { id } = await leadsApi.create(body);
    // Not "outreach is starting": the server keeps a lead that once opted out paused, and says only { id }.
    // Without consent it waits in Import Review, out of the Leads list, until the owner marks it.
    toast.success(
      consent
        ? 'Lead added.'
        : 'Lead added. Without consent it waits in Import Review → Consent needed; it is not called or texted until you mark its consent there.',
    );
    if (!consent) window.dispatchEvent(new Event(LEADS_CHANGED_EVENT));
    if (!editing) props.onCreated(id);
  };

  const update = async () => {
    if (!leadId || !patch) return;
    const result = await leadsApi.update(leadId, patch);
    if (result.becameDoNotContact) {
      toast.warning(
        'Saved. This phone or email asked not to be contacted before, so the lead is now do-not-contact and will not be called or texted.',
        { autoClose: 10000 },
      );
    } else if (result.changed.length === 0) {
      toast.info('Nothing changed.');
    } else {
      toast.success('Lead updated.');
    }
    // Both lead loaders (the pipeline and /api/leads) refetch, so the dossier and the list show the new values.
    window.dispatchEvent(new Event(LEADS_CHANGED_EVENT));
    if (editing) props.onSaved?.(result);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const problem = invalid();
    if (problem) {
      setError({ message: problem, details: [] });
      return;
    }
    if (unchanged) {
      props.onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await (editing ? update() : create());
      props.onClose();
    } catch (err) {
      setError({ message: errorText(err), details: errorDetails(err) });
      setSaving(false);
    }
  };

  const icon = (
    <div className="w-8 h-8 rounded-lg bg-emerald-600/20 text-emerald-400 flex items-center justify-center border border-emerald-500/30 shrink-0">
      {editing ? <Pencil className="w-4 h-4" /> : <UserPlus className="w-4 h-4" />}
    </div>
  );

  if (editing && !loaded) {
    return (
      <SheetModal title="Edit lead" icon={icon} onClose={props.onClose}>
        {loadError ? (
          <SheetError message={`Could not load this lead: ${loadError}`} />
        ) : (
          <div className="py-10 flex items-center justify-center gap-2 text-xs text-slate-400">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading the lead…
          </div>
        )}
      </SheetModal>
    );
  }

  const timelineOptions = withCurrent(TIMELINES.map((t) => ({ value: t, label: t })), form.timeline);
  const financingOptions = withCurrent(FINANCING, form.financingStatus);

  return (
    <SheetModal
      title={editing ? 'Edit lead' : 'Add a lead'}
      subtitle={
        editing
          ? focusPhone
            ? 'Fix the phone number. Start with the country code.'
            : 'Update the lead’s details.'
          : 'Add a lead from a call, walk-in or referral.'
      }
      icon={icon}
      wide
      onClose={props.onClose}
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label htmlFor="nl-first" className={label}>
              First name <span className="text-rose-400">*</span>
            </label>
            <input
              id="nl-first"
              required
              maxLength={100}
              value={form.firstName}
              onChange={set('firstName')}
              className={input}
              autoFocus={!focusPhone}
            />
          </div>
          <div>
            <label htmlFor="nl-last" className={label}>Last name</label>
            <input id="nl-last" maxLength={100} value={form.lastName} onChange={set('lastName')} className={input} />
          </div>
          <div>
            <label htmlFor="nl-phone" className={label}>Phone</label>
            <input
              id="nl-phone"
              ref={phoneRef}
              type="tel"
              maxLength={50}
              placeholder="+1 512 555 0188"
              value={form.phone}
              onChange={set('phone')}
              className={`${input} font-mono ${focusPhone ? 'border-amber-500/60' : ''}`}
            />
          </div>
          <div>
            <label htmlFor="nl-email" className={label}>Email</label>
            <input id="nl-email" type="email" maxLength={255} value={form.email} onChange={set('email')} className={input} />
          </div>
        </div>
        <p className="text-2xs text-slate-500 -mt-2">
          Phone or email is required. Start the phone with the country code, e.g. +1 or +91.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {/* Edit mode leaves the zone to the lead's own control, which wakes queued calls when it changes. */}
        {!editing && (
          <div className="sm:col-span-2">
            <div className="flex items-center justify-between gap-2 mb-1 h-[var(--text-xs--line-height)]">
              <label htmlFor="nl-timezone" className={`${label} mb-0`}>Time zone</label>
              {form.timezone && (
                <Button variant="link" onClick={() => setForm((f) => ({ ...f, timezone: '' }))}>
                  Reset
                </Button>
              )}
            </div>
            <TimezoneSelect
              id="nl-timezone"
              value={form.timezone}
              placeholder="Auto (from phone number)"
              onChange={(zone) => setForm((f) => ({ ...f, timezone: zone }))}
              className={input}
            />
          </div>
        )}
          <div>
            <label htmlFor="nl-location" className={label}>Preferred location</label>
            <input id="nl-location" maxLength={255} value={form.location} onChange={set('location')} className={input} />
          </div>
          <div>
            <label htmlFor="nl-timeline" className={label}>Timeline</label>
            <Select id="nl-timeline" value={form.timeline} onChange={set('timeline')} className={input}>
              <option value="">Not sure</option>
              {timelineOptions.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label htmlFor="nl-min" className={label}>Budget min</label>
            <input id="nl-min" inputMode="numeric" placeholder="500000" value={form.minBudget} onChange={set('minBudget')} className={`${input} font-mono`} />
          </div>
          <div>
            <label htmlFor="nl-max" className={label}>Budget max</label>
            <input id="nl-max" inputMode="numeric" placeholder="700000" value={form.maxBudget} onChange={set('maxBudget')} className={`${input} font-mono`} />
          </div>
          <div>
            <label htmlFor="nl-beds" className={label}>Bedrooms</label>
            <input id="nl-beds" type="number" min={0} max={50} value={form.bedrooms} onChange={set('bedrooms')} className={input} />
          </div>
          {editing && (
            <div>
              <label htmlFor="nl-financing" className={label}>Financing</label>
              <Select id="nl-financing" value={form.financingStatus} onChange={set('financingStatus')} className={input}>
                <option value="">Not known</option>
                {financingOptions.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </div>

        <div className={`grid grid-cols-1 gap-3 ${editing ? '' : 'md:grid-cols-2'}`}>
        <div>
          <label htmlFor="nl-notes" className={label}>Notes</label>
          <textarea
            id="nl-notes"
            rows={3}
            maxLength={2000}
            placeholder="What they want, how they found you…"
            value={form.notes}
            onChange={set('notes')}
            className={`${input} resize-y`}
          />
        </div>

        {/* Consent and outreach have their own flows once a lead exists (Consent Review, the strategy). */}
        {!editing && (
          <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3 space-y-3">
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => {
                  setConsent(e.target.checked);
                  if (!e.target.checked) setStartOutreach(false);
                }}
                className="mt-0.5 w-4 h-4 accent-emerald-500 cursor-pointer"
              />
              <span>
                <span className="block text-xs font-semibold text-slate-200">Lead agreed to be contacted</span>
                <span className="block text-2xs text-slate-500">Said yes to calls and texts.</span>
              </span>
            </label>
            <label className={`flex items-start gap-2.5 ${consent ? 'cursor-pointer' : 'opacity-50 cursor-not-allowed'}`}>
              <input
                type="checkbox"
                checked={startOutreach}
                disabled={!consent}
                onChange={(e) => setStartOutreach(e.target.checked)}
                className="mt-0.5 w-4 h-4 accent-emerald-500 cursor-pointer disabled:cursor-not-allowed"
              />
              <span>
                <span className="block text-xs font-semibold text-slate-200">Start AI outreach now</span>
                <span className="block text-2xs text-slate-500">
                  {consent
                    ? 'AI calls them right away. Leave off to call yourself.'
                    : 'Needs consent first.'}
                </span>
              </span>
            </label>
          </div>
        )}
        </div>

        {error && <SheetError message={error.message} details={error.details} />}

        <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-800">
          <Button variant="secondary" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={!form.firstName.trim() || !hasContact || unchanged}
            loading={saving}
            title={unchanged ? 'Nothing has changed yet' : undefined}
          >
            {editing ? 'Save changes' : 'Add lead'}
          </Button>
        </div>
      </form>
    </SheetModal>
  );
};
