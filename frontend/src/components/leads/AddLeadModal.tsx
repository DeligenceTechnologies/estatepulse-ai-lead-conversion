import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, PenLine, X } from 'lucide-react';
import { toast } from 'react-toastify';
import { LEADS_CHANGED_EVENT } from '../../api/client';
import { apiFetch } from '../../lib/api';
import { errorDetails, errorText } from '../sheets/SheetModal';

/** What the server did with the lead: saved, and whether the AI is now reaching out. */
interface CreatedLead {
  id: string;
  contacting: boolean;
  warnings: string[];
}

/** The calling codes a local phone number can be read under, from the server's own phone library; names from the browser. */
interface Regions {
  default: string;
  /** One per calling code; `countries` has the code's main country first ("+44": GB, then GG, IM, JE). */
  codes: { callingCode: string; countries: string[] }[];
}

interface CallingCode {
  /** What the field holds: "+91". */
  value: string;
  callingCode: string;
  /** ISO codes, main country first. */
  countries: string[];
  names: string[];
  /** What the suggestion shows beside the code: "India", or "United States, Canada, Bahamas +22 more". */
  label: string;
}

const regionName = (() => {
  const names = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;
  return (code: string): string => {
    try {
      return names?.of(code) ?? code;
    } catch {
      return code;
    }
  };
})();

/**
 * What the owner typed into the country field -> one calling code and the
 * country it means, or null when it is not one yet. Accepts a calling code
 * ("91", "+91"), a country code ("IN") or an unambiguous start of a name
 * ("ind"). A shared code means the office's own country when it is one of
 * them (+1 → US), otherwise the code's main country (+44 → GB).
 */
function resolveCode(text: string, codes: CallingCode[], preferred: string): { code: CallingCode; region: string } | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  const pick = (code: CallingCode, region?: string) => ({
    code,
    region: region ?? (code.countries.includes(preferred) ? preferred : code.countries[0]),
  });
  const digits = /^\+?(\d{1,4})$/.exec(t)?.[1];
  if (digits) {
    const code = codes.find((c) => c.callingCode === digits);
    return code ? pick(code) : null;
  }
  if (/^[a-z]{2}$/.test(t)) {
    const code = codes.find((c) => c.countries.some((r) => r.toLowerCase() === t));
    return code ? pick(code, t.toUpperCase()) : null;
  }
  const named = codes.flatMap((code) => code.names.map((name, i) => ({ code, region: code.countries[i], name })).filter((n) => n.name.toLowerCase().startsWith(t)));
  return named.length === 1 ? pick(named[0].code, named[0].region) : null;
}

const field = 'w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-500 disabled:opacity-60';
const label = 'block text-slate-300 font-semibold mb-1';
/** Marks a field the form will not submit without. */
const Required: React.FC = () => (
  <span className="text-rose-400 ml-0.5" aria-hidden="true">
    *
  </span>
);

/**
 * One lead, typed in by the owner (owner-only on the server). Saved like an
 * approved import row: the AI reaches out right away unless something holds
 * it, which the result says plainly rather than closing over.
 */
