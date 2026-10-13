import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, FileUp, Loader2, Upload, X } from 'lucide-react';
import {
  downloadTemplate,
  fileProblem,
  formatBytes,
  getFileImportLimits,
  importFile,
  previewFile,
  type FileImportLimits,
  type FilePreview,
  type ImportBatch,
} from '../../utils/fileImportApi';
import type { ColumnMapping } from '../../utils/googleSheetsApi';
import { CHOICES, ISSUE_TEXT, choicesFromColumns, columnsFromChoices, type ColumnChoice } from '../../utils/sheetMapping';
import { SheetError, SheetModal, errorDetails, errorText } from '../sheets/SheetModal';

const select =
  'w-full bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-green-500/60';
const primary =
  'px-4 py-2 rounded-xl text-xs font-bold bg-green-600 text-white hover:bg-green-500 disabled:opacity-40 disabled:cursor-default cursor-pointer flex items-center justify-center gap-1.5';
const secondary =
  'px-4 py-2 rounded-xl text-xs font-bold bg-slate-800 text-slate-100 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-default cursor-pointer flex items-center justify-center gap-1.5';

/** A mapping as a comparable string: the same pairs in any order are the same mapping. */
const mappingKey = (columns: ColumnMapping[]): string =>
  JSON.stringify([...columns].sort((a, b) => `${a.fieldKey}\u0000${a.target}`.localeCompare(`${b.fieldKey}\u0000${b.target}`)));

const Stat: React.FC<{ label: string; value: number; tone?: 'ok' | 'warn' | 'bad' }> = ({ label, value, tone }) => (
  <div className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
    <div
      className={`text-base font-bold ${
        tone === 'bad' ? 'text-rose-300' : tone === 'warn' ? 'text-amber-300' : tone === 'ok' ? 'text-emerald-300' : 'text-white'
      }`}
    >
      {value.toLocaleString('en-US')}
    </div>
    <div className="text-2xs text-slate-500">{label}</div>
  </div>
);

/** Where an upload stands: sending the bytes (a fraction), then waiting for the server to read them. */
type Progress = { phase: 'preview' | 'import'; fraction: number };

const ProgressBar: React.FC<{ progress: Progress }> = ({ progress }) => {
  const sending = progress.fraction < 1;
  const label = sending
    ? `Uploading… ${Math.round(progress.fraction * 100)}%`
    : progress.phase === 'preview'
      ? 'Reading the file…'
      : 'Importing…';
  return (
    <div className="space-y-1" role="status" aria-live="polite">
      <div className="flex items-center gap-2 text-xs text-slate-400">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> {label}
      </div>
      <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
        <div
          className={`h-full bg-green-500 transition-[width] duration-150 ${sending ? '' : 'animate-pulse'}`}
          style={{ width: `${Math.max(2, Math.round(progress.fraction * 100))}%` }}
        />
      </div>
    </div>
  );
};

/**
 * Upload a CSV or Excel file of leads: choose the file (and, for a workbook,
 * the worksheet), check the server's reading of it (and fix the column mapping
 * if it guessed wrong), then import. Imported leads wait in Import Review;
 * nothing here contacts anyone.
 *
 * The file stays in the browser between the steps — the server parses it for
 * the preview and again for the import, and stores nothing in between.
 */
