import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, SlidersHorizontal } from 'lucide-react';
import {
  enableSheetSource,
  previewSheetSource,
  saveSheetMapping,
  type Identity,
  type SheetPreview,
  type SheetSource,
} from '../../utils/googleSheetsApi';
import {
  CHOICES,
  ISSUE_TEXT,
  choicesFromColumns,
  columnsFromChoices,
  draftProblems,
  type ColumnChoice,
} from '../../utils/sheetMapping';
import { SheetError, SheetModal, errorDetails, errorText } from './SheetModal';

const select =
  'w-full bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-green-500/60';

/**
 * Map a sheet's columns to lead fields, and choose how its rows are recognised.
 *
 * The preview table is the server's reading of the first rows under the mapping
 * as last saved (or as suggested, before the first save) — so it shows exactly
 * what an import would do, including which rows it would refuse and why.
 */
export const SheetMappingModal: React.FC<{
  sourceId: string;
  onClose: () => void;
  /** Saved or switched on: the caller refreshes its list. */
  onChanged: (source: SheetSource) => void;
}> = ({ sourceId, onClose, onChanged }) => {
  const [preview, setPreview] = useState<SheetPreview | null>(null);
  const [choices, setChoices] = useState<Record<string, ColumnChoice>>({});
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<{ message: string; details: string[] } | null>(null);
  const [busy, setBusy] = useState<null | 'load' | 'save' | 'enable'>('load');
  const [saved, setSaved] = useState<SheetSource | null>(null);

  const load = useCallback(async () => {
    setBusy('load');
    try {
      const p = await previewSheetSource(sourceId);
      setPreview(p);
      setChoices(choicesFromColumns(p.mapping.columns));
      setIdentity(p.mapping.identity);
      setAck(p.source.identity?.mode === 'fallback');
      setError(null);
    } catch (e) {
      setError({ message: errorText(e), details: [] });
    } finally {
      setBusy(null);
    }
  }, [sourceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const problems = useMemo(() => draftProblems(choices, identity, ack), [choices, identity, ack]);
  const usable = preview?.headers.filter((h) => h.fieldKey && !h.duplicate) ?? [];
  const idOptions = useMemo(() => {
    const rest = usable.map((h) => h.fieldKey).filter((k) => !preview?.identityCandidates.includes(k));
    return [...(preview?.identityCandidates ?? []), ...rest];
  }, [usable, preview]);
  const labelOf = (key: string) => usable.find((h) => h.fieldKey === key)?.label ?? key;

  const save = async () => {
    if (!identity) return;
    setBusy('save');
    setError(null);
    try {
      const source = await saveSheetMapping(sourceId, {
        columns: columnsFromChoices(choices),
        identity: identity.mode === 'column' ? identity : { mode: 'fallback', acknowledged: true },
      });
      setSaved(source);
      onChanged(source);
      await load();
    } catch (e) {
      setError({ message: errorText(e), details: errorDetails(e) });
    } finally {
      setBusy(null);
    }
  };

  const enable = async () => {
    setBusy('enable');
    setError(null);
    try {
      const source = await enableSheetSource(sourceId);
      onChanged(source);
      onClose();
    } catch (e) {
      setError({ message: errorText(e), details: [] });
      setBusy(null);
    }
  };

  const status = saved?.status ?? preview?.source.status;

  return (
    <SheetModal
      wide
      title={preview?.source.name ?? 'Loading the sheet…'}
      subtitle={preview ? `Tab “${preview.tab.title}” · first ${preview.rows.length} rows shown` : undefined}
      icon={<SlidersHorizontal className="w-4 h-4 text-green-400 mt-0.5 shrink-0" />}
      onClose={onClose}
    >
      {busy === 'load' && !preview && (
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading the header row and the first rows…
        </div>
      )}
      {error && <SheetError message={error.message} details={error.details} />}

      {preview && (
        <>
          {preview.problems.length > 0 && preview.mapping.saved && (
            <SheetError
              message="The sheet no longer matches the saved mapping. Choose the columns again and save to confirm."
              details={preview.problems.map((p) => p.message)}
            />
          )}

          {/* Columns */}
          <div className="rounded-xl border border-slate-800 overflow-hidden">
            <div className="grid grid-cols-[3rem_1fr_1.2fr_1.3fr] gap-2 px-3 py-2 bg-slate-950/60 text-2xs font-bold uppercase text-slate-500">
              <span>Col</span>
              <span>Heading</span>
              <span>Sample</span>
              <span>Import as</span>
            </div>
            <div className="max-h-72 overflow-y-auto divide-y divide-slate-800">
              {preview.headers
                .filter((h) => h.label)
                .map((h) => (
                  <div key={h.column} className="grid grid-cols-[3rem_1fr_1.2fr_1.3fr] gap-2 px-3 py-2 items-center">
                    <span className="text-2xs font-mono text-slate-500">{h.column}</span>
                    <span className="text-xs text-slate-100 truncate" title={h.label}>
                      {h.label}
                    </span>
                    <span className="text-2xs text-slate-400 truncate" title={h.samples.join(' · ')}>
                      {h.samples.join(' · ') || '—'}
                    </span>
                    {h.duplicate ? (
                      <span className="text-2xs text-amber-300">Heading repeats — rename it in the sheet</span>
                    ) : (
                      <select
                        className={select}
                        value={choices[h.fieldKey] ?? ''}
                        onChange={(e) => setChoices((c) => ({ ...c, [h.fieldKey]: e.target.value as ColumnChoice }))}
                      >
                        {CHOICES.map((c) => (
                          <option key={c.value} value={c.value}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                ))}
            </div>
          </div>

          {/* Row identity */}
          <div className="rounded-xl border border-slate-800 p-3 space-y-2">
            <div className="text-xs font-bold text-white">How should rows be recognised?</div>
            <label className="flex items-start gap-2 text-xs text-slate-200 cursor-pointer">
              <input
                type="radio"
                className="mt-0.5"
                checked={identity?.mode === 'column'}
                onChange={() => setIdentity({ mode: 'column', fieldKey: idOptions[0] ?? '' })}
              />
              <span className="flex-1 space-y-1.5">
                <span>By a unique ID column (recommended) — a lead ID, CRM ID or reference that never changes.</span>
                {identity?.mode === 'column' && (
                  <select
                    className={select}
                    value={identity.fieldKey}
                    onChange={(e) => setIdentity({ mode: 'column', fieldKey: e.target.value })}
                  >
                    {idOptions.map((k) => (
                      <option key={k} value={k}>
                        {labelOf(k)}
                        {preview.identityCandidates.includes(k) ? ' (looks like an ID)' : ''}
                      </option>
                    ))}
                  </select>
                )}
              </span>
            </label>
            <label className="flex items-start gap-2 text-xs text-slate-200 cursor-pointer">
              <input type="radio" className="mt-0.5" checked={identity?.mode === 'fallback'} onChange={() => setIdentity({ mode: 'fallback' })} />
              <span>My sheet has no ID column — recognise rows by name, phone and email.</span>
            </label>
            {identity?.mode === 'fallback' && (
              <div className="ml-5 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 space-y-2">
                <div className="flex items-start gap-1.5 text-xs text-amber-200">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>
                    Without an ID column, changing someone’s name, phone or email in the sheet makes that row look like a new
                    person: it is imported again as a new lead for review, and the old one is marked as removed from the
                    sheet.
                  </span>
                </div>
                <label className="flex items-center gap-2 text-xs text-amber-100 cursor-pointer">
                  <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />I understand
                </label>
              </div>
            )}
            <p className="text-2xs text-slate-500">This choice is locked once rows have been imported.</p>
          </div>

          {/* What an import would do */}
          <div className="rounded-xl border border-slate-800 overflow-hidden">
            <div className="px-3 py-2 bg-slate-950/60 text-2xs text-slate-500">
              {preview.mapping.saved ? 'Preview under the saved mapping' : 'Preview under the suggested mapping'} — save to
              apply your changes here.
            </div>
            <div className="max-h-56 overflow-y-auto">
              <table className="w-full text-2xs">
                <thead className="text-slate-500 text-left">
                  <tr>
                    <th className="px-3 py-1.5 font-semibold">Row</th>
                    <th className="px-3 py-1.5 font-semibold">Name</th>
                    <th className="px-3 py-1.5 font-semibold">Phone</th>
                    <th className="px-3 py-1.5 font-semibold">Email</th>
                    <th className="px-3 py-1.5 font-semibold">Import</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {preview.rows
                    .filter((r) => !r.blank)
                    .map((r) => (
                      <tr key={r.rowNumber}>
                        <td className="px-3 py-1.5 text-slate-500 font-mono">{r.rowNumber}</td>
                        <td className="px-3 py-1.5 text-slate-200">
                          {[r.lead?.first_name, r.lead?.last_name].filter(Boolean).join(' ') || '—'}
                        </td>
                        <td className="px-3 py-1.5 text-slate-300">{r.lead?.normalized_phone ?? r.lead?.phone ?? '—'}</td>
                        <td className="px-3 py-1.5 text-slate-300">{r.lead?.email ?? '—'}</td>
                        <td className="px-3 py-1.5">
                          {r.issue ? (
                            <span className="text-amber-300">{ISSUE_TEXT[r.issue] ?? r.issue}</span>
                          ) : r.reviewReasons.length ? (
                            <span className="text-amber-200" title={r.reviewReasons.join('\n')}>
                              Yes, with a warning
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

          {/* Save / switch on */}
          {problems.length > 0 && (
            <ul className="text-2xs text-amber-300 list-disc pl-4 space-y-0.5">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {saved && (
            <div className="flex items-center gap-1.5 text-xs text-emerald-300">
              <CheckCircle2 className="w-3.5 h-3.5" /> Mapping saved.
            </div>
          )}
          <div className="flex flex-col sm:flex-row gap-2">
            <button
              type="button"
              onClick={save}
              disabled={busy !== null || problems.length > 0}
              className="flex-1 px-4 py-2 rounded-xl text-xs font-bold bg-slate-800 text-slate-100 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-default cursor-pointer flex items-center justify-center gap-1.5"
            >
              {busy === 'save' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Save mapping
            </button>
            {saved && status !== 'ACTIVE' && (
              <button
                type="button"
                onClick={enable}
                disabled={busy !== null}
                className="flex-1 px-4 py-2 rounded-xl text-xs font-bold bg-green-600 text-white hover:bg-green-500 disabled:opacity-40 cursor-pointer flex items-center justify-center gap-1.5"
              >
                {busy === 'enable' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Start importing
              </button>
            )}
          </div>
          <p className="text-2xs text-slate-500">
            Imported leads wait in Import Review. Nobody is called or texted until you approve them.
          </p>
        </>
      )}
    </SheetModal>
  );
};
