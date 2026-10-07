import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Ban, CheckCircle2, Search, UserPlus, X } from 'lucide-react';
import { messageFor } from '../../lib/api';
import {
  enrollLeads,
  previewFilter,
  type EnrollResult,
  type FilterPreview,
  type LeadFilter,
  type Sequence,
} from '../../utils/sequencesApi';
import { LEAD_STATUSES, STATUS_LABELS } from '../../lib/leadStatus';

/**
 * Add leads to a sequence: by condition, or by hand from the matches.
 *
 * Nothing is written until the second click. The preview is a separate call
 * that only counts, because "add everyone who matches" is irreversible in the
 * way that matters — the texts go out — and a count is the only way to notice
 * that an empty filter selected the entire database.
 *
 * Opted-out leads never appear in the match at all. They are excluded server
 * side rather than listed and skipped, so the number shown is the number that
 * will actually be added.
 */

interface Props {
  sequence: Sequence;
  onClose: () => void;
  onEnrolled: () => void;
}


const label = 'block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1';
const input =
  'w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-emerald-600';

/**
 * Why a lead could not be added, in words the office uses. 'in_strategy' is the
 * one that needs explaining: the lead is not being ignored, it is already being
 * contacted by the strategy and will become eligible when that finishes.
 */
const SKIP_REASONS: Record<string, string> = {
  dnc: 'opted out',
  already_enrolled: 'already in a sequence',
  in_strategy: 'still in the strategy',
  not_found: 'not found',
};

