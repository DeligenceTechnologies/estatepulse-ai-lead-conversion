import React, { useEffect, useState } from 'react';
import { AlertTriangle, Building2, Loader2 } from 'lucide-react';
import { toast } from 'react-toastify';
import { messageFor } from '../../lib/api';
import { BUSINESS_DETAILS_SAVED, getBusinessDetails, updateBusinessDetails, type BusinessDetails, type BusinessDetailsView } from '../../utils/smsConversationApi';
import { displayNumber } from '../../utils/smsCompliance';

const FIELDS: { key: keyof BusinessDetails; label: string; placeholder: string; max: number; hint?: string }[] = [
  { key: 'mailingAddress', label: 'Mailing address', placeholder: '100 King St W, Suite 500, Toronto ON M5X 1A9', max: 200, hint: 'A street address or PO box leads can write to.' },
  { key: 'legalName', label: 'Legal business name', placeholder: 'Only if it differs from the name leads know', max: 120 },
  { key: 'website', label: 'Website', placeholder: 'skylinerealty.ca', max: 120 },
  { key: 'email', label: 'Email', placeholder: 'hello@skylinerealty.ca', max: 120 },
];

const EMPTY: BusinessDetails = { legalName: '', mailingAddress: '', email: '', website: '' };

/**
 * The one place an organization says who it is in its texts. Outreach texts
 * to Canadian numbers name the brokerage and the number; a lead who texts
 * HELP also gets the mailing address and the website or email, which Canada's
 * anti-spam law wants within their reach.
 */
export const BusinessDetailsCard: React.FC = () => {
  const [status, setStatus] = useState<BusinessDetailsView | null>(null);
  const [draft, setDraft] = useState<BusinessDetails>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = (s: BusinessDetailsView) => {
    setStatus(s);
    setDraft({ legalName: s.legalName, mailingAddress: s.mailingAddress, email: s.email, website: s.website });
  };

  useEffect(() => {
    getBusinessDetails()
      .then(apply)
      .catch((e) => setError(messageFor(e)));
  }, []);

  const save = async () => {
    setBusy(true);
    try {
      const saved = await updateBusinessDetails(draft);
      apply(saved);
      window.dispatchEvent(new CustomEvent<BusinessDetailsView>(BUSINESS_DETAILS_SAVED, { detail: saved }));
      toast.success('Business details saved.');
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setBusy(false);
    }
  };

  const changed = !!status && FIELDS.some(({ key }) => draft[key].trim() !== status[key]);

  return (
    <div id="business-details" className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl scroll-mt-6">
      <div>
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <Building2 className="w-4 h-4 text-emerald-400" />
          Business details for texts
        </h3>
        <p className="text-[11px] text-slate-400 mt-1">
          The first text to a number says who you are and &quot;Reply STOP to opt out&quot;. Every outreach text to a Canadian number names
          you and your number{status?.ourNumber ? ` (${status.brokerage}, ${displayNumber(status.ourNumber)})` : ''}. A lead who texts HELP
          also gets the details below.
        </p>
      </div>

      {error && <div className="text-xs text-rose-300 bg-rose-950/40 border border-rose-800/40 rounded-lg px-3 py-2">{error}</div>}

      {!status ? (
        !error && (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Loading…
          </div>
        )
      ) : (
        <fieldset className="space-y-3 text-xs" disabled={busy}>
          {!status.complete && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-700/40 bg-amber-950/30 px-3 py-2 text-amber-200">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>
                Add your mailing address. Canada&apos;s anti-spam law (CASL) wants texts to say who is sending them, with an address the
                lead can reach. Texts still go out without it.
              </span>
            </div>
          )}
          {FIELDS.map(({ key, label, placeholder, max, hint }) => (
            <div key={key} className="space-y-1">
              <label htmlFor={`business-${key}`} className="block text-slate-300 font-semibold">
                {label} {hint && <span className="text-slate-500 font-normal">— {hint}</span>}
              </label>
              <input
                id={`business-${key}`}
                value={draft[key]}
                maxLength={max}
                onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                // The card sits inside the AI Settings form: Enter saves these details, not the whole page.
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  if (changed) void save();
                }}
                placeholder={placeholder}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-600 disabled:opacity-50"
              />
            </div>
          ))}
          <div className="flex justify-end pt-1">
            <button
              type="button"
              onClick={() => void save()}
              disabled={!changed}
              className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-semibold cursor-pointer flex items-center gap-1.5"
            >
              {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Save details
            </button>
          </div>
        </fieldset>
      )}
    </div>
  );
};
