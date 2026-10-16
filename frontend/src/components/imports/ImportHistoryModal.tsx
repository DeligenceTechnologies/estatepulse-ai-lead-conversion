import React, { useCallback, useEffect, useState } from 'react';
import { FileSpreadsheet, FileUp, History, Loader2 } from 'lucide-react';
import { toast } from 'react-toastify';
import { importHistory, removeImport, type ImportBatch } from '../../utils/fileImportApi';
import { ISSUE_TEXT } from '../../utils/sheetMapping';
import { SheetError, SheetModal, errorText } from '../sheets/SheetModal';

/**
 * The badge a row wears for where it came from — the same on every screen.
 * `label={false}` is the icon alone, with `title` as the hover text.
 */
export const SourceBadge: React.FC<{ kind: 'google_sheets' | 'file_upload'; label?: boolean; title?: string }> = ({
  kind,
  label = true,
  title,
}) => {
  const file = kind === 'file_upload';
  const Icon = file ? FileUp : FileSpreadsheet;
  return (
    <span
      className={`text-2xs font-bold uppercase rounded border inline-flex items-center gap-1 whitespace-nowrap ${
        label ? 'px-1.5 py-0.5' : 'p-1 cursor-help'
      } ${file ? 'bg-sky-500/15 text-sky-300 border-sky-500/30' : 'bg-green-500/15 text-green-300 border-green-500/30'}`}
      title={title}
      aria-label={title ?? (file ? 'Uploaded file' : 'Google Sheet')}
    >
      <Icon className="w-3 h-3" />
      {label && (file ? 'file' : 'sheet')}
    </span>
  );
};

const skippedText = (skipped: Partial<Record<string, number>> | undefined): string =>
  Object.entries(skipped ?? {})
    .filter(([, n]) => n)
    .map(([code, n]) => `${n} ${(ISSUE_TEXT[code] ?? code).toLowerCase()}`)
    .join(', ');

const link = 'text-2xs font-bold cursor-pointer whitespace-nowrap disabled:opacity-40 disabled:cursor-default';

/**
 * Every import so far — uploaded files and connected sheets — with who started
 * it, what it held, and where its rows stand in review. "Review" narrows
 * Import Review to that one import; "Remove" (uploads only) rejects what is
 * still waiting and takes the upload out of this list.
 */
export const ImportHistoryModal: React.FC<{ onClose: () => void; onReview: (batch: ImportBatch) => void; onChanged: () => void }> = ({
  onClose,
  onReview,
  onChanged,
}) => {
  const [imports, setImports] = useState<ImportBatch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setImports(await importHistory());
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (b: ImportBatch) => {
    setBusy(b.id);
    try {
      const r = await removeImport(b.id);
      toast.success(
        `Removed ${b.name}: ${r.rejected} lead${r.rejected === 1 ? '' : 's'} waiting for review rejected` +
          (r.approvedKept ? `, ${r.approvedKept} approved lead${r.approvedKept === 1 ? '' : 's'} kept` : '') +
          '.',
      );
      setConfirm(null);
      await load();
      onChanged();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <SheetModal
      wide
      title="Import history"
      subtitle="Uploaded files and connected sheets, newest first"
      icon={<History className="w-4 h-4 text-green-400 mt-0.5 shrink-0" />}
      onClose={onClose}
    >
      {error && <SheetError message={error} />}
      {!imports && !error && (
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
        </div>
      )}
      {imports && imports.length === 0 && <div className="text-xs text-slate-400 text-center py-6">Nothing has been imported yet.</div>}
      {imports && imports.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-2xs uppercase text-slate-500 text-left">
              <tr>
                <th className="px-2 py-2">Source</th>
                <th className="px-2 py-2">Name</th>
                <th className="px-2 py-2">When</th>
                <th className="px-2 py-2">By</th>
                <th className="px-2 py-2">Rows</th>
                <th className="px-2 py-2">Review</th>
                <th className="px-2 py-2 w-px" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {imports.map((b) => {
                const r = b.rows;
                const skipped = skippedText(r?.skipped);
                const errors = Object.values(r?.skipped ?? {}).reduce((a, n) => a + (n ?? 0), 0);
                return (
                  <React.Fragment key={b.id}>
                    <tr>
                      <td className="px-2 py-2">
                        <SourceBadge kind={b.kind} />
                      </td>
                      <td className="px-2 py-2 text-slate-100 max-w-[14rem] truncate" title={b.name}>
                        {b.name}
                      </td>
                      <td className="px-2 py-2 text-slate-400 whitespace-nowrap">
                        {new Date(b.completedAt ?? b.createdAt).toLocaleString()}
                      </td>
                      <td className="px-2 py-2 text-slate-400 whitespace-nowrap">
                        {b.importedBy?.name ?? (b.kind === 'google_sheets' ? 'sync' : '—')}
                      </td>
                      <td className="px-2 py-2 text-slate-300 whitespace-nowrap">
                        {r ? (
                          <span
                            title={[
                              `${r.blank ?? 0} blank`,
                              skipped && `not imported: ${skipped}`,
                              `${r.possibleDuplicates ?? 0} possible duplicates`,
                            ]
                              .filter(Boolean)
                              .join('\n')}
                          >
                            {r.imported ?? 0} of {r.total ?? '?'} imported
                            {r.withWarnings ? <span className="text-amber-300"> · {r.withWarnings} warn</span> : null}
                            {errors ? <span className="text-rose-300"> · {errors} errors</span> : null}
                            {r.possibleDuplicates ? <span className="text-amber-300"> · {r.possibleDuplicates} dup</span> : null}
                          </span>
                        ) : (
                          <span className="text-slate-500">see the sheet’s history</span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-slate-300 whitespace-nowrap">
                        <span className="text-amber-200">{b.review.pending} pending</span> ·{' '}
                        <span className="text-emerald-300">{b.review.approved} approved</span> ·{' '}
                        <span className="text-slate-400">{b.review.rejected} rejected</span>
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex items-center gap-3">
                          <button type="button" onClick={() => onReview(b)} className={`${link} text-green-300 hover:text-green-200`}>
                            Review
                          </button>
                          {b.kind === 'file_upload' && (
                            <button
                              type="button"
                              onClick={() => setConfirm(confirm === b.id ? null : b.id)}
                              disabled={busy !== null}
                              className={`${link} text-slate-500 hover:text-rose-300`}
                            >
                              Remove
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {confirm === b.id && (
                      <tr>
                        <td colSpan={7} className="px-2 pb-2">
                          <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-2.5 space-y-2 text-2xs text-rose-200">
                            <div>
                              Remove {b.name}?{' '}
                              {b.review.pending > 0
                                ? `Its ${b.review.pending} lead${b.review.pending === 1 ? '' : 's'} still waiting for review will be rejected — closed, never contacted. `
                                : 'Nothing of it is waiting for review. '}
                              {b.review.approved > 0 ? `The ${b.review.approved} you approved stay as they are. ` : ''}
                              It leaves this list; its rejected rows stay on the Rejected tab.
                            </div>
                            <div className="flex gap-3">
                              <button
                                type="button"
                                className="font-bold text-rose-300 hover:text-rose-200 cursor-pointer disabled:opacity-40"
                                disabled={busy !== null}
                                onClick={() => void remove(b)}
                              >
                                {busy === b.id ? 'Removing…' : 'Remove import'}
                              </button>
                              <button
                                type="button"
                                className={`${link} text-slate-400 hover:text-white`}
                                disabled={busy !== null}
                                onClick={() => setConfirm(null)}
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </SheetModal>
  );
};
