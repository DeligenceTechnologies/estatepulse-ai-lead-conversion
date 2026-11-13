import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Loader2, RefreshCw, Table2 } from 'lucide-react';
import { toast } from 'react-toastify';
import {
  FORM_TARGETS,
  formQuestions,
  saveFormMapping,
  type FormQuestion,
  type FormSource,
} from '../../utils/googleFormsApi';
import { SheetError, SheetModal, errorDetails, errorText } from '../sheets/SheetModal';

/**
 * Mapping a Google Form's questions to lead fields.
 *
 * The same object as the Google Sheets mapping screen — a row per question, a
 * dropdown per row — because to an owner it is the same job. Two rules carry
 * over and matter:
 *
 *   - Nothing is mapped unless it is on screen. A question left on "Don't
 *     import" rides along as an extra field on the lead; it is never guessed
 *     into a column.
 *   - The questions come from the form itself, not from a submission, so a
 *     brand-new form with no responses yet maps exactly like a busy one.
 */

/** Every question is listed; these are the ones a lead cannot do without. */
const CONTACTABLE = ['email', 'phone'];

export const FormMappingModal: React.FC<{
  sourceId: string;
  onClose: () => void;
  onChanged: () => void;
}> = ({ sourceId, onClose, onChanged }) => {
  const [source, setSource] = useState<FormSource | null>(null);
  const [questions, setQuestions] = useState<FormQuestion[]>([]);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<{ message: string; details: string[] } | null>(null);

  const load = useCallback(
    async (refresh = false) => {
      try {
        const data = await formQuestions(sourceId, refresh);
        setSource(data.source);
        setQuestions(data.questions);
        setTargets(Object.fromEntries(data.questions.map((q) => [q.fieldKey, q.target ?? ''])));
        setError(null);
      } catch (e) {
        setError({ message: errorText(e), details: errorDetails(e) });
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [sourceId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  /** A lead field cannot come from two questions at once. */
  const clashes = useMemo(() => {
    const count = new Map<string, number>();
    for (const value of Object.values(targets)) {
      if (!value) continue;
      count.set(value, (count.get(value) ?? 0) + 1);
    }
    return new Set([...count.entries()].filter(([, n]) => n > 1).map(([t]) => t));
  }, [targets]);

  const mapped = useMemo(() => new Set(Object.values(targets).filter(Boolean)), [targets]);
  const contactable = CONTACTABLE.some((t) => mapped.has(t));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveFormMapping(
        sourceId,
        Object.entries(targets)
          .filter(([, target]) => target)
          .map(([sourceFieldKey, targetField]) => ({ sourceFieldKey, targetField })),
      );
      toast.success('Mapping saved.');
      onChanged();
      onClose();
    } catch (e) {
      setError({ message: errorText(e), details: errorDetails(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SheetModal
      wide
      title={source?.name ?? 'Map your form'}
      subtitle="Choose what each question fills in. Anything you leave alone is kept on the lead as an extra field."
      icon={<Table2 className="w-4 h-4 text-green-400 mt-0.5 shrink-0" />}
      onClose={onClose}
    >
      {loading ? (
        <div className="flex items-center gap-2 text-xs text-slate-400 py-6 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Reading your form…
        </div>
      ) : (
        <div className="space-y-3">
          {error && <SheetError message={error.message} details={error.details} />}

          {source?.mappingNeedsReview && (
            <div className="flex items-start gap-2 text-xs text-amber-200 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>
                {source.lastErrorMessage ??
                  'Check these before saving — a question may have been added, renamed or removed since you last mapped this form.'}
              </span>
            </div>
          )}

          <div className="flex items-center justify-between gap-3">
            <span className="text-2xs text-slate-500">
              {questions.length} question{questions.length === 1 ? '' : 's'} on this form
            </span>
            <button
              type="button"
              disabled={refreshing}
              onClick={() => {
                setRefreshing(true);
                void load(true);
              }}
              className="text-2xs font-bold text-slate-400 hover:text-white flex items-center gap-1 cursor-pointer disabled:opacity-40"
            >
              {refreshing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              Check for changes
            </button>
          </div>

          <div className="rounded-xl border border-slate-800 divide-y divide-slate-800 max-h-[22rem] overflow-y-auto">
            {questions.length === 0 && (
              <div className="px-3 py-6 text-xs text-slate-500 text-center">
                This form has no questions yet. Add some in Google Forms, then choose “Check for changes”.
              </div>
            )}
            {questions.map((q) => {
              const value = targets[q.fieldKey] ?? '';
              return (
                <div key={q.fieldKey} className="px-3 py-2.5 flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-semibold text-slate-100 truncate" title={q.label}>
                      {q.label}
                    </div>
                    <div className="text-2xs text-slate-500 truncate">
                      {q.type.toLowerCase().replace(/_/g, ' ')}
                      {q.options.length > 0 && ` · ${q.options.slice(0, 3).join(', ')}${q.options.length > 3 ? '…' : ''}`}
                    </div>
                  </div>
                  <select
                    value={value}
                    onChange={(e) => setTargets((t) => ({ ...t, [q.fieldKey]: e.target.value }))}
                    className={`shrink-0 w-44 bg-slate-950 border rounded-lg px-2 py-1.5 text-xs text-slate-100 cursor-pointer ${
                      value && clashes.has(value) ? 'border-rose-500/60' : 'border-slate-800'
                    }`}
                  >
                    {FORM_TARGETS.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>

          {clashes.size > 0 && (
            <div className="text-xs text-rose-300">
              Two questions are going to the same lead field. Pick one for each.
            </div>
          )}

          {/* The platform's own rule: a lead has to be reachable somehow, or
              nothing we do with it can work. Said before saving, not after. */}
          {!contactable && questions.length > 0 && (
            <div className="flex items-start gap-2 text-xs text-amber-200">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>
                Nothing is mapped to Email or Phone yet. Responses without either cannot become leads — they are recorded and skipped.
              </span>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg text-xs font-bold text-slate-400 hover:text-white cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={saving || clashes.size > 0}
              onClick={save}
              className="px-3 py-1.5 rounded-lg text-xs font-bold bg-green-600 hover:bg-green-500 text-white flex items-center gap-1.5 cursor-pointer disabled:opacity-40"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              Save mapping
            </button>
          </div>
        </div>
      )}
    </SheetModal>
  );
};
