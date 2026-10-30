import React, { useEffect, useState } from 'react';
import { Brain, Check, HelpCircle, Loader2, Pencil, X } from 'lucide-react';
import { toast } from 'react-toastify';
import { messageFor } from '../../lib/api';
import { formatDateTime } from '../../lib/datetime';
import { getLeadMemory, setLeadAnswer, type LeadMemory, type QuestionStatus } from '../../utils/qualificationApi';

/** Shown by the lead's own cards above (budget, location, timeline, bedrooms, financing). */
const SHOWN_ABOVE = new Set(['timeline', 'location', 'budget', 'bedrooms', 'financing']);

const SOURCE_LABELS: Record<NonNullable<QuestionStatus['answer']>['source'], string> = { call: 'call', sms: 'text', manual: 'edited' };

const cardClass = 'min-w-0 bg-slate-950/60 border border-slate-800 px-3 py-3 sm:px-4 sm:py-3.5 rounded-xl';

/**
 * The rest of what the AI knows about this lead, as more cards in the lead's
 * details grid (the parent's grid lays them out): every other qualification question (answered from a call or
 * a text, or still open for the AI to ask), and the notes from earlier
 * conversations. Custom answers can be corrected here; the AI never overrides
 * that, and clearing one makes it ask again.
 */
export const LeadQualificationMemory: React.FC<{ leadId: string }> = ({ leadId }) => {
  const [memory, setMemory] = useState<LeadMemory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setMemory(null);
    setError(null);
    getLeadMemory(leadId)
      .then(setMemory)
      .catch((e) => setError(messageFor(e)));
  }, [leadId]);

  const save = async (s: QuestionStatus, value: string | null) => {
    setSaving(true);
    try {
      const q = s.question;
      const typed =
        value == null || value.trim() === ''
          ? null
          : q.type === 'number'
            ? Number(value.replace(/[, ]/g, ''))
            : q.type === 'boolean'
              ? /^(y|yes|true)$/i.test(value.trim())
              : value.trim();
      setMemory(await setLeadAnswer(leadId, q.key, typed));
      setEditing(null);
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setSaving(false);
    }
  };

  if (error) return <p className="col-span-full text-xs text-rose-300">{error}</p>;
  if (!memory) {
    return (
      <div className="col-span-full flex items-center gap-2 text-xs text-slate-500">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Loading what the AI knows…
      </div>
    );
  }

  const rows = memory.questions.filter((s) => !SHOWN_ABOVE.has(s.question.key));
  const inputClass = 'flex-1 min-w-0 bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-white';

  return (
    <>
      {rows.map((s) => {
        const q = s.question;
        const isEditing = editing === q.key;
        return (
          <div key={q.key} className={cardClass}>
            <div className="flex items-center gap-1.5 text-xs text-slate-400 mb-1.5 min-w-0">
              <HelpCircle className="w-4 h-4 text-emerald-400 shrink-0" />
              <span className="truncate" title={q.question}>
                {q.label}
              </span>
              {s.answer && !isEditing && (
                <span className="text-[10px] px-1.5 rounded bg-slate-800 text-slate-400 shrink-0" title={formatDateTime(s.answer.at)}>
                  {SOURCE_LABELS[s.answer.source]}
                </span>
              )}
              {!q.builtin && !isEditing && (
                <button
                  type="button"
                  onClick={() => {
                    const v = s.answer?.value;
                    setDraft(v == null ? '' : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v));
                    setEditing(q.key);
                  }}
                  className="ml-auto p-0.5 text-slate-500 hover:text-slate-300 shrink-0"
                  title="Edit answer"
                >
                  <Pencil className="w-3 h-3" />
                </button>
              )}
            </div>
            {isEditing ? (
              <div className="flex items-center gap-1">
                {q.type === 'choice' || q.type === 'boolean' ? (
                  <select value={draft} onChange={(e) => setDraft(e.target.value)} className={inputClass}>
                    <option value="">— not answered —</option>
                    {(q.type === 'boolean' ? ['yes', 'no'] : (q.options ?? [])).map((o) => (
                      <option key={o} value={o}>
                        {q.type === 'boolean' ? (o === 'yes' ? 'Yes' : 'No') : o}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    inputMode={q.type === 'number' ? 'decimal' : undefined}
                    className={inputClass}
                  />
                )}
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void save(s, draft)}
                  className="p-1 text-emerald-400 hover:text-emerald-300"
                  title="Save"
                >
                  <Check className="w-3.5 h-3.5" />
                </button>
                <button type="button" onClick={() => setEditing(null)} className="p-1 text-slate-500 hover:text-slate-300" title="Cancel">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : s.value != null ? (
              <div className="text-sm font-semibold text-slate-100 truncate" title={s.value}>
                {s.value}
              </div>
            ) : (
              <div className="text-sm text-slate-500" title="Not answered yet. The AI asks it on the next call or chat.">
                —
              </div>
            )}
          </div>
        );
      })}

      {memory.summary && (
        <div className={`${cardClass} col-span-full`}>
          <div className="flex items-center gap-1.5 text-xs text-slate-400 mb-1.5">
            <Brain className="w-4 h-4 text-emerald-400" />
            <span>Notes from earlier conversations</span>
            {memory.summaryAt && <span className="ml-auto text-[10px] text-slate-500">Updated {formatDateTime(memory.summaryAt)}</span>}
          </div>
          <div className="text-sm text-slate-100 break-words whitespace-pre-line">{memory.summary}</div>
        </div>
      )}
    </>
  );
};