export const AddLeadModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    phone: '',
    email: '',
    location: '',
    budget: '',
    bedrooms: '',
    motivation: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; details: string[] } | null>(null);
  const [result, setResult] = useState<CreatedLead | null>(null);

  // The country a local number is read in: the office's own until changed.
  // Without the list (it failed to load) the field stays free text and the server reads the number in the office's region.
  const [regions, setRegions] = useState<Regions | null>(null);
  const [countryText, setCountryText] = useState('');
  const codes = useMemo<CallingCode[]>(
    () =>
      (regions?.codes ?? []).map((c) => {
        const names = c.countries.map(regionName);
        const shown = names.slice(0, 3).join(', ');
        return {
          value: `+${c.callingCode}`,
          callingCode: c.callingCode,
          countries: c.countries,
          names,
          label: names.length > 3 ? `${shown} +${names.length - 3} more` : shown,
        };
      }),
    [regions],
  );
  useEffect(() => {
    let live = true;
    apiFetch<Regions>('/v1/leads/regions', { auth: true }).then(
      (r) => {
        if (live) setRegions(r);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (!regions || countryText) return;
    const own = codes.find((c) => c.countries.includes(regions.default));
    if (own) setCountryText(own.value);
  }, [regions, codes, countryText]);

  const picked = resolveCode(countryText, codes, regions?.default ?? '');
  // Typed a country in any form: the field settles on its code alone.
  const settleCountry = () => {
    if (picked && countryText !== picked.code.value) setCountryText(picked.code.value);
  };

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (codes.length > 0 && countryText.trim() && !picked) {
      setError({ message: 'Pick the phone country code from the suggestions.', details: [] });
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const created = await apiFetch<CreatedLead>('/v1/leads', {
        method: 'POST',
        body: { ...form, ...(picked ? { region: picked.region } : {}) },
        auth: true,
      });
      window.dispatchEvent(new Event(LEADS_CHANGED_EVENT));
      // Nothing to warn about: done. Otherwise the owner reads what to know before anyone calls.
      if (created.contacting && created.warnings.length === 0) {
        toast.success('Lead added — outreach is starting.');
        onClose();
      } else setResult(created);
    } catch (err) {
      setError({ message: errorText(err), details: errorDetails(err) });
    } finally {
      setSaving(false);
    }
  };

  return (
    // Scrolls as a page, not clipped in place: on a short window the form is taller than the viewport.
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 overflow-y-auto bg-slate-950/80 backdrop-blur-md animate-in fade-in duration-150">
      <div className="relative w-full max-w-lg my-8 bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden text-slate-100">
        <div className="p-5 bg-slate-950 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-emerald-600/20 text-emerald-400 flex items-center justify-center border border-emerald-500/30">
              <PenLine className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white">Add a lead</h3>
              <p className="text-xs text-slate-400">Saved as a new lead. The AI reaches out right away, as it does for a form submission.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="p-1.5 rounded-lg bg-slate-800 text-slate-400 hover:text-white transition-colors cursor-pointer disabled:cursor-not-allowed"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {result ? (
          <div className="p-5 space-y-4 text-xs">
            <div className="flex items-start gap-2.5">
              <div
                className={`w-9 h-9 rounded-xl flex items-center justify-center border shrink-0 ${
                  result.contacting
                    ? 'bg-emerald-600/20 text-emerald-400 border-emerald-500/30'
                    : 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                }`}
              >
                {result.contacting ? <CheckCircle2 className="w-5 h-5" /> : <AlertTriangle className="w-5 h-5" />}
              </div>
              <div className="min-w-0">
                <h4 className="text-sm font-bold text-white">
                  {form.firstName.trim()} {form.lastName.trim()} was added
                </h4>
                <p className="text-slate-400 leading-relaxed mt-0.5">
                  {result.contacting ? 'The AI is reaching out now.' : 'Saved, but nobody will be contacted automatically.'}
                </p>
              </div>
            </div>
            {result.warnings.length > 0 && (
              <ul className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 space-y-1 text-amber-100 leading-relaxed list-disc pl-7">
                {result.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
            <div className="flex items-center justify-end pt-1">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-on-accent rounded-lg font-semibold transition-colors cursor-pointer"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={(e) => void submit(e)} className="p-5 space-y-4 text-xs">
            {error && (
              <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 flex items-start gap-2">
                <AlertTriangle className="w-3.5 h-3.5 text-rose-400 mt-0.5 shrink-0" />
                <div className="text-rose-200 leading-relaxed">
                  <div>{error.message}</div>
                  {error.details.length > 0 && (
                    <ul className="list-disc pl-4 mt-1 space-y-0.5">
                      {error.details.map((d, i) => (
                        <li key={i}>{d}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label} htmlFor="add-lead-first">
                  First name
                  <Required />
                </label>
                <input id="add-lead-first" type="text" required maxLength={100} autoFocus value={form.firstName} onChange={set('firstName')} className={field} />
              </div>
              <div>
                <label className={label} htmlFor="add-lead-last">Last name</label>
                <input id="add-lead-last" type="text" maxLength={100} value={form.lastName} onChange={set('lastName')} className={field} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label} htmlFor="add-lead-country">
                  Country code
                  <Required />
                </label>
                {/* The field holds the code alone; the suggestions show the code with its country. Typing "ind" or "IN" finds it too. */}
                <input
                  id="add-lead-country"
                  type="text"
                  list="add-lead-countries"
                  autoComplete="off"
                  placeholder="+91"
                  title={picked ? regionName(picked.region) : undefined}
                  value={countryText}
                  onChange={(e) => setCountryText(e.target.value)}
                  onBlur={settleCountry}
                  className={`${field} font-mono ${countryText.trim() && codes.length > 0 && !picked ? 'border-amber-500/60' : ''}`}
                />
                <datalist id="add-lead-countries">
                  {codes.map((c) => (
                    <option key={c.callingCode} value={c.value} label={c.label} />
                  ))}
                </datalist>
              </div>
              <div>
                <label className={label} htmlFor="add-lead-phone">
                  Phone
                  <Required />
                </label>
                <input id="add-lead-phone" type="tel" required maxLength={50} value={form.phone} onChange={set('phone')} className={`${field} font-mono`} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label} htmlFor="add-lead-email">Email</label>
                <input id="add-lead-email" type="email" maxLength={255} value={form.email} onChange={set('email')} className={field} />
              </div>
              <div>
                <label className={label} htmlFor="add-lead-area">Area</label>
                <input id="add-lead-area" type="text" maxLength={255} placeholder="North Austin" value={form.location} onChange={set('location')} className={field} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label} htmlFor="add-lead-budget">Budget</label>
                <input id="add-lead-budget" type="text" maxLength={100} placeholder="$500k – 700k" value={form.budget} onChange={set('budget')} className={field} />
              </div>
              <div>
                <label className={label} htmlFor="add-lead-beds">Bedrooms</label>
                <input id="add-lead-beds" type="text" inputMode="numeric" maxLength={10} value={form.bedrooms} onChange={set('bedrooms')} className={field} />
              </div>
            </div>

            <div>
              <label className={label} htmlFor="add-lead-notes">Notes</label>
              <textarea
                id="add-lead-notes"
                rows={2}
                maxLength={2000}
                placeholder="What they are looking for, how they found you…"
                value={form.motivation}
                onChange={set('motivation')}
                className={`${field} resize-none`}
              />
            </div>

            <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-800">
              <span className="text-2xs text-slate-500">
                <span className="text-rose-400">*</span> Required. 
              </span>
              <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={saving}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-semibold transition-colors cursor-pointer disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 text-on-accent rounded-lg text-xs font-bold shadow-md shadow-emerald-950 transition-colors cursor-pointer disabled:opacity-60"
              >
                {saving ? 'Adding…' : 'Add lead'}
              </button>
              </div>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
