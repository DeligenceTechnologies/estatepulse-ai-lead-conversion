import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { toast } from 'react-toastify';
import { messageFor } from '../../lib/api';
import { getRates, putRates, type CostRates, type RatesSettings } from '../../utils/sourceRoiApi';
import { Button } from '../common/Button';

const input =
  'w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-500 disabled:opacity-60';
const label = 'block text-xs text-slate-300 font-semibold mb-1';

/** A rate as typed: a number of at most four decimals, or undefined when it is not one. */
export function parseRate(text: string): number | undefined {
  const cleaned = text.replace(/[$\s]/g, '');
  return /^\d+(\.\d{1,4})?$/.test(cleaned) ? Number(cleaned) : undefined;
}

/**
 * What to save: only the rates that were actually changed. A rate left as it was is not sent, so
 * an office still on a default stays on it (and follows the default if that is corrected later).
 */
export function changedRates(saved: CostRates, callRate: number, smsRate: number): Partial<CostRates> {
  return {
    ...(callRate !== saved.callRatePerMinute ? { callRatePerMinute: callRate } : {}),
    ...(smsRate !== saved.smsRatePerSegment ? { smsRatePerSegment: smsRate } : {}),
  };
}

/**
 * The two rates the cost estimate is built from: an AI call minute and a text
 * segment. Calls and texts are billed to the office's own phone provider, so
 * the office knows its real rates better than we do; until it enters them the
 * built-in defaults are used. A new rate applies to calls and texts from now
 * on: what was already costed keeps the rate it was costed at.
 */
export const CostRatesEditor: React.FC<{ canEdit: boolean; onSaved?: () => void }> = ({ canEdit, onSaved }) => {
  const [open, setOpen] = useState(false);
  const [rates, setRates] = useState<RatesSettings | null>(null);
  const [call, setCall] = useState('');
  const [sms, setSms] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const show = (r: RatesSettings): void => {
    setRates(r);
    setCall(String(r.callRatePerMinute));
    setSms(String(r.smsRatePerSegment));
  };

  useEffect(() => {
    if (!open || rates) return;
    let alive = true;
    getRates().then(
      (r) => alive && show(r),
      (e) => alive && setError(messageFor(e)),
    );
    return () => {
      alive = false;
    };
  }, [open, rates]);

  const send = async (body: Parameters<typeof putRates>[0], done: string): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      show(await putRates(body));
      toast.success(done);
      onSaved?.();
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setSaving(false);
    }
  };

  const save = (): void => {
    const callRate = parseRate(call);
    const smsRate = parseRate(sms);
    if (callRate === undefined || smsRate === undefined) {
      setError('Enter each rate as a dollar amount, for example 0.09.');
      return;
    }
    const changes = rates ? changedRates(rates, callRate, smsRate) : {};
    if (!Object.keys(changes).length) {
      setError(null);
      toast.info('The rates are unchanged.');
      return;
    }
    void send(changes, 'Cost rates saved.');
  };

  const usesDefaults = rates !== null && !rates.custom.callRatePerMinute && !rates.custom.smsRatePerSegment;

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-2xl">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full px-5 py-3.5 flex items-center justify-between gap-3 text-left cursor-pointer"
      >
        <span>
          <span className="block text-sm font-bold text-white">How the AI and communication cost is estimated</span>
          <span className="block text-xs text-slate-400 mt-0.5">
            Answered AI call minutes and text segments, multiplied by your rates.
          </span>
        </span>
        {open ? <ChevronDown className="w-4 h-4 text-slate-500 shrink-0" /> : <ChevronRight className="w-4 h-4 text-slate-500 shrink-0" />}
      </button>

      {open && (
        <div className="px-5 pb-5 space-y-4 border-t border-slate-800 pt-4">
          <p className="text-xs text-slate-400 leading-relaxed max-w-3xl">
            Calls and texts are billed by your phone provider, not by EstatePulse, so this figure is an estimate of that
            bill. It counts the minutes of answered AI calls and the segments of every text sent or received. It does not
            include voicemail detection, the agent's side of a live transfer, or phone number rental. Changing a rate
            applies to calls and texts from now on; earlier ones keep the rate they were costed at.
          </p>

          {rates === null && !error ? (
            <p className="text-xs text-slate-500">Loading rates…</p>
          ) : (
            rates && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-xl">
                <div>
                  <label className={label} htmlFor="rate-call">
                    AI call, per minute (USD)
                  </label>
                  <input id="rate-call" className={input} inputMode="decimal" value={call} disabled={!canEdit} onChange={(e) => setCall(e.target.value)} />
                  <p className="text-2xs text-slate-500 mt-1">Default {rates.defaults.callRatePerMinute}</p>
                </div>
                <div>
                  <label className={label} htmlFor="rate-sms">
                    Text, per segment (USD)
                  </label>
                  <input id="rate-sms" className={input} inputMode="decimal" value={sms} disabled={!canEdit} onChange={(e) => setSms(e.target.value)} />
                  <p className="text-2xs text-slate-500 mt-1">Default {rates.defaults.smsRatePerSegment}</p>
                </div>
              </div>
            )
          )}

          {error && <p className="text-xs text-rose-300">{error}</p>}

          {rates && canEdit && (
            <div className="flex items-center gap-3">
              <Button size="sm" onClick={save} loading={saving}>
                Save rates
              </Button>
              {!usesDefaults && (
                <Button
                  variant="link"
                  disabled={saving}
                  onClick={() => void send({ callRatePerMinute: null, smsRatePerSegment: null }, 'Cost rates reset to the defaults.')}
                >
                  Reset to defaults
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
