import React, { useState } from 'react';
import { Loader2, UserPlus } from 'lucide-react';
import { toast } from 'react-toastify';
import { leadsApi, type NewLeadInput } from '../../api/client';
import { SheetError, SheetModal, errorDetails, errorText } from '../sheets/SheetModal';

interface NewLeadModalProps {
  onClose: () => void;
  /** Called with the new lead's id once it is saved. */
  onCreated: (leadId: string) => void;
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

/**
 * Adds one lead by hand. It goes through the same pipeline as a form
 * submission: with outreach on, the AI picks it up like any new lead.
 */
export const NewLeadModal: React.FC<NewLeadModalProps> = ({ onClose, onCreated }) => {
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    phone: '',
    email: '',
    location: '',
    timeline: '',
    minBudget: '',
    maxBudget: '',
    bedrooms: '',
    notes: '',
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
      consent,
      startOutreach: consent && startOutreach,
    };
    setSaving(true);
    setError(null);
    try {
      const { id } = await leadsApi.create(body);
      // Not "outreach is starting": the server keeps a lead that once opted out paused, and says only { id }.
      toast.success('Lead added.');
      onCreated(id);
      onClose();
    } catch (err) {
      setError({ message: errorText(err), details: errorDetails(err) });
      setSaving(false);
    }
  };

  return (
    <SheetModal
      title="Add a lead"
      subtitle="Type in a lead you got by phone, walk-in or referral."
      icon={
        <div className="w-8 h-8 rounded-lg bg-emerald-600/20 text-emerald-400 flex items-center justify-center border border-emerald-500/30 shrink-0">
          <UserPlus className="w-4 h-4" />
        </div>
      }
      onClose={onClose}
    >
      <form onSubmit={submit} className="space-y-4">
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
        <p className="text-2xs text-slate-500 -mt-2">A phone number or an email is required.</p>

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
            Add lead
          </button>
        </div>
      </form>
    </SheetModal>
  );
};
