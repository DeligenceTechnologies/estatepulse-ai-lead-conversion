import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Handshake } from 'lucide-react';
import { toast } from 'react-toastify';
import { LEADS_CHANGED_EVENT } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { messageFor } from '../../lib/api';
import { dayFromIsoDate, isoDateOf } from '../../lib/datetime';
import { formatUsd, parseMoney } from '../../lib/money';
import { getDeal, putDeal, sourceRoiEnabled, type Deal, type DealOutcome } from '../../utils/sourceRoiApi';
import { Button } from '../common/Button';

const input =
  'w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-500';
const label = 'block text-xs text-slate-300 font-semibold mb-1';

const today = (): string => isoDateOf(new Date());

/** What the button reads once the deal has an outcome. */
export function dealLabel(deal: Deal | null): string {
  if (!deal?.outcome) return 'Mark outcome';
  if (deal.outcome === 'lost') return 'Deal lost';
  return deal.value === null ? 'Deal won' : `Deal won · ${formatUsd(deal.value)}`;
}

/**
 * How the lead's deal ended: won (with what it was worth) or lost.
 *
 * Separate from the lead's status on purpose. The status says where outreach
 * stands; this is the business result, and it is what Source ROI's cost per
 * closing and revenue are counted from.
 *
 * Shown to people who may edit leads, where Source ROI is switched on (the
 * answer is asked once per page load and shared, so a server with it off is
 * not asked for a deal on every lead). It renders nothing until the deal loads.
 */
export const DealOutcomeControl: React.FC<{ leadId: string }> = ({ leadId }) => {
  const { can } = useAuth();
  const allowed = can('lead.update');
  const [deal, setDeal] = useState<Deal | null>(null);
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<DealOutcome>('won');
  const [value, setValue] = useState('');
  const [closedOn, setClosedOn] = useState(today());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!allowed) return;
    let alive = true;
    setDeal(null);
    void sourceRoiEnabled()
      .then((on) => (on && alive ? getDeal(leadId) : null))
      .then(
        (d) => alive && d && setDeal(d),
        () => undefined,
      );
    return () => {
      alive = false;
    };
  }, [leadId, allowed]);

  // The form starts from what is saved each time it opens.
  useEffect(() => {
    if (!open || !deal) return;
    setOutcome(deal.outcome ?? 'won');
    setValue(deal.value === null ? '' : String(deal.value));
    setClosedOn(deal.closedAt ? isoDateOf(new Date(deal.closedAt)) : today());
    setError(null);
  }, [open, deal]);

  // Close on an outside click or Escape, like the app's other popovers.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  if (!allowed || !deal) return null;

  const send = async (body: Parameters<typeof putDeal>[1], done: string): Promise<void> => {
    setSaving(true);
    try {
      setDeal(await putDeal(leadId, body));
      window.dispatchEvent(new Event(LEADS_CHANGED_EVENT));
      setOpen(false);
      toast.success(done);
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setSaving(false);
    }
  };

  const save = (): void => {
    const amount = outcome === 'won' ? parseMoney(value) : null;
    if (amount === undefined) {
      setError('Enter the deal value as an amount, for example 12000.');
      return;
    }
    const day = dayFromIsoDate(closedOn);
    if (day === null || closedOn > today()) {
      setError(day === null ? 'Pick the date the deal closed.' : 'The closing date cannot be in the future.');
      return;
    }
    setError(null);
    // Noon of that day in the zone dates are shown in (the same zone the box was filled from),
    // so it reads back as the day that was picked whatever zone this device is in.
    const closedAt = new Date(day + 12 * 60 * 60 * 1000).toISOString();
    void send({ outcome, value: amount, closedAt }, outcome === 'won' ? 'Deal marked as won.' : 'Deal marked as lost.');
  };

  return (
    <div className="relative" ref={ref}>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Record how this lead's deal ended: won or lost"
        icon={<Handshake className={deal.outcome === 'won' ? 'text-emerald-400' : deal.outcome === 'lost' ? 'text-rose-400' : 'text-slate-400'} />}
        iconRight={<ChevronDown className="text-slate-500" />}
      >
        {dealLabel(deal)}
      </Button>

      {open && (
        <div
          role="dialog"
          aria-label="Deal outcome"
          className="absolute left-0 lg:left-auto lg:right-0 mt-2 w-72 max-w-[calc(100vw-2rem)] z-20 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-3 space-y-3"
        >
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Outcome">
            {(['won', 'lost'] as const).map((o) => (
              <button
                key={o}
                type="button"
                role="radio"
                aria-checked={outcome === o}
                onClick={() => setOutcome(o)}
                className={`h-9 rounded-lg border text-xs font-semibold cursor-pointer transition-colors ${
                  outcome === o
                    ? o === 'won'
                      ? 'bg-emerald-500/15 border-emerald-500/50 text-emerald-200'
                      : 'bg-rose-500/15 border-rose-500/50 text-rose-200'
                    : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                {o === 'won' ? 'Won' : 'Lost'}
              </button>
            ))}
          </div>

          {outcome === 'won' && (
            <div>
              <label className={label} htmlFor="deal-value">
                Deal value (USD)
              </label>
              <input
                id="deal-value"
                className={input}
                inputMode="decimal"
                placeholder="e.g. 12000"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
              <p className="text-2xs text-slate-500 mt-1">What the deal was worth to your business. Optional.</p>
            </div>
          )}

          <div>
            <label className={label} htmlFor="deal-closed">
              Closed on
            </label>
            <input
              id="deal-closed"
              type="date"
              className={input}
              max={today()}
              value={closedOn}
              onChange={(e) => setClosedOn(e.target.value)}
            />
          </div>

          {error && <p className="text-xs text-rose-300">{error}</p>}

          <div className="flex items-center justify-between gap-2 pt-1">
            {deal.outcome ? (
              <Button variant="link" disabled={saving} onClick={() => void send({ outcome: null }, 'Deal reopened.')}>
                Reopen deal
              </Button>
            ) : (
              <span />
            )}
            <Button size="sm" onClick={save} loading={saving}>
              Save
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
