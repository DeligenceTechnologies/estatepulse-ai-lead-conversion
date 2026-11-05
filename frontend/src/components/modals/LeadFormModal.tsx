import React, { useState } from 'react';
import { AlertTriangle, Loader2, Pencil, UserPlus } from 'lucide-react';
import { toast } from 'react-toastify';
import { LEADS_CHANGED_EVENT, leadsApi, type LeadUpdateInput, type NewLeadInput } from '../../api/client';
import { TimezoneSelect } from '../common/TimezoneSelect';
import { SheetError, SheetModal, errorDetails, errorText } from '../sheets/SheetModal';

/**
 * Only the fields this form edits. Narrower than a full lead on purpose: the leads table, the
 * import review queue and anywhere else holding a lead can all open it without first having to
 * own every field a lead has.
 */
export interface EditableLead {
  id: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  /** False when the number cannot be dialled — usually because it carries no country code. */
  phoneValid: boolean;
  email: string | null;
  location: string | null;
  timeline: string | null;
  minBudget: number | null;
  maxBudget: number | null;
  bedrooms: number | null;
  motivation: string | null;
}

interface LeadFormModalProps {
  onClose: () => void;
  /**
   * The lead being corrected. Leave it out to add a new one: the fields are the same, so the
   * two share a form rather than drifting apart.
   */
  lead?: EditableLead;
  /** Called with the lead's id once it is saved, so the list behind can refresh. */
  onSaved: (leadId: string) => void;
}

/** The backend stores budgets as Decimal(12, 2). */
const MAX_BUDGET = 9_999_999_999;

const TIMELINES = ['ASAP', '1-3 months', '3-6 months', '6-12 months', '12+ months', 'Just browsing'];

const input =
  'w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-500';
const label = 'block text-xs text-slate-300 font-semibold mb-1';

/** Empty input -> left out of the request; anything else -> trimmed text or a whole number. */
const optionalText = (value: string): string | undefined => value.trim() || undefined;
const optionalNumber = (value: string): number | undefined => {
  const n = Number(value.replace(/[,\s]/g, ''));
  return value.trim() && Number.isFinite(n) ? Math.round(n) : undefined;
};

const text = (v: string | null | undefined): string => v ?? '';
const number = (v: number | null | undefined): string => (v === null || v === undefined ? '' : String(v));

/**
 * One lead, typed in or corrected. A new lead goes through the same pipeline as a form
 * submission: with outreach on, the AI picks it up like any other. Correcting an existing
 * one is chiefly how a phone number that arrived without its country code is made dialable.
 */