export const FileImportModal: React.FC<{ onClose: () => void; onImported: (batch: ImportBatch) => void }> = ({ onClose, onImported }) => {
  const [limits, setLimits] = useState<FileImportLimits | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [choices, setChoices] = useState<Record<string, ColumnChoice>>({});
  const [busy, setBusy] = useState<null | 'limits' | 'preview' | 'import'>('limits');
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<{ message: string; details: string[] } | null>(null);
  const [done, setDone] = useState<ImportBatch | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // One token per chosen file and worksheet: a retry of the same import can never make a second batch.
  const token = useRef<string>(crypto.randomUUID());
  // The mapping as the server last read the file under it. Changing a column re-reads.
  const previewed = useRef<string>('');

  useEffect(() => {
    getFileImportLimits()
      .then((l) => {
        setLimits(l);
        setError(null);
      })
      .catch((e) => setError({ message: errorText(e), details: [] }))
      .finally(() => setBusy(null));
  }, []);

  const read = useCallback(async (f: File, columns: ColumnMapping[] | null, ws: string | null) => {
    setBusy('preview');
    setProgress({ phase: 'preview', fraction: 0 });
    setError(null);
    try {
      const p = await previewFile(f, columns, ws, (fraction) => setProgress({ phase: 'preview', fraction }));
      setPreview(p);
      setSheet(p.file.sheet);
      setChoices(choicesFromColumns(p.mapping.columns));
      previewed.current = mappingKey(p.mapping.columns);
    } catch (e) {
      setError({ message: errorText(e), details: errorDetails(e) });
      // Nothing to show yet: back to choosing a file. (With a preview up, it stays, and the error says what went wrong.)
      if (!columns && !ws) {
        setPreview(null);
        setFile(null);
      }
    } finally {
      setProgress(null);
      setBusy(null);
    }
  }, []);

  const choose = (f: File | undefined) => {
    if (!f || !limits) return;
    const problem = fileProblem(f, limits);
    if (problem) {
      setError({ message: problem, details: [] });
      return;
    }
    token.current = crypto.randomUUID();
    setFile(f);
    setSheet(null);
    setPreview(null);
    void read(f, null, null);
  };

  /** Another worksheet of the same workbook: a fresh read, a fresh mapping, a fresh token. */
  const chooseSheet = (ws: string) => {
    if (!file || ws === sheet) return;
    token.current = crypto.randomUUID();
    setSheet(ws);
    void read(file, null, ws);
  };

  // Re-read under the owner's mapping once they stop changing it.
  const columns = useMemo(() => columnsFromChoices(choices), [choices]);
  useEffect(() => {
    if (!file || !preview || busy) return;
    if (mappingKey(columns) === previewed.current) return;
    const t = setTimeout(() => void read(file, columns, sheet), 400);
    return () => clearTimeout(t);
  }, [columns, file, preview, busy, sheet, read]);

  const run = async () => {
    if (!file || !preview) return;
    setBusy('import');
    setProgress({ phase: 'import', fraction: 0 });
    setError(null);
    try {
      const batch = await importFile(file, columns, token.current, sheet, (fraction) => setProgress({ phase: 'import', fraction }));
      setDone(batch);
      onImported(batch);
    } catch (e) {
      setError({ message: errorText(e), details: errorDetails(e) });
    } finally {
      setProgress(null);
      setBusy(null);
    }
  };

  const reset = () => {
    setFile(null);
    setSheet(null);
    setPreview(null);
    setChoices({});
    setError(null);
    setDone(null);
  };

  const canImport = Boolean(preview && preview.mapping.problems.length === 0 && preview.counts.importable > 0 && busy === null);
  const stale = preview !== null && mappingKey(columns) !== previewed.current;
  const multiSheet = (preview?.file.sheets.length ?? 0) > 1;

  return (
    <SheetModal
      wide
      title={done ? 'Imported for review' : file ? file.name : 'Import leads from a file'}
      subtitle={
        done
          ? undefined
          : file
            ? `${formatBytes(file.size)}${preview ? ` · ${preview.file.rows.toLocaleString('en-US')} rows` : ''}${
                preview && multiSheet ? ` · worksheet “${preview.file.sheet}”` : ''
              }`
            : limits
              ? `CSV or Excel (.xlsx), up to ${formatBytes(limits.maxBytes)} and ${limits.maxRows.toLocaleString('en-US')} rows`
              : undefined
      }
      icon={<FileUp className="w-4 h-4 text-green-400 mt-0.5 shrink-0" />}
      onClose={onClose}
    >
      {error && <SheetError message={error.message} details={error.details} />}

      {/* Step 3: done */}
      {done && (
        <div className="space-y-3">
          <div className="flex items-start gap-2 text-xs text-emerald-200 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-2">
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>
              {done.rows?.imported ?? 0} lead{done.rows?.imported === 1 ? '' : 's'} from {done.name} now wait in Import Review. Nobody is
              called or texted until you approve them.
            </span>
          </div>
          {done.rows && (done.rows.possibleDuplicates ?? 0) > 0 && (
            <p className="text-2xs text-amber-300">
              {done.rows.possibleDuplicates} may duplicate a lead you already have — they are marked in the review list.
            </p>
          )}
          {done.rows?.skipped && Object.values(done.rows.skipped).some((n) => n) && (
            <p className="text-2xs text-slate-400">
              Not imported:{' '}
              {Object.entries(done.rows.skipped)
                .filter(([, n]) => n)
                .map(([code, n]) => `${n} — ${(ISSUE_TEXT[code] ?? code).toLowerCase()}`)
                .join('; ')}
              .
            </p>
          )}
          <div className="flex flex-col sm:flex-row gap-2">
            <button type="button" className={secondary} onClick={reset}>
              Import another file
            </button>
            <button type="button" className={primary} onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      )}

      {/* Step 1: choose a file */}
      {!done && !file && (
        <div className="space-y-3">
          <div
            role="button"
            tabIndex={0}
            onClick={() => input.current?.click()}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              choose(e.dataTransfer.files?.[0]);
            }}
            className={`rounded-xl border-2 border-dashed p-8 text-center cursor-pointer transition-colors ${
              dragging ? 'border-green-500/60 bg-green-500/5' : 'border-slate-700 hover:border-slate-500'
            } ${busy === 'limits' || !limits ? 'opacity-50 pointer-events-none' : ''}`}
            aria-label="Choose a CSV or Excel file"
          >
            <Upload className="w-6 h-6 text-slate-500 mx-auto mb-2" />
            <div className="text-xs text-slate-200 font-bold">Drop a file here, or click to browse</div>
            <div className="text-2xs text-slate-500 mt-1">
              The first row must hold the column headings. Phones keep their + and leading zeros.
            </div>
            <input
              ref={input}
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              onChange={(e) => {
                choose(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={downloadTemplate}
              className="text-2xs font-bold text-slate-400 hover:text-white cursor-pointer flex items-center gap-1"
            >
              <Download className="w-3 h-3" /> Download a sample CSV
            </button>
            <button type="button" className={secondary} onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Step 2: preview and mapping */}
      {!done && file && (
        <div className="space-y-4">
          {progress && <ProgressBar progress={progress} />}

          {preview && (
            <>
              {multiSheet && (
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <span className="shrink-0">Worksheet</span>
                  <select
                    className={select}
                    value={sheet ?? preview.file.sheet ?? ''}
                    onChange={(e) => chooseSheet(e.target.value)}
                    disabled={busy !== null}
                  >
                    {preview.file.sheets.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
                <Stat label="rows in file" value={preview.counts.total} />
                <Stat label="will be imported" value={preview.counts.importable} tone="ok" />
                <Stat label="with warnings" value={preview.counts.withWarnings} tone={preview.counts.withWarnings ? 'warn' : undefined} />
                <Stat label="cannot be imported" value={preview.counts.errors} tone={preview.counts.errors ? 'bad' : undefined} />
                <Stat
                  label="possible duplicates"
                  value={preview.counts.possibleDuplicates}
                  tone={preview.counts.possibleDuplicates ? 'warn' : undefined}
                />
                <Stat label="opted out before" value={preview.counts.optedOut} tone={preview.counts.optedOut ? 'bad' : undefined} />
              </div>
              {preview.counts.errors > 0 && (
                <p className="text-2xs text-slate-400">
                  Rows that cannot be imported are left out — they need a name and a usable phone or email:{' '}
                  {Object.entries(preview.counts.skipped)
                    .filter(([, n]) => n)
                    .map(([code, n]) => `${n} ${(ISSUE_TEXT[code] ?? code).toLowerCase()}`)
                    .join(', ')}
                  . Warnings never block an import; the owner sees them in Import Review.
                </p>
              )}

              {/* Columns */}
              <div className="rounded-xl border border-slate-800 overflow-hidden">
                <div className="grid grid-cols-[3rem_1fr_1.3fr] gap-2 px-3 py-2 bg-slate-950/60 text-2xs font-bold uppercase text-slate-500">
                  <span>Col</span>
                  <span>Heading</span>
                  <span>Import as</span>
                </div>
                <div className="max-h-60 overflow-y-auto divide-y divide-slate-800">
                  {preview.headers
                    .filter((h) => h.label)
                    .map((h) => (
                      <div key={h.column} className="grid grid-cols-[3rem_1fr_1.3fr] gap-2 px-3 py-2 items-center">
                        <span className="text-2xs font-mono text-slate-500">{h.column}</span>
                        <span className="text-xs text-slate-100 truncate" title={h.label}>
                          {h.label}
                        </span>
                        {h.duplicate ? (
                          <span className="text-2xs text-amber-300">Heading repeats — rename it in the file</span>
                        ) : (
                          <select
                            className={select}
                            value={choices[h.fieldKey] ?? ''}
                            onChange={(e) => setChoices((c) => ({ ...c, [h.fieldKey]: e.target.value as ColumnChoice }))}
                            aria-label={`Import "${h.label}" as`}
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
              {preview.mapping.problems.length > 0 && (
                <ul className="text-2xs text-amber-300 list-disc pl-4 space-y-0.5">
                  {preview.mapping.problems.map((p) => (
                    <li key={`${p.path}:${p.message}`}>{p.message}</li>
                  ))}
                </ul>
              )}

              {/* Rows */}
              <div className="rounded-xl border border-slate-800 overflow-hidden">
                <div className="px-3 py-2 bg-slate-950/60 text-2xs text-slate-500 flex items-center gap-2">
                  {preview.rows.length < preview.counts.total - preview.counts.blank
                    ? `The first ${preview.rows.length} rows, read under this mapping`
                    : 'Every row, read under this mapping'}
                  {(busy === 'preview' || stale) && <Loader2 className="w-3 h-3 animate-spin" />}
                </div>
                <div className="max-h-64 overflow-y-auto">
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
                      {preview.rows.map((r) => (
                        <tr key={r.rowNumber} className={r.issue ? 'bg-rose-500/5' : ''}>
                          <td className="px-3 py-1.5 text-slate-500 font-mono">{r.rowNumber}</td>
                          <td className="px-3 py-1.5 text-slate-200">
                            {[r.lead?.first_name, r.lead?.last_name].filter(Boolean).join(' ') || '—'}
                          </td>
                          <td className="px-3 py-1.5 text-slate-300">{r.lead?.normalized_phone ?? r.lead?.phone ?? '—'}</td>
                          <td className="px-3 py-1.5 text-slate-300">{r.lead?.email ?? '—'}</td>
                          <td className="px-3 py-1.5">
                            {r.issue ? (
                              <span className="text-rose-300 flex items-center gap-1">
                                <X className="w-3 h-3" /> {ISSUE_TEXT[r.issue] ?? r.issue}
                              </span>
                            ) : r.reviewReasons.length ? (
                              <span className="text-amber-200 flex items-center gap-1 cursor-help" title={r.reviewReasons.join('\n')}>
                                <AlertTriangle className="w-3 h-3" /> Yes, {r.reviewReasons.length} warning
                                {r.reviewReasons.length === 1 ? '' : 's'}
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
            </>
          )}

          <div className="flex flex-col sm:flex-row gap-2">
            <button type="button" className={secondary} onClick={reset} disabled={busy !== null}>
              Choose another file
            </button>
            <button type="button" className={secondary} onClick={onClose} disabled={busy === 'import'}>
              Cancel
            </button>
            <div className="flex-1" />
            <button type="button" className={primary} onClick={() => void run()} disabled={!canImport || stale}>
              {busy === 'import' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileUp className="w-3.5 h-3.5" />}
              {preview
                ? `Import ${preview.counts.importable.toLocaleString('en-US')} lead${preview.counts.importable === 1 ? '' : 's'} for review`
                : 'Import'}
            </button>
          </div>
          <p className="text-2xs text-slate-500">
            Imported leads wait in Import Review. Nobody is called or texted until you approve them.
          </p>
        </div>
      )}
    </SheetModal>
  );
};
