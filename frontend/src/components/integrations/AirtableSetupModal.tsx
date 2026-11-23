import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ArrowLeft, Check, Database, Loader2, Table2, X } from 'lucide-react';
import { toast } from 'react-toastify';
import {
  airtableFieldTypes,
  BASE_ACCESS,
  createAirtableField,
  createAirtableSource,
  importAirtableSource,
  listAirtableBases,
  listAirtableTables,
  isSchemaPermissionError,
  previewAirtableSource,
  RECORD_ISSUE_TEXT,
  removeAirtableSource,
  saveAirtableMapping,
  TARGET_LABELS,
  type AirtableBaseSummary,
  type AirtableColumn,
  type AirtablePreview,
  type AirtableTableSummary,
} from '../../utils/airtableApi';
import { errorDetails, errorText } from '../sheets/SheetModal';

/**
 * Choosing what to sync: base, then table, then an explicit field mapping, then
 * the records.
 *
 * Nothing is mapped that the owner did not map — the field list opens with
 * every field set to "Don't import", and the import button stays shut until the
 * mapping is valid. Imported records wait in Import Review; only the ones
 * ticked here are approved.
 */

type Step = 'base' | 'table' | 'map' | 'review' | 'done';

const DONT_IMPORT = '';

const Shell: React.FC<{ title: string; subtitle?: string; onClose: () => void; onBack?: () => void; children: React.ReactNode; footer?: React.ReactNode }> = ({
  title,
  subtitle,
  onClose,
  onBack,
  children,
  footer,
}) => {
  // Escape closes it, and the page behind stays put while it is open — the same
  // two things every other dialog here does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  // Into document.body, like every other dialog in the app. Left where it is
  // written — inside a card, inside the integrations grid — the panel is laid
  // out against whatever that ancestor happens to be rather than the viewport,
  // and its header ends up clipped off the top of the screen.
  return createPortal(
  <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="airtable-setup-title">
    <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col">
      <div className="flex items-start justify-between gap-3 p-5 border-b border-slate-800">
        <div className="flex items-center gap-2.5 min-w-0">
          {onBack && (
            <button type="button" onClick={onBack} className="text-slate-400 hover:text-white cursor-pointer" aria-label="Back">
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}
          <div className="min-w-0">
            <h2 id="airtable-setup-title" className="text-base font-bold text-white truncate">
              {title}
            </h2>
            {subtitle && <p className="text-xs text-slate-400 truncate">{subtitle}</p>}
          </div>
        </div>
        <button type="button" onClick={onClose} className="text-slate-400 hover:text-white cursor-pointer" aria-label="Close">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-2">{children}</div>
      {footer && <div className="p-4 border-t border-slate-800 flex items-center justify-end gap-3">{footer}</div>}
    </div>
  </div>,
    document.body,
  );
};

const Busy: React.FC<{ what: string }> = ({ what }) => (
  <div className="flex items-center gap-2 text-xs text-slate-400 py-8 justify-center">
    <Loader2 className="w-4 h-4 animate-spin" /> Loading {what}…
  </div>
);

const Problem: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 flex items-start gap-2">
    <AlertTriangle className="w-3.5 h-3.5 text-rose-400 mt-0.5 shrink-0" />
    <div className="text-xs text-rose-200 leading-relaxed">{children}</div>
  </div>
);

