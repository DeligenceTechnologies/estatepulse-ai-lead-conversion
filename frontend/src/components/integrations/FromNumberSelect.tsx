import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Loader2, ShieldCheck } from 'lucide-react';
import { OwnedNumber, lookupOwnedNumbers } from '../../utils/assistantApi';


export const FromNumberSelect: React.FC<{
  apiKey: string;
  useStored: boolean;
  /** Changes when the stored account changes, so its numbers are re-read. */
  storedKeyId?: string;
  value: string;
  onChange: (v: string) => void;
  compact?: boolean;
}> = ({ apiKey, useStored, storedKeyId, value, onChange, compact }) => {
  const [numbers, setNumbers] = useState<OwnedNumber[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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

  const key = apiKey.trim();
  const usingStored = useStored && !key;

  const load = (k?: string) => {
    setLoading(true);
    setError(null);
    lookupOwnedNumbers(k)
      .then(setNumbers)
      .catch((e: any) => {
        setNumbers(null);
        setError(e.message);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    setNumbers(null);
    setError(null);
    setOpen(false);
    if (usingStored) load();
  }, [key, usingStored, storedKeyId]);

  const pad = compact ? 'px-3 py-1.5 rounded-lg' : 'px-3.5 py-2 rounded-xl';

  if (!numbers) {
    return (
      <div className="space-y-1">
        <button
          type="button"
          disabled={loading || (!usingStored && !key)}
          onClick={() => load(usingStored ? undefined : key)}
          className={`w-full bg-slate-950 border border-slate-800 ${pad} text-left text-slate-400 flex items-center gap-2 disabled:opacity-60 hover:border-slate-600 cursor-pointer disabled:cursor-not-allowed`}
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />}
          {loading
            ? 'Verifying key and loading numbers…'
            : usingStored || key
              ? 'Verify API key to load your numbers'
              : 'Enter your API key first'}
        </button>
        {error && <p className="text-2xs text-rose-400">{error}</p>}
      </div>
    );
  }

  // Keep a number already on file selectable even if Telnyx no longer lists it,
  // so opening the form does not silently change it.
  const options = numbers.map((n) => n.phone_number);
  if (value && !options.includes(value)) options.unshift(value);

  // A custom list rather than a native <select>: the OS draws that popup in
  // its own light colours, on top of the field, ignoring the dark theme.
  return (
    <div className="space-y-1">
      <div className="relative" ref={ref}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="listbox"
          aria-expanded={open}
          className={`w-full bg-slate-950 border ${pad} flex items-center justify-between gap-2 text-left font-mono focus:outline-none focus:border-emerald-500 cursor-pointer ${open ? 'border-emerald-500' : value ? 'border-slate-800 hover:border-slate-600' : 'border-rose-900/60'}`}
        >
          <span className={value ? 'text-white' : 'text-slate-500 font-sans'}>{value || 'Select the number'}</span>
          <ChevronDown className={`w-3.5 h-3.5 text-slate-500 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>

        {open && (
          <div
            role="listbox"
            aria-label="Select the number"
            className="absolute left-0 right-0 top-full mt-1.5 z-30 bg-slate-950 border border-slate-700 rounded-xl shadow-2xl overflow-hidden"
          >
            <div className="px-3 py-2 border-b border-slate-800 text-2xs uppercase font-bold tracking-wide text-slate-500">
              Select the number
            </div>
            {options.length === 0 ? (
              <div className="px-3 py-2.5 text-xs text-slate-400">No numbers on this account.</div>
            ) : (
              <ul className="max-h-60 overflow-y-auto py-1">
                {options.map((n) => (
                  <li key={n}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={n === value}
                      onClick={() => {
                        onChange(n);
                        setOpen(false);
                      }}
                      className={`w-full px-3 py-2 flex items-center justify-between gap-3 text-left font-mono text-xs hover:bg-slate-800/70 cursor-pointer ${n === value ? 'text-emerald-300' : 'text-slate-100'}`}
                    >
                      {n}
                      {n === value && <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      {numbers.length === 0 && (
        <p className="text-2xs text-amber-400">
          This Telnyx account has no phone numbers yet — buy one in the Telnyx portal, then verify again.
        </p>
      )}
    </div>
  );
};
