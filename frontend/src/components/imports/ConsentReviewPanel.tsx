import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Inbox, Loader2, UserPen } from 'lucide-react';
import { toast } from 'react-toastify';
import { LEADS_CHANGED_EVENT } from '../../api/client';
import { approveConsent, listConsentReview, rejectConsent, type ConsentReviewItem } from '../../utils/consentReviewApi';
import { errorText } from '../sheets/SheetModal';

const btn =
  'px-3 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default flex items-center gap-1.5';

const plural = (n: number) => `${n} lead${n === 1 ? '' : 's'}`;

/**
 * Leads added by hand without their consent box ticked. Nothing contacts them
 * while they wait here. "Mark consent given" makes them ordinary leads (they
 * join All Leads and the AI outreach starts); "Reject" closes them.
 */
export const ConsentReviewPanel: React.FC<{ onTotal: (n: number) => void }> = ({ onTotal }) => {
  const [items, setItems] = useState<ConsentReviewItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'approve' | 'reject'>(null);
  const [armed, setArmed] = useState<null | 'approve' | 'reject'>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await listConsentReview();
      setItems(page.items);
      onTotal(page.total);
      setSelected((s) => new Set([...s].filter((id) => page.items.some((i) => i.leadId === id))));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [onTotal]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (what: 'approve' | 'reject') => {
    if (armed !== what) {
      setArmed(what);
      return;
    }
    setArmed(null);
    setBusy(what);
    try {
      const ids = [...selected];
      if (what === 'approve') {
        const { approved } = await approveConsent(ids);
        toast.success(`Consent recorded for ${plural(approved)}. They are in All Leads now and the AI outreach will start.`);
      } else {
        const { rejected } = await rejectConsent(ids);
        toast.success(`Rejected ${plural(rejected)}. They will not be contacted.`);
      }
      setSelected(new Set());
      window.dispatchEvent(new Event(LEADS_CHANGED_EVENT));
      await load();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const allSelected = items.length > 0 && items.every((i) => selected.has(i.leadId));
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const decisionButton = (what: 'approve' | 'reject', label: string, cls: string) => (
    <button
      type="button"
      className={`${btn} ${armed === what ? 'bg-amber-500 text-slate-950' : cls}`}
      disabled={selected.size === 0 || busy !== null}
      onClick={() => void decide(what)}
      onBlur={() => armed === what && setArmed(null)}
    >
      {busy === what && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
      {armed === what ? `Click again to ${label.toLowerCase()} for ${selected.size}` : `${label} (${selected.size})`}
    </button>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-slate-400 flex-1 min-w-[16rem]">
          Leads added by hand without the consent box ticked. The AI does not call or text them until you mark their consent.
          {selected.size > 0 && armed === 'approve' && (
            <span className="block text-amber-300 mt-1">
              By confirming, you state these leads gave prior express written consent to be called and texted, including by an AI assistant.
            </span>
          )}
        </p>
        {decisionButton('reject', 'Reject', 'bg-slate-800 text-slate-200 hover:bg-rose-600/30')}
        {decisionButton('approve', 'Mark consent given', 'bg-green-600 text-white hover:bg-green-500')}
      </div>

      {error && (
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 flex items-start gap-2 text-xs text-rose-300">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span className="flex-1">{error}</span>
          <button type="button" onClick={() => void load()} className="font-bold underline cursor-pointer">
            Retry
          </button>
        </div>
      )}

      {loading && items.length === 0 && (
        <div className="flex items-center gap-2 text-xs text-slate-400 py-6 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      )}

      {!loading && items.length === 0 && !error && (
        <div className="text-center py-10 space-y-2">
          <Inbox className="w-7 h-7 text-slate-600 mx-auto" />
          <div className="text-xs text-slate-400">No leads are waiting for consent.</div>
        </div>
      )}

      {items.length > 0 && (
        <table className="w-full table-fixed text-xs">
          <thead className="text-2xs uppercase text-slate-500 text-left">
            <tr>
              <th className="px-2 py-2 w-10">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((i) => i.leadId)))}
                  aria-label="Select all"
                />
              </th>
              <th className="px-2 py-2">Name</th>
              <th className="px-2 py-2">Phone</th>
              <th className="px-2 py-2 w-[30%]">Email</th>
              <th className="px-2 py-2">Added</th>
              <th className="px-2 py-2 w-20 text-center">Source</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {items.map((i) => (
              <tr key={i.leadId} className={selected.has(i.leadId) ? 'bg-green-500/5' : ''}>
                <td className="px-2 py-2">
                  <input type="checkbox" checked={selected.has(i.leadId)} onChange={() => toggle(i.leadId)} aria-label="Select lead" />
                </td>
                <td className="px-2 py-2 text-slate-100">
                  <span className="block truncate" title={i.name}>{i.name}</span>
                </td>
                <td className="px-2 py-2 text-slate-300">
                  <span className="block truncate">{i.phone ?? '—'}</span>
                </td>
                <td className="px-2 py-2 text-slate-300">
                  <span className="block truncate" title={i.email ?? undefined}>{i.email ?? '—'}</span>
                </td>
                <td className="px-2 py-2 text-slate-400">{new Date(i.addedAt).toLocaleString()}</td>
                <td className="px-2 py-2 text-center">
                  <span title="Added by hand on the Leads screen" className="inline-flex items-center gap-1 text-slate-400">
                    <UserPen className="w-3.5 h-3.5" /> Manual
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};