export const AirtableSetupModal: React.FC<{ connectionId: string; onClose: () => void; onDone: () => void }> = ({ connectionId, onClose, onDone }) => {
  const [step, setStep] = useState<Step>('base');
  const [bases, setBases] = useState<AirtableBaseSummary[] | null>(null);
  const [base, setBase] = useState<AirtableBaseSummary | null>(null);
  const [tables, setTables] = useState<AirtableTableSummary[] | null>(null);
  const [preview, setPreview] = useState<AirtablePreview | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ imported: number; approved: number; pending: number; skipped: number; moreComing: boolean } | null>(null);
  // Adding a column to Airtable: a separate permission from writing records,
  // so this stays shut rather than failing when it was never granted.
  const [newField, setNewField] = useState<{ name: string; type: string } | null>(null);
  const [fieldTypes, setFieldTypes] = useState<{ type: string; label: string }[]>([]);
  const [schemaDenied, setSchemaDenied] = useState(false);
  const [saved, setSaved] = useState(false);

  /**
   * Picking a table creates the lead source, because the preview needs one.
   * Walking away before saving a mapping would otherwise leave it behind with
   * no mapping and no leads, so closing takes it back out again. A table that
   * was already configured before this modal opened is never touched.
   */
  const close = () => {
    if (sourceId && !saved && preview && preview.source.mappingStatus !== 'CONFIGURED') {
      void removeAirtableSource(sourceId).catch(() => undefined);
    }
    onClose();
  };

  useEffect(() => {
    if (step === 'map' && !fieldTypes.length) void airtableFieldTypes().then(setFieldTypes).catch(() => setFieldTypes([]));
  }, [step, fieldTypes.length]);

  useEffect(() => {
    listAirtableBases(connectionId)
      .then(setBases)
      .catch((e) => setError(errorText(e)));
  }, [connectionId]);

  const pickBase = async (b: AirtableBaseSummary) => {
    setBase(b);
    setStep('table');
    setTables(null);
    setError(null);
    try {
      setTables(await listAirtableTables(connectionId, b.id));
    } catch (e) {
      setError(errorText(e));
    }
  };

  const pickTable = async (t: AirtableTableSummary) => {
    setBusy(true);
    setError(null);
    try {
      const source = await createAirtableSource({ connectionId, baseId: base!.id, tableId: t.id });
      setSourceId(source.id);
      const p = await previewAirtableSource(source.id);
      setPreview(p);
      // Reopen an existing mapping; a new table starts with everything unmapped.
      setMapping(Object.fromEntries(p.fields.map((f) => [f.id, p.mapping.find((m) => m.fieldKey === f.id)?.target ?? DONT_IMPORT])));
      setStep('map');
    } catch (e) {
      toast.error(errorText(e));
      setStep('table');
    } finally {
      setBusy(false);
    }
  };

  const columns: AirtableColumn[] = useMemo(
    () => Object.entries(mapping).filter(([, target]) => target !== DONT_IMPORT).map(([fieldKey, target]) => ({ fieldKey, target })),
    [mapping],
  );

  /**
   * The same rules the server enforces, judged against the mapping ON SCREEN so
   * that fixing a dropdown clears the warning it caused.
   *
   * The preview carries the server's verdict too, but that one is about the
   * mapping already SAVED — empty, for a table being set up — and it never
   * moves while the owner edits. Showing it alongside this left every warning
   * standing no matter what was mapped, and since the import button is gated on
   * exactly this list, a new table could never be imported at all. The server
   * still has the last word when the mapping is saved; see runImport.
   */
  const problems = useMemo(() => {
    const out: string[] = [];
    const claimed = new Set(columns.map((c) => c.target));
    if (!claimed.has('full_name') && !claimed.has('first_name')) out.push('Map a field to the lead’s name.');
    if (!claimed.has('phone') && !claimed.has('email')) out.push('Map at least one way to reach the person: phone or email.');
    const taken = new Map<string, number>();
    for (const c of columns) {
      if (c.target === '__custom__') continue;
      taken.set(c.target, (taken.get(c.target) ?? 0) + 1);
    }
    for (const [target, n] of taken) if (n > 1) out.push(`${TARGET_LABELS[target] ?? target} is filled from more than one field.`);
    // A column Airtable types as a phone number is the table saying the numbers
    // are here. Not mapping it is a slip rather than a decision, and it costs
    // everything: EstatePulse reaches leads by calling and texting, so each one
    // would arrive and be held for having no number.
    const phoneColumn = (preview?.fields ?? []).find((f) => f.type === 'phoneNumber');
    if (phoneColumn && !claimed.has('phone')) {
      out.push(`Map "${phoneColumn.name}" to Phone. EstatePulse reaches leads by calling and texting, so without a number every one of these would be imported and then held.`);
    }
    // A saved mapping can name a column somebody has since deleted in Airtable.
    // The picker cannot offer it, so this is the one check the dropdowns alone
    // would never catch.
    const live = new Set((preview?.fields ?? []).map((f) => f.id));
    for (const c of columns) {
      if (preview && !live.has(c.fieldKey)) out.push(`A mapped field is no longer in this Airtable table.`);
    }
    // Two rules can word the same complaint; one line each is enough, and it
    // keeps the rendered keys unique.
    return [...new Set(out)];
  }, [columns, preview]);

  const addField = async () => {
    if (!sourceId || !newField?.name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { field, fields } = await createAirtableField(sourceId, { name: newField.name.trim(), type: newField.type });
      // The new column is mappable straight away, and starts unmapped like the rest.
      setPreview((p) => (p ? { ...p, fields } : p));
      setMapping((m) => ({ ...m, [field.id]: DONT_IMPORT }));
      setNewField(null);
      toast.success(`Added “${field.name}” to Airtable.`);
    } catch (e) {
      if (isSchemaPermissionError(e)) setSchemaDenied(true);
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const refreshPreview = useCallback(async () => {
    if (!sourceId) return;
    setPreview(await previewAirtableSource(sourceId));
  }, [sourceId]);

  /**
   * Save the mapping, then show what importing it would actually do.
   *
   * These have to be two steps. The preview is built on the SAVED mapping, so
   * until the mapping is stored every record comes back with no name and no way
   * to reach anybody — nothing to tick, and so nothing approved and everything
   * waiting in Import Review. Saving first is also what the Google Sheets setup
   * does, for the same reason.
   */
  const saveAndContinue = async () => {
    if (!sourceId) return;
    setBusy(true);
    setError(null);
    try {
      await saveAirtableMapping(sourceId, columns);
      setSaved(true);
      const p = await previewAirtableSource(sourceId);
      setPreview(p);
      // Clean records start ticked, so the owner confirms a decision instead of
      // making it one record at a time. Anything flagged — no number, a possible
      // duplicate, a do-not-contact match — stays unticked and goes to Import
      // Review, which is the whole point of that queue.
      setTicked(new Set(p.records.filter((r) => !r.issue && r.reviewReasons.length === 0).map((r) => r.recordId)));
      setStep('review');
    } catch (e) {
      // A mapping the server refuses is validation, and it belongs beside the
      // columns it is about rather than in a toast that floats away. Anything
      // else is simply a write that failed, which toasts like every other one.
      const details = errorDetails(e);
      if (details.length) setError([errorText(e), ...details].join(' '));
      else toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const runImport = async () => {
    if (!sourceId) return;
    setBusy(true);
    setError(null);
    try {
      const run = await importAirtableSource(sourceId, [...ticked]);
      setResult({
        imported: run.imported,
        approved: run.approval.approved,
        pending: run.imported - run.approval.approved,
        skipped: run.skipped,
        moreComing: run.moreComing,
      });
      setStep('done');
      toast.success(`Imported ${run.imported} record${run.imported === 1 ? '' : 's'} from Airtable.`);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const button = 'px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-40 disabled:cursor-default';

  if (step === 'base') {
    return (
      <Shell title="Choose an Airtable base" subtitle="Only the bases you gave this integration access to appear here." onClose={close}>
        {error && <Problem>{error}</Problem>}
        {!bases && !error && <Busy what="your bases" />}
        {bases?.length === 0 && (
          <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-4 text-xs text-slate-400 leading-relaxed">
            This Airtable account did not share any bases with EstatePulse. In Airtable, grant the integration access to a base, then reopen this.
          </div>
        )}
        {bases?.map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={() => void pickBase(b)}
            className="w-full text-left bg-slate-950 border border-slate-800/80 hover:border-sky-500/40 rounded-xl p-3 flex items-center gap-3 cursor-pointer"
          >
            <Database className="w-4 h-4 text-sky-400 shrink-0" />
            <span className="text-xs text-slate-200 flex-1 truncate">{b.name}</span>
            {b.permissionLevel && (
              <span className="text-2xs text-slate-500 shrink-0">{BASE_ACCESS[b.permissionLevel] ?? b.permissionLevel}</span>
            )}
          </button>
        ))}
      </Shell>
    );
  }

  if (step === 'table') {
    return (
      <Shell title="Choose a table" subtitle={base?.name} onClose={close} onBack={() => setStep('base')}>
        {error && <Problem>{error}</Problem>}
        {(!tables || busy) && !error && <Busy what={busy ? 'the table' : 'tables'} />}
        {tables?.map((t) => (
          <button
            key={t.id}
            type="button"
            disabled={busy}
            onClick={() => void pickTable(t)}
            className="w-full text-left bg-slate-950 border border-slate-800/80 hover:border-sky-500/40 rounded-xl p-3 flex items-center gap-3 cursor-pointer disabled:opacity-40"
          >
            <Table2 className="w-4 h-4 text-sky-400 shrink-0" />
            <span className="text-xs text-slate-200 flex-1 truncate">{t.name}</span>
            <span className="text-2xs text-slate-500">{t.fieldCount} fields</span>
          </button>
        ))}
      </Shell>
    );
  }

  if (step === 'done') {
    return (
      <Shell
        title="Import finished"
        subtitle={preview?.table.name ?? undefined}
        onClose={onDone}
        footer={
          <button type="button" className={`${button} bg-sky-600 text-white hover:bg-sky-500`} onClick={onDone}>
            Done
          </button>
        }
      >
        <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-4 space-y-2 text-xs text-slate-300">
          <div className="flex justify-between">
            <span className="text-slate-500">Records imported</span>
            <span>{result?.imported ?? 0}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">Approved now</span>
            <span>{result?.approved ?? 0}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">Waiting in Import Review</span>
            <span>{Math.max(0, result?.pending ?? 0)}</span>
          </div>
          {(result?.skipped ?? 0) > 0 && (
            <div className="flex justify-between">
              <span className="text-slate-500">Could not be imported</span>
              <span className="text-amber-300">{result?.skipped}</span>
            </div>
          )}
        </div>
        {result?.moreComing && (
          <p className="text-2xs text-amber-200 leading-relaxed">
            This table holds more records than one import brings in. The rest are being read now and will appear in Import Review
            shortly — you can close this.
          </p>
        )}
        <p className="text-2xs text-slate-500 leading-relaxed">
          Leads you did not tick are held in Import Review and start no outreach until someone approves them.
        </p>
      </Shell>
    );
  }

  // Records the engine would actually write: the rest carry an issue (no name,
  // nobody to reach) and are skipped rather than imported.
  const importable = preview?.records.filter((r) => !r.issue) ?? [];
  // Records that cannot become leads at all, grouped by the reason, so the
  // owner is told what will be left behind instead of finding a smaller number
  // than they expected at the end.
  const unusable = (preview?.records ?? []).filter((r) => r.issue);
  const unusableByReason = [...new Set(unusable.map((r) => r.issue!))].map((issue) => ({
    issue,
    count: unusable.filter((r) => r.issue === issue).length,
  }));
  // Only what is rendered. Ticking a record approves it, and approving releases
  // a lead to outreach, so "all shown" has to mean the ones on screen.
  const shown = importable.slice(0, 25);

  if (step === 'review') {
    return (
      <Shell
        title="Which of these should start outreach?"
        subtitle={preview?.table.name ?? undefined}
        onClose={close}
        onBack={() => setStep('map')}
        footer={
          <>
            <span className="text-2xs text-slate-500 mr-auto">
              {ticked.size > 0 ? `${ticked.size} approved now, the rest wait in Import Review` : 'Everything waits in Import Review'}
            </span>
            <button type="button" className={`${button} bg-slate-800 text-slate-300 hover:bg-slate-700`} onClick={close} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className={`${button} bg-sky-600 text-white hover:bg-sky-500`}
              onClick={() => void runImport()}
              disabled={busy}
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              Import
            </button>
          </>
        }
      >
        {error && <Problem>{error}</Problem>}
        <p className="text-2xs text-slate-500 leading-relaxed">
          Records with nothing against them are already ticked. Anything flagged — no phone number, a possible duplicate, a
          do-not-contact match — is left for you and waits in Import Review.
        </p>
        {importable.length > 0 && (
          <div className="pt-3 space-y-1.5">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold text-slate-300">
                Records ({shown.length} of {importable.length} shown)
              </h3>
              <button
                type="button"
                className="text-2xs font-bold text-slate-400 hover:text-white cursor-pointer"
                onClick={() => setTicked((t) => (t.size === shown.length ? new Set() : new Set(shown.map((r) => r.recordId))))}
              >
                {ticked.size === shown.length && shown.length > 0 ? 'Untick all' : 'Approve all shown'}
              </button>
            </div>
            {shown.map((r) => (
              <label key={r.recordId} className="bg-slate-950 border border-slate-800/80 rounded-xl p-2.5 flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={ticked.has(r.recordId)}
                  onChange={(e) =>
                    setTicked((t) => {
                      const next = new Set(t);
                      if (e.target.checked) next.add(r.recordId);
                      else next.delete(r.recordId);
                      return next;
                    })
                  }
                  className="cursor-pointer"
                />
                <span className="text-xs text-slate-200 flex-1 truncate">
                  {String((r.lead as { first_name?: string } | null)?.first_name ?? '')}{' '}
                  {String((r.lead as { last_name?: string } | null)?.last_name ?? '')}
                </span>
                {r.reviewReasons.length > 0 && <span className="text-2xs text-amber-300 truncate max-w-[14rem]">{r.reviewReasons[0]}</span>}
              </label>
            ))}
          </div>
        )}
        {unusableByReason.length > 0 && (
          <div className="bg-slate-950 border border-amber-500/25 rounded-xl p-3 space-y-1">
            <div className="text-2xs font-bold text-amber-200">
              {unusable.length} record{unusable.length === 1 ? '' : 's'} cannot be imported
            </div>
            {unusableByReason.map(({ issue, count }) => (
              <div key={issue} className="text-2xs text-slate-400 leading-relaxed">
                {count} · {RECORD_ISSUE_TEXT[issue] ?? issue}
              </div>
            ))}
            <p className="text-2xs text-slate-500 leading-relaxed pt-1">
              These are left in Airtable untouched. Fix them there and sync again, and they will come through.
            </p>
          </div>
        )}

        {importable.length === 0 && (
          <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-4 text-xs text-slate-400 leading-relaxed">
            No record in this table has both a name and a way to reach the person, so there is nothing to approve here. Importing still
            records them for review.
          </div>
        )}
      </Shell>
    );
  }

  // Only what is actually rendered. Ticking a record approves it, and approving

  return (
    <Shell
      title="Map Airtable fields to lead fields"
      subtitle={preview?.table.name ?? undefined}
      onClose={close}
      onBack={() => setStep('table')}
      footer={
        <>
          <span className="text-2xs text-slate-500 mr-auto">Nothing is imported until the next step.</span>
          <button type="button" className={`${button} bg-slate-800 text-slate-300 hover:bg-slate-700`} onClick={close} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={`${button} bg-sky-600 text-white hover:bg-sky-500`}
            onClick={() => void saveAndContinue()}
            disabled={busy || problems.length > 0}
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            Save mapping & continue
          </button>
        </>
      }
    >
      {error && <Problem>{error}</Problem>}
      {problems.map((p) => (
        <Problem key={p}>{p}</Problem>
      ))}

      <div className="space-y-1.5">
        {preview?.fields.map((f) => {
          const allowed = f.allowedTargets ?? [];
          return (
            <div key={f.id} className="bg-slate-950 border border-slate-800/80 rounded-xl p-2.5 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-xs text-slate-200 truncate">{f.name}</div>
                <div className="text-2xs text-slate-500">
                  {f.type}
                  {f.readOnly && ' · read-only in Airtable'}
                </div>
              </div>
              <select
                aria-label={`Lead field for the Airtable column ${f.name}`}
                value={mapping[f.id] ?? DONT_IMPORT}
                onChange={(e) => setMapping((m) => ({ ...m, [f.id]: e.target.value }))}
                className="bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-200 px-2 py-1.5 cursor-pointer min-w-[11rem]"
              >
                <option value={DONT_IMPORT}>Don’t import</option>
                {allowed.map((t) => (
                  <option key={t} value={t}>
                    {TARGET_LABELS[t] ?? t}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </div>

      {/* A lead field with nowhere to go in Airtable: offer to make the column,
          rather than leaving the owner to go and do it by hand. */}
      {!schemaDenied && fieldTypes.length > 0 && (
        <div className="pt-2">
          {newField ? (
            <div className="bg-slate-950 border border-sky-500/30 rounded-xl p-3 space-y-2">
              <div className="text-xs font-bold text-slate-200">New Airtable column</div>
              <div className="flex items-center gap-2">
                <input
                  value={newField.name}
                  onChange={(e) => setNewField({ ...newField, name: e.target.value })}
                  placeholder="Column name"
                  maxLength={100}
                  className="flex-1 bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-200 px-2 py-1.5"
                />
                <select
                  value={newField.type}
                  onChange={(e) => setNewField({ ...newField, type: e.target.value })}
                  className="bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-200 px-2 py-1.5 cursor-pointer"
                >
                  {fieldTypes.map((t) => (
                    <option key={t.type} value={t.type}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              <p className="text-2xs text-slate-500 leading-relaxed">
                This adds a column to your Airtable table. Nothing already in Airtable is changed or removed.
              </p>
              <div className="flex justify-end gap-2">
                <button type="button" className="text-2xs font-bold text-slate-400 hover:text-white cursor-pointer" onClick={() => setNewField(null)} disabled={busy}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="text-2xs font-bold text-sky-400 hover:text-sky-300 cursor-pointer disabled:opacity-40"
                  onClick={() => void addField()}
                  disabled={busy || !newField.name.trim()}
                >
                  Create field in Airtable
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="text-2xs font-bold text-sky-400 hover:text-sky-300 cursor-pointer"
              onClick={() => setNewField({ name: '', type: fieldTypes[0]?.type ?? 'singleLineText' })}
            >
              + Create new field in Airtable
            </button>
          )}
        </div>
      )}

      {schemaDenied && (
        <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-3 text-2xs text-slate-400 leading-relaxed">
          This Airtable connection may not add columns. Records still sync both ways — to add columns, reconnect Airtable and approve the schema
          permission.
        </div>
      )}
    </Shell>
  );
};
