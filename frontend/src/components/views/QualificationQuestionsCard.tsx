import React, { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, ListChecks, Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'react-toastify';
import { messageFor } from '../../lib/api';
import { getQuestions, keyFor, saveQuestions, type Question, type QuestionType } from '../../utils/qualificationApi';

/**
 * The questions the AI asks this office's leads, in order.
 *
 * Answers are remembered per lead: on the next call the assistant confirms
 * what it already knows and asks only what is still open. Built-in questions
 * feed the lead's score, so they can be turned off but not deleted.
 */

const TYPE_LABELS: Record<QuestionType, string> = {
  text: 'Text',
  number: 'Number',
  boolean: 'Yes / No',
  choice: 'Choice',
};

export const QualificationQuestionsCard: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [dirty, setDirty] = useState(false);
  /** Questions added since the last save; their key is taken from the label when saved. */
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  useEffect(() => {
    getQuestions()
      .then((r) => setQuestions(r.questions))
      .catch((e) => setError(messageFor(e)))
      .finally(() => setLoading(false));
  }, []);

  const update = (next: Question[]) => {
    setQuestions(next);
    setDirty(true);
  };
  const patch = (i: number, p: Partial<Question>) => update(questions.map((q, k) => (k === i ? { ...q, ...p } : q)));
  const move = (i: number, by: -1 | 1) => {
    const j = i + by;
    if (j < 0 || j >= questions.length) return;
    const next = [...questions];
    [next[i], next[j]] = [next[j], next[i]];
    update(next);
  };
  const add = () => {
    const key = keyFor('New question', questions.map((q) => q.key));
    setFresh((f) => new Set(f).add(key));
    update([...questions, { key, label: 'New question', question: '', type: 'text', enabled: true, builtin: false }]);
  };

  const invalid = questions.find(
    (q) => !q.label.trim() || !q.question.trim() || (q.type === 'choice' && !(q.options ?? []).some((o) => o.trim())),
  );

  const save = async () => {
    setSaving(true);
    try {
      const settled = questions.filter((q) => !fresh.has(q.key)).map((q) => q.key);
      const cleaned = questions.map((q) => {
        const key = fresh.has(q.key) ? keyFor(q.label, settled) : q.key;
        if (fresh.has(q.key)) settled.push(key);
        return { ...q, key, options: q.type === 'choice' ? (q.options ?? []).map((o) => o.trim()).filter(Boolean) : undefined };
      });
      const r = await saveQuestions(cleaned);
      setQuestions(r.questions);
      setFresh(new Set());
      setDirty(false);
      if (r.warning) toast.warn(r.warning);
      else toast.success('Questions saved. The AI uses them from the next call or chat.');
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    'w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-600';

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
      <div>
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <ListChecks className="w-4 h-4 text-emerald-400" />
          Qualification Questions
        </h3>
        <p className="text-xs text-slate-400 mt-1">
          The AI asks these one at a time, in this order, on calls and in text chats. Answers are saved on the lead, so
          the next call or chat only confirms what it already knows and asks what is still missing. Follow-up texts can
          use {'{{nextQuestion}}'} for the first open question.
        </p>
      </div>

      {error && <div className="text-xs text-rose-300 bg-rose-950/40 border border-rose-800/40 rounded-lg px-3 py-2">{error}</div>}

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Loading questions…
        </div>
      ) : (
        <>
          <ul className="space-y-2">
            {questions.map((q, i) => (
              <li
                key={q.key}
                className={`border rounded-xl p-3 space-y-2 ${q.enabled ? 'bg-slate-950/60 border-slate-800' : 'bg-slate-950/30 border-slate-800/60 opacity-60'}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
                    <input type="checkbox" checked={q.enabled} onChange={(e) => patch(i, { enabled: e.target.checked })} />
                    Ask
                  </label>
                  <input
                    value={q.label}
                    onChange={(e) => patch(i, { label: e.target.value })}
                    placeholder="Label"
                    maxLength={80}
                    className={`${inputClass} flex-1 min-w-[8rem] font-semibold`}
                  />
                  {q.builtin ? (
                    <span className="text-[11px] px-2 py-1 rounded bg-slate-800 text-slate-400" title="Used in the lead score; can be turned off, not deleted">
                      Built-in
                    </span>
                  ) : (
                    <select
                      value={q.type}
                      onChange={(e) => patch(i, { type: e.target.value as QuestionType })}
                      className="bg-slate-950 border border-slate-800 rounded-lg px-2 py-2 text-xs text-white"
                    >
                      {Object.entries(TYPE_LABELS).map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  )}
                  <div className="flex items-center gap-1 ml-auto">
                    <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="p-1.5 rounded hover:bg-slate-800 disabled:opacity-30 text-slate-400" title="Move up">
                      <ArrowUp className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => move(i, 1)}
                      disabled={i === questions.length - 1}
                      className="p-1.5 rounded hover:bg-slate-800 disabled:opacity-30 text-slate-400"
                      title="Move down"
                    >
                      <ArrowDown className="w-3.5 h-3.5" />
                    </button>
                    {!q.builtin && (
                      <button type="button" onClick={() => update(questions.filter((_, k) => k !== i))} className="p-1.5 rounded hover:bg-rose-950/50 text-rose-400" title="Delete">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
                <input
                  value={q.question}
                  onChange={(e) => patch(i, { question: e.target.value })}
                  placeholder="What the AI asks, e.g. Are you looking for a house or a condo?"
                  maxLength={300}
                  className={inputClass}
                />
                {q.type === 'choice' && !q.builtin && (
                  <input
                    value={(q.options ?? []).join(', ')}
                    onChange={(e) => patch(i, { options: e.target.value.split(',').map((o) => o.trimStart()) })}
                    placeholder="Options, comma separated, e.g. House, Condo, Townhouse"
                    className={inputClass}
                  />
                )}
              </li>
            ))}
          </ul>

          <div className="flex items-center justify-between gap-3 pt-1 border-t border-slate-800">
            <button type="button" onClick={add} className="flex items-center gap-1.5 text-xs text-emerald-300 hover:text-emerald-200 cursor-pointer">
              <Plus className="w-3.5 h-3.5" />
              Add question
            </button>
            <div className="flex items-center gap-3 min-w-0">
              {invalid && <span className="text-xs text-amber-300 truncate">Every question needs a label and text; choices need options.</span>}
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving || !dirty || !!invalid}
                className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-on-accent text-xs font-semibold cursor-pointer shrink-0"
              >
                {saving ? 'Saving…' : 'Save questions'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
