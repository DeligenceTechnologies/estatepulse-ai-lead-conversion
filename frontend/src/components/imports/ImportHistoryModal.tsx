import React, { useCallback, useEffect, useState } from 'react';
import { Contact, FileSpreadsheet, FileUp, History, Inbox, Loader2, Trash2 } from 'lucide-react';
import { toast } from 'react-toastify';
import { importHistory, removeImport, type ImportBatch } from '../../utils/fileImportApi';
import type { ImportKind } from '../../utils/googleSheetsApi';
import { ISSUE_TEXT } from '../../utils/sheetMapping';
import { SheetError, SheetModal, errorText } from '../sheets/SheetModal';
import { Button, IconButton } from '../common/Button';

/**
 * The badge a row wears for where it came from — the same on every screen.
 * `label={false}` is the icon alone, with `title` as the hover text.
 */
const BADGE: Record<ImportKind, { icon: typeof FileUp; cls: string; name: string; word: string }> = {
  google_sheets: { icon: FileSpreadsheet, cls: 'bg-green-500/10 text-green-300 border-green-500/25', name: 'Google Sheet', word: 'Sheet' },
  file_upload: { icon: FileUp, cls: 'bg-sky-500/10 text-sky-300 border-sky-500/25', name: 'Uploaded file', word: 'File' },
  hubspot: { icon: Contact, cls: 'bg-orange-500/10 text-orange-300 border-orange-500/25', name: 'HubSpot', word: 'HubSpot' },
};

export const SourceBadge: React.FC<{ kind: ImportKind; label?: boolean; title?: string }> = ({ kind, label = true, title }) => {
  const b = BADGE[kind] ?? BADGE.google_sheets;
  const Icon = b.icon;
  return (
    <span
      className={`text-2xs font-semibold border inline-flex items-center gap-1 whitespace-nowrap ${
        label ? 'px-2 py-0.5 rounded-full' : 'p-1 rounded-md cursor-help'
      } ${b.cls}`}
      title={title}
      aria-label={title ?? b.name}
    >
      <Icon className="w-3 h-3" />
      {label && b.word}
    </span>
  );
};

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

/** One review figure: a big number over a small label, in its colour. */
const Figure: React.FC<{ value: number; label: string; tone: string }> = ({ value, label, tone }) => (
  <div className="min-w-16 text-center">
    <div className={`text-base font-bold leading-tight ${value ? tone : 'text-slate-500'}`}>{value}</div>
    <div className="text-2xs text-slate-400">{label}</div>
  </div>
);