export const EnrollLeadsModal: React.FC<Props> = ({ sequence, onClose, onEnrolled }) => {
  const [filter, setFilter] = useState<LeadFilter>({});
  const [preview, setPreview] = useState<FilterPreview | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<'filter' | 'picked'>('filter');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EnrollResult | null>(null);

  const patch = (p: Partial<LeadFilter>) => {
    setFilter((prev) => {
      const next = { ...prev, ...p };
      // Drop empties so the server sees an absent field rather than "" — the
      // schema is strict and an empty string is not a valid status or uuid.
      for (const k of Object.keys(next) as (keyof LeadFilter)[]) {
        const v = next[k];
        if (v === '' || v === false || v === undefined) delete next[k];
      }
      return next;
    });
    setResult(null);
  };

  const load = useCallback(async () => {
    setError(null);
    try {
      setPreview(await previewFilter(filter));
    } catch (e) {
      setError(messageFor(e));
    }
  }, [filter]);

  // Debounced so typing in the search box does not fire a count per keystroke.
  useEffect(() => {
    const t = setTimeout(() => void load(), 300);
    return () => clearTimeout(t);
  }, [load]);

  const empty = Object.keys(filter).length === 0;
  const count = mode === 'picked' ? picked.size : (preview?.total ?? 0);

  const commit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body =
        mode === 'picked' ? { leadIds: [...picked] } : { filter };
      setResult(await enrollLeads(sequence.id, body));
      onEnrolled();
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-start justify-center overflow-y-auto p-6">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-2xl shadow-2xl my-4">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
          <div>
            <h3 className="text-base font-bold text-white">Add leads to {sequence.name}</h3>
            <p className="text-xs text-slate-400">
              Nothing is sent until you confirm. Opted-out leads are never included.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 cursor-pointer"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {result ? (
          <div className="p-6 space-y-4">
            <div className="flex items-center gap-2 text-sm text-emerald-300">
              <CheckCircle2 className="w-5 h-5" />
              <span className="font-semibold">
                {result.enrolled} lead{result.enrolled === 1 ? '' : 's'} added to {sequence.name}
              </span>
            </div>

            {result.skipped.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs text-slate-400 uppercase tracking-wider font-semibold">
                  {result.skipped.length} skipped
                </p>
                <div className="max-h-52 overflow-y-auto space-y-1 custom-scrollbar">
                  {result.skipped.map((s) => (
                    <div
                      key={s.leadId}
                      className="flex items-center justify-between text-xs bg-slate-950/70 border border-slate-800/60 rounded-lg px-3 py-1.5"
                    >
                      <span className="text-slate-200">{s.leadName}</span>
                      <span className="text-2xs text-slate-400">
                        {SKIP_REASONS[s.reason]}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {result.matched > result.enrolled + result.skipped.length && (
              <p className="text-xs text-amber-300 flex items-start gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                {result.matched} leads matched but only {preview?.cap ?? 500} can be added at once.
                Run it again to add the rest.
              </p>
            )}

            <div className="flex justify-end">
              <button
                onClick={onClose}
                className="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium border border-slate-700 cursor-pointer"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="p-6 space-y-4">
              {error && (
                <div className="text-xs text-rose-300 bg-rose-950/40 border border-rose-800/40 rounded-lg px-3 py-2">
                  {error}
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className={label}>Temperature</label>
                  <select
                    className={input}
                    value={filter.temperature ?? ''}
                    onChange={(e) => patch({ temperature: e.target.value as LeadFilter['temperature'] })}
                  >
                    <option value="">Any</option>
                    <option value="hot">Hot</option>
                    <option value="warm">Warm</option>
                    <option value="cold">Cold</option>
                  </select>
                </div>
                <div>
                  <label className={label}>Status</label>
                  <select
                    className={input}
                    value={filter.status ?? ''}
                    onChange={(e) => patch({ status: e.target.value })}
                  >
                    <option value="">Any</option>
                    {LEAD_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {STATUS_LABELS[s]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={label}>Created from</label>
                  <input
                    type="date"
                    className={input}
                    value={filter.createdFrom ?? ''}
                    onChange={(e) => patch({ createdFrom: e.target.value })}
                  />
                </div>
                <div>
                  <label className={label}>Created to</label>
                  <input
                    type="date"
                    className={input}
                    value={filter.createdTo ?? ''}
                    onChange={(e) => patch({ createdTo: e.target.value })}
                  />
                </div>
              </div>

              <div>
                <label className={label}>Name or phone</label>
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    className={`${input} pl-8`}
                    value={filter.q ?? ''}
                    onChange={(e) => patch({ q: e.target.value })}
                    placeholder="Search"
                  />
                </div>
              </div>

              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!filter.noReply}
                    onChange={(e) => patch({ noReply: e.target.checked })}
                    className="accent-emerald-500"
                  />
                  Has never replied
                </label>
                <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!filter.neverContacted}
                    onChange={(e) => patch({ neverContacted: e.target.checked })}
                    className="accent-emerald-500"
                  />
                  Has never been contacted
                </label>
              </div>

              {/* Match */}
              <div className="pt-3 border-t border-slate-800 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-300">
                    <strong className="text-white">{preview?.total ?? '—'}</strong> lead
                    {preview?.total === 1 ? '' : 's'} match
                    {empty && <span className="text-amber-400"> — that is every lead you have</span>}
                  </span>
                  {(preview?.sample.length ?? 0) > 0 && (
                    <button
                      onClick={() => {
                        setMode(mode === 'filter' ? 'picked' : 'filter');
                        setPicked(new Set());
                      }}
                      className="text-xs text-emerald-400 hover:text-emerald-300 cursor-pointer"
                    >
                      {mode === 'filter' ? 'Pick individually instead' : 'Add all matches instead'}
                    </button>
                  )}
                </div>

                <div className="max-h-52 overflow-y-auto space-y-1 custom-scrollbar">
                  {preview?.sample.map((l) => (
                    <div
                      key={l.id}
                      onClick={() => mode === 'picked' && toggle(l.id)}
                      className={`flex items-center justify-between text-xs rounded-lg px-3 py-1.5 border ${
                        mode === 'picked'
                          ? `cursor-pointer ${
                              picked.has(l.id)
                                ? 'bg-emerald-950/50 border-emerald-700/50'
                                : 'bg-slate-950/70 border-slate-800/60 hover:border-slate-700'
                            }`
                          : 'bg-slate-950/70 border-slate-800/60'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        {mode === 'picked' && (
                          <input
                            type="checkbox"
                            readOnly
                            checked={picked.has(l.id)}
                            className="accent-emerald-500 pointer-events-none"
                          />
                        )}
                        <span className="text-slate-100">{l.name}</span>
                        <span className="text-slate-500 font-mono text-2xs">{l.phone}</span>
                      </span>
                      <span className="text-2xs text-slate-400">
                        {l.temperature ?? '—'} · {l.status}
                      </span>
                    </div>
                  ))}
                  {preview && preview.total > preview.sample.length && (
                    <p className="text-2xs text-slate-500 px-3 py-1">
                      …and {preview.total - preview.sample.length} more
                      {mode === 'picked' && ' (not shown, so not selectable individually)'}
                    </p>
                  )}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between px-6 py-4 border-t border-slate-800">
              <p className="text-xs text-slate-500 flex items-center gap-1.5">
                <Ban className="w-3 h-3" />
                Opted-out leads are excluded automatically.
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={onClose}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium border border-slate-700 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void commit()}
                  disabled={busy || count === 0}
                  className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-on-accent text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                >
                  <UserPlus className="w-3.5 h-3.5" />
                  {busy ? 'Adding…' : `Add ${count} lead${count === 1 ? '' : 's'}`}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