export const LeadFormModal: React.FC<LeadFormModalProps> = ({ onClose, lead, onSaved }) => {
  const editing = lead !== undefined;
  const [form, setForm] = useState({
    firstName: text(lead?.firstName),
    lastName: text(lead?.lastName),
    phone: text(lead?.phone),
    email: text(lead?.email),
    location: text(lead?.location),
    timeline: text(lead?.timeline),
    minBudget: number(lead?.minBudget),
    maxBudget: number(lead?.maxBudget),
    bedrooms: number(lead?.bedrooms),
    notes: text(lead?.motivation),
    timezone: '',
  });
  const [consent, setConsent] = useState(false);
  const [startOutreach, setStartOutreach] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; details: string[] } | null>(null);

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const hasContact = Boolean(form.phone.trim() || form.email.trim());

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hasContact) {
      setError({ message: 'Enter a phone number or an email address.', details: [] });
      return;
    }
    const minBudget = optionalNumber(form.minBudget);
    const maxBudget = optionalNumber(form.maxBudget);
    if ((minBudget ?? 0) > MAX_BUDGET || (maxBudget ?? 0) > MAX_BUDGET) {
      setError({ message: 'Budget is too large. Enter the amount in full, e.g. 650000.', details: [] });
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (editing) {
        // Every field goes, "" and all: on a correction "" means clear, and the form already
        // holds the whole lead, so sending it all keeps the request and the screen in step.
        const body: LeadUpdateInput = {
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim(),
          phone: form.phone.trim(),
          email: form.email.trim(),
          location: form.location.trim(),
          timeline: form.timeline.trim(),
          minBudget: minBudget ?? null,
          maxBudget: maxBudget ?? null,
          bedrooms: optionalNumber(form.bedrooms) ?? null,
          notes: form.notes.trim(),
        };
        await leadsApi.update(lead.id, body);
        toast.success('Lead updated.');
        onSaved(lead.id);
      } else {
        const body: NewLeadInput = {
          firstName: form.firstName.trim(),
          lastName: optionalText(form.lastName),
          phone: optionalText(form.phone),
          email: optionalText(form.email),
          location: optionalText(form.location),
          timeline: optionalText(form.timeline),
          minBudget,
          maxBudget,
          bedrooms: optionalNumber(form.bedrooms),
          notes: optionalText(form.notes),
          timezone: optionalText(form.timezone),
          consent,
          startOutreach: consent && startOutreach,
        };
        const { id } = await leadsApi.create(body);
        // Not "outreach is starting": the server keeps a lead that once opted out paused, and says only { id }.
        // Without consent it waits in Import Review, out of the Leads list, until the owner marks it.
      toast.success(consent ? 'Lead added.' : 'Lead added. Without consent it waits in Import Review → Consent needed; it is not called or texted until you mark its consent there.');
      if (!consent) window.dispatchEvent(new Event(LEADS_CHANGED_EVENT));
        onSaved(id);
      }
      onClose();
    } catch (err) {
      setError({ message: errorText(err), details: errorDetails(err) });
      setSaving(false);
    }
  };

  return (
    <SheetModal
      title={editing ? 'Edit lead' : 'Add a lead'}
      subtitle={
        editing
          ? 'Correct what you know. Clearing a field empties it.'
          : 'Type in a lead you got by phone, walk-in or referral.'
      }
      icon={
        <div className="w-8 h-8 rounded-lg bg-emerald-600/20 text-emerald-400 flex items-center justify-center border border-emerald-500/30 shrink-0">
          {editing ? <Pencil className="w-4 h-4" /> : <UserPlus className="w-4 h-4" />}
        </div>
      }
      onClose={onClose}
    >
      <form onSubmit={submit} className="space-y-4">
        {/* The one correction this form exists for, said where the number is about to be typed. */}
        {editing && lead.phone && !lead.phoneValid && (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 flex items-start gap-2 text-2xs text-amber-200 leading-relaxed">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
            <span>
              <span className="font-semibold text-amber-100">This number cannot be dialled.</span> It has no country code,
              and the digits alone never say which country a number is from, so we will not guess one. Put the code in
              below — or add it in the sheet this lead came from and sync again. Either way fixes it.
            </span>
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="nl-first" className={label}>
              First name <span className="text-rose-400">*</span>
            </label>
            <input id="nl-first" required maxLength={100} value={form.firstName} onChange={set('firstName')} className={input} autoFocus />
          </div>
          <div>
            <label htmlFor="nl-last" className={label}>Last name</label>
            <input id="nl-last" maxLength={100} value={form.lastName} onChange={set('lastName')} className={input} />
          </div>
          <div>
            <label htmlFor="nl-phone" className={label}>Phone</label>
            <input
              id="nl-phone"
              type="tel"
              maxLength={50}
              placeholder="+1 512 555 0188"
              value={form.phone}
              onChange={set('phone')}
              className={`${input} font-mono`}
            />
          </div>
          <div>
            <label htmlFor="nl-email" className={label}>Email</label>
            <input id="nl-email" type="email" maxLength={255} value={form.email} onChange={set('email')} className={input} />
          </div>
        </div>
        <p className="text-2xs text-slate-500 -mt-2">
          A phone number or an email is required. Start a phone number with its country code, e.g. +91 98765 43210 —
          without one we cannot tell which country it belongs to, and the lead cannot be called.
        </p>

        {!editing && (
          <div>
            <div className="flex items-center justify-between gap-2 mb-1">
              <label htmlFor="nl-timezone" className={`${label} mb-0`}>Time zone</label>
              {form.timezone && (
                <button
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, timezone: '' }))}
                  className="text-2xs text-slate-400 hover:text-white underline underline-offset-2 cursor-pointer"
                >
                  Use phone&rsquo;s
                </button>
              )}
            </div>
            <TimezoneSelect
              id="nl-timezone"
              value={form.timezone}
              placeholder="Work it out from the phone number"
              onChange={(zone) => setForm((f) => ({ ...f, timezone: zone }))}
              className={input}
            />
            <p className="text-2xs text-slate-500 mt-1">
              Calls and texts keep to the lead&rsquo;s local time. Left unset, their phone number decides.
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="nl-location" className={label}>Preferred location</label>
            <input id="nl-location" maxLength={255} value={form.location} onChange={set('location')} className={input} />
          </div>
          <div>
            <label htmlFor="nl-timeline" className={label}>Timeline</label>
            <select id="nl-timeline" value={form.timeline} onChange={set('timeline')} className={input}>
              <option value="">Not sure</option>
              {TIMELINES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
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
        </div>

        <div>
          <label htmlFor="nl-notes" className={label}>Notes</label>
          <textarea
            id="nl-notes"
            rows={3}
            maxLength={2000}
            placeholder="What they are looking for, how they found you…"
            value={form.notes}
            onChange={set('notes')}
            className={`${input} resize-y`}
          />
        </div>

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
              <span className="block text-xs font-semibold text-slate-200">The lead agreed to be contacted</span>
              <span className="block text-2xs text-slate-500">They said yes to calls and texts from you.</span>
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
                  ? 'The AI assistant calls them like any new lead. Leave off to reach out yourself.'
                  : 'Needs the lead’s agreement first.'}
              </span>
            </span>
          </label>
        </div>
        )}

        {error && <SheetError message={error.message} details={error.details} />}

        <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-800">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-semibold transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving || !form.firstName.trim() || !hasContact}
            className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 text-on-accent rounded-lg text-xs font-bold transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default flex items-center gap-1.5"
          >
            {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {editing ? 'Save changes' : 'Add lead'}
          </button>
        </div>
      </form>
    </SheetModal>
  );
};