const skippedText = (skipped: Partial<Record<string, number>> | undefined): string =>
  Object.entries(skipped ?? {})
    .filter(([, n]) => n)
    .map(([code, n]) => `${n} ${(ISSUE_TEXT[code] ?? code).toLowerCase()}`)
    .join(', ');

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
      subtitle="Every file and sheet you imported, newest first."
      icon={<History className="w-4 h-4 text-green-400 mt-0.5 shrink-0" />}
      onClose={onClose}
    >
      {error && <SheetError message={error} />}
      {!imports && !error && (
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
        </div>
      )}
      {imports && imports.length === 0 && (
        <div className="text-center py-10 space-y-3">
          <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/25 flex items-center justify-center mx-auto">
            <Inbox className="w-5 h-5 text-emerald-400" />
          </div>
          <div className="text-xs text-slate-400">Nothing imported yet.</div>
        </div>
      )}
      {imports && imports.length > 0 && (
        <ul className="space-y-2.5 list-none">
          {imports.map((b) => {
            const r = b.rows;
            const skipped = skippedText(r?.skipped);
            const errors = Object.values(r?.skipped ?? {}).reduce((a, n) => a + (n ?? 0), 0);
            const badge = BADGE[b.kind] ?? BADGE.google_sheets;
            const Icon = badge.icon;
            return (
              <li key={b.id} className="bg-slate-950/50 border border-slate-800 rounded-xl hover:border-slate-700 transition-colors">
                <div className="p-4 flex flex-col lg:flex-row lg:items-center gap-4">
                  {/* What and when */}
                  <div className="flex items-start gap-3 min-w-0 flex-1">
                    <span className={`w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 ${badge.cls}`}>
                      <Icon className="w-4 h-4" />
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm font-bold text-white truncate" title={b.name}>
                          {b.name}
                        </span>
                        <SourceBadge kind={b.kind} />
                      </div>
                      <div className="text-2xs text-slate-400 mt-0.5">
                        {when(b.completedAt ?? b.createdAt)}
                        {' · '}
                        {b.importedBy?.name ? `by ${b.importedBy.name}` : b.kind === 'file_upload' ? 'by —' : 'Auto sync'}
                      </div>
                      <div className="text-2xs mt-1.5 flex flex-wrap items-center gap-1.5">
                        {r ? (
                          <>
                            <span
                              className="text-slate-300 font-semibold"
                              title={[`${r.blank ?? 0} blank`, skipped && `Not imported: ${skipped}`].filter(Boolean).join('\n')}
                            >
                              {r.imported ?? 0} of {r.total ?? '?'} rows imported
                            </span>
                            {r.withWarnings ? (
                              <span className="px-1.5 rounded-full bg-amber-500/10 text-amber-300 border border-amber-500/25">
                                {r.withWarnings} warning{r.withWarnings === 1 ? '' : 's'}
                              </span>
                            ) : null}
                            {errors ? (
                              <span className="px-1.5 rounded-full bg-rose-500/10 text-rose-300 border border-rose-500/25" title={skipped}>
                                {errors} skipped
                              </span>
                            ) : null}
                            {r.possibleDuplicates ? (
                              <span className="px-1.5 rounded-full bg-amber-500/10 text-amber-300 border border-amber-500/25">
                                {r.possibleDuplicates} possible duplicate{r.possibleDuplicates === 1 ? '' : 's'}
                              </span>
                            ) : null}
                          </>
                        ) : (
                          <span className="text-slate-400">Keeps syncing from {b.kind === 'hubspot' ? 'HubSpot' : 'the sheet'}</span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Where its rows stand */}
                  <div className="flex items-center gap-1 bg-slate-900/60 border border-slate-800 rounded-xl px-2 py-2 shrink-0">
                    <Figure value={b.review.pending} label="Pending" tone="text-amber-300" />
                    <span className="w-px h-7 bg-slate-800" aria-hidden />
                    <Figure value={b.review.approved} label="Approved" tone="text-green-300" />
                    <span className="w-px h-7 bg-slate-800" aria-hidden />
                    <Figure value={b.review.rejected} label="Rejected" tone="text-rose-300" />
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 shrink-0 lg:w-28">
                    <Button variant="outline" size="sm" onClick={() => onReview(b)}>
                      Review
                    </Button>
                    {b.kind === 'file_upload' && (
                      <IconButton
                        variant="ghost"
                        size="sm"
                        onClick={() => setConfirm(confirm === b.id ? null : b.id)}
                        disabled={busy !== null}
                        className="hover:text-rose-300!"
                        icon={<Trash2 />}
                        aria-label={`Remove ${b.name}`}
                        title="Remove this import"
                      />
                    )}
                  </div>
                </div>

                {confirm === b.id && (
                  <div className="mx-4 mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 space-y-2.5 text-xs text-rose-200">
                    <div>
                      <span className="font-bold">Remove {b.name}?</span>{' '}
                      {b.review.pending > 0
                        ? `${b.review.pending} pending lead${b.review.pending === 1 ? '' : 's'} will be rejected and never contacted.`
                        : 'Nothing is pending.'}
                      {b.review.approved > 0 ? ` ${b.review.approved} approved stay as they are.` : ''}
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="danger"
                        size="sm"
                        disabled={busy !== null && busy !== b.id}
                        loading={busy === b.id}
                        onClick={() => void remove(b)}
                      >
                        {busy === b.id ? 'Removing…' : 'Remove import'}
                      </Button>
                      <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setConfirm(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </SheetModal>
  );
};
