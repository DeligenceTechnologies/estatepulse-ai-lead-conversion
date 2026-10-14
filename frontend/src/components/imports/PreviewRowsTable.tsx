import React, { useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import type { PreviewLead } from '../../utils/googleSheetsApi';
import { ISSUE_TEXT } from '../../utils/sheetMapping';

export interface PreviewRow {
  rowNumber: number;
  issue: string | null;
  lead: PreviewLead | null;
  reviewReasons: string[];
}

/** Flagged: a warning, a possible duplicate or an opt-out — anything worth a second look before approving. */
export const flagged = (r: PreviewRow): boolean => r.issue !== null || r.reviewReasons.length > 0;

/**
 * Every preview row with its verdict, shared by the sheet and file imports.
 * With `selected`, each importable row has a tick (ticked rows are approved as
 * they land); null shows the rows without ticks.
 */
export const PreviewRowsTable: React.FC<{
  rows: PreviewRow[];
  selected: Set<number> | null;
  onChange: (selected: Set<number>) => void;
  /** The line above the table. */
  note: React.ReactNode;
}> = ({ rows, selected, onChange, note }) => {
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const cleanRows = rows.filter((r) => !flagged(r));
  const shownRows = onlyFlagged ? rows.filter(flagged) : rows;
  const allCleanSelected = selected !== null && cleanRows.length > 0 && cleanRows.every((r) => selected.has(r.rowNumber));
  const toggleRow = (n: number) => {
    const next = new Set(selected);
    if (next.has(n)) next.delete(n);
    else next.add(n);
    onChange(next);
  };
  const toggleClean = () => {
    const next = new Set(selected);
    for (const r of cleanRows) {
      if (allCleanSelected) next.delete(r.rowNumber);
      else next.add(r.rowNumber);
    }
    onChange(next);
  };

  return (
    <div className="rounded-xl border border-slate-800 overflow-hidden">
      <div className="px-3 py-2 bg-slate-950/60 text-2xs text-slate-500 flex flex-wrap items-center gap-x-3 gap-y-1">
        {note}
        <span className="flex-1" />
        <label className="flex items-center gap-1 cursor-pointer text-slate-400">
          <input type="checkbox" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} />
          Show only flagged ({rows.length - cleanRows.length})
        </label>
      </div>
      <div className="max-h-64 overflow-y-auto">
        <table className="w-full text-2xs">
          <thead className="text-slate-500 text-left">
            <tr>
              {selected && (
                <th className="px-3 py-1.5 w-8">
                  <input
                    type="checkbox"
                    checked={allCleanSelected}
                    disabled={cleanRows.length === 0}
                    onChange={toggleClean}
                    aria-label="Tick every row without a flag"
                    title="Tick every row without a flag"
                  />
                </th>
              )}
              <th className="px-3 py-1.5 font-semibold">Row</th>
              <th className="px-3 py-1.5 font-semibold">Name</th>
              <th className="px-3 py-1.5 font-semibold">Phone</th>
              <th className="px-3 py-1.5 font-semibold">Email</th>
              <th className="px-3 py-1.5 font-semibold">Import</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {shownRows.map((r) => (
              <tr key={r.rowNumber} className={r.issue ? 'bg-rose-500/5' : selected?.has(r.rowNumber) ? 'bg-green-500/5' : ''}>
                {selected && (
                  <td className="px-3 py-1.5">
                    {!r.issue && (
                      <input
                        type="checkbox"
                        checked={selected.has(r.rowNumber)}
                        onChange={() => toggleRow(r.rowNumber)}
                        aria-label={`Approve row ${r.rowNumber} on import`}
                      />
                    )}
                  </td>
                )}
                <td className="px-3 py-1.5 text-slate-500 font-mono">{r.rowNumber}</td>
                <td className="px-3 py-1.5 text-slate-200">{[r.lead?.first_name, r.lead?.last_name].filter(Boolean).join(' ') || '—'}</td>
                <td className="px-3 py-1.5 text-slate-300">{r.lead?.normalized_phone ?? r.lead?.phone ?? '—'}</td>
                <td className="px-3 py-1.5 text-slate-300">{r.lead?.email ?? '—'}</td>
                <td className="px-3 py-1.5">
                  {r.issue ? (
                    <span className="text-rose-300 flex items-center gap-1">
                      <X className="w-3 h-3" /> {ISSUE_TEXT[r.issue] ?? r.issue}
                    </span>
                  ) : r.reviewReasons.length ? (
                    <span className="text-amber-200 flex items-center gap-1 cursor-help" title={r.reviewReasons.join('\n')}>
                      <AlertTriangle className="w-3 h-3" /> Yes, {r.reviewReasons.length} warning{r.reviewReasons.length === 1 ? '' : 's'}
                    </span>
                  ) : (
                    <span className="text-emerald-300">Yes</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
