import React, { useEffect, useState } from 'react';
import { BookOpen, Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'react-toastify';
import { messageFor } from '../../lib/api';
import { getKnowledge, knowledgeSize, saveKnowledge, type KnowledgeEntry, type KnowledgeLimits } from '../../utils/knowledgeApi';
import { Button, IconButton } from '../common/Button';

/**
 * What the AI knows about this office: the facts it answers a lead's questions
 * from. The same list is used on calls and in text chats, and anything it does
 * not cover the AI promises to check rather than guessing at.
 */

const EXAMPLES = [
  { title: 'Areas served', body: 'Plano, Frisco, McKinney and Allen.' },
  { title: 'Commission', body: '3% on the listing side, negotiable above $1M.' },
  { title: 'Do you handle rentals?', body: 'Only rentals above $3,000 a month.' },
];

const FALLBACK_LIMITS: KnowledgeLimits = { maxEntries: 25, titleMaxChars: 80, bodyMaxChars: 400, totalMaxChars: 4000 };

export const KnowledgeCard: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [limits, setLimits] = useState<KnowledgeLimits>(FALLBACK_LIMITS);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    getKnowledge()
      .then((r) => {
        setEntries(r.entries);
        setLimits(r.limits);
      })
      .catch((e) => setError(messageFor(e)))
      .finally(() => setLoading(false));
  }, []);

  const update = (next: KnowledgeEntry[]) => {
    setEntries(next);
    setDirty(true);
  };
  const patch = (i: number, p: Partial<KnowledgeEntry>) => update(entries.map((e, k) => (k === i ? { ...e, ...p } : e)));
  const add = () => update([...entries, { title: '', body: '' }]);

  const size = knowledgeSize(entries);
  const overBudget = size > limits.totalMaxChars;
  const incomplete = entries.some((e) => !e.title.trim() || !e.body.trim());
  const invalid = overBudget || incomplete;

  const save = async () => {
    setSaving(true);
    try {
      const r = await saveKnowledge(entries);
      setEntries(r.entries);
      setLimits(r.limits);
      setDirty(false);
      if (r.warning) toast.warn(r.warning);
      else toast.success('Knowledge saved. The AI uses it from the next call or chat.');
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
          <BookOpen className="w-4 h-4 text-emerald-400" />
          Knowledge
        </h3>
        <p className="text-xs text-slate-400 mt-1">
          Facts about your business that the AI answers from, on calls and in text chats — areas you cover, your
          commission, the lenders you work with, the questions you are asked every week. If a lead asks something that
          is not here, the AI says it will check and have an agent confirm instead of guessing.
        </p>
        <p className="text-[11px] text-slate-500 mt-1">
          Use Dynamic Variables below instead for a single value you want to drop into your own prompt text as{' '}
          <span className="font-mono text-slate-400">{'{{key}}'}</span>. Knowledge is for things the AI should answer from.
        </p>
      </div>

      {error && <div className="text-xs text-rose-300 bg-rose-950/40 border border-rose-800/40 rounded-lg px-3 py-2">{error}</div>}

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Loading knowledge…
        </div>
      ) : (
        <>
          {entries.length === 0 ? (
            <div className="border border-dashed border-slate-800 rounded-xl p-4 space-y-2">
              <p className="text-xs text-slate-400">Nothing yet. The AI will say it needs to check on anything a lead asks about your business.</p>
              <p className="text-[11px] text-slate-500">For example:</p>
              <ul className="text-[11px] text-slate-500 space-y-0.5">
                {EXAMPLES.map((e) => (
                  <li key={e.title}>
                    <span className="text-slate-400">{e.title}</span> — {e.body}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <ul className="space-y-2">
              {entries.map((e, i) => (
                <li key={i} className="border border-slate-800 bg-slate-950/60 rounded-xl p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <input
                      value={e.title}
                      onChange={(ev) => patch(i, { title: ev.target.value })}
                      placeholder="Topic or question, e.g. Areas served"
                      maxLength={limits.titleMaxChars}
                      className={`${inputClass} flex-1 font-semibold`}
                    />
                    <IconButton
                      size="sm"
                      className="hover:text-rose-300!"
                      onClick={() => update(entries.filter((_, k) => k !== i))}
                      aria-label="Delete"
                      icon={<Trash2 />}
                    />
                  </div>
                  <textarea
                    value={e.body}
                    onChange={(ev) => patch(i, { body: ev.target.value })}
                    placeholder="What the AI should say, e.g. Plano, Frisco, McKinney and Allen."
                    maxLength={limits.bodyMaxChars}
                    rows={2}
                    className={`${inputClass} resize-y`}
                  />
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-center justify-between gap-3 pt-1 border-t border-slate-800">
            <Button variant="link" onClick={add} disabled={entries.length >= limits.maxEntries} icon={<Plus />}>
              Add fact
            </Button>
            <div className="flex items-center gap-3 min-w-0">
              <span className={`text-[11px] whitespace-nowrap ${overBudget ? 'text-amber-300' : 'text-slate-500'}`}>
                {size} / {limits.totalMaxChars} characters
              </span>
              {incomplete && <span className="text-xs text-amber-300 truncate">Every fact needs a topic and an answer.</span>}
              {overBudget && !incomplete && (
                <span className="text-xs text-amber-300 truncate">That is more than the AI can carry on a call — shorten or remove a few.</span>
              )}
              <Button size="sm" onClick={() => void save()} disabled={!dirty || invalid} loading={saving}>
                {saving ? 'Saving…' : 'Save knowledge'}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
