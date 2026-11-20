import React, { useCallback, useEffect, useState } from 'react';
import { Copy, GitMerge, History, Inbox, Undo2 } from 'lucide-react';
import { toast } from 'react-toastify';
import { LEADS_CHANGED_EVENT } from '../../api/client';
import { messageFor } from '../../lib/api';
import { formatDateTime } from '../../lib/datetime';
import {
  CHANNEL_LABEL,
  dismissDuplicate,
  leadDuplicates,
  leadMerges,
  leadSubmissions,
  mergeDuplicate,
  undoMerge,
  type LeadDuplicate,
  type LeadMergeEntry,
  type LeadSubmission,
} from '../../utils/duplicatesApi';
import { Button } from '../common/Button';

const box = 'bg-slate-950/60 border border-slate-800 rounded-xl px-4 py-3';

/**
 * Who this person is across sources, on the lead's overview:
 *  - a banner when another lead looks like the same person, to merge it into this one or dismiss it;
 *  - every time they reached the organization and from where, the original source first;
 *  - leads merged into this one, the latest of which can be undone.
 * Each part hides itself when it has nothing to say or the user may not see it.
 */
export const LeadSourcesPanel: React.FC<{ leadId: string }> = ({ leadId }) => {
  const [dups, setDups] = useState<LeadDuplicate[]>([]);
  const [subs, setSubs] = useState<LeadSubmission[]>([]);
  const [merges, setMerges] = useState<LeadMergeEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);

  const load = useCallback(() => {
    leadDuplicates(leadId).then(setDups, () => setDups([]));
    leadSubmissions(leadId).then(setSubs, () => setSubs([]));
    leadMerges(leadId).then(setMerges, () => setMerges([]));
  }, [leadId]);

  useEffect(() => {
    setDups([]);
    setSubs([]);
    setMerges([]);
    load();
  }, [load]);

  const act = async (key: string, run: () => Promise<unknown>, done: string) => {
    if (armed !== key) return setArmed(key);
    setBusy(key);
    try {
      await run();
      toast.success(done);
      window.dispatchEvent(new Event(LEADS_CHANGED_EVENT));
      load();
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setBusy(null);
      setArmed(null);
    }
  };

  const original = subs.find((s) => s.isOriginal);
  const sourceName = (s: LeadSubmission) => s.source?.name ?? CHANNEL_LABEL[s.channel];

  return (
    <>
      {dups.map((d) => (
        <div key={d.id} className="bg-sky-500/10 border border-sky-500/40 rounded-xl px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-xs text-sky-300 mb-1">
              <Copy className="w-4 h-4" />
              <span>Possibly the same person as another lead</span>
            </div>
            <div className="text-sm text-slate-100 truncate">
              {d.other.name}
              <span className="text-slate-400">
                {' '}
                · {[d.other.phone, d.other.email].filter(Boolean).join(' · ') || 'no contact details'} · {d.other.status.replace(/_/g, ' ')}
              </span>
            </div>
            <div className="text-2xs text-slate-400">
              {d.reasons.join(' · ')} — {d.other.activity.messages} texts, {d.other.activity.calls} calls
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <Button variant="ghost" size="sm" disabled={busy !== null} loading={busy === `x${d.id}`} onClick={() => void act(`x${d.id}`, () => dismissDuplicate(d.id), 'Marked as different people.')} onBlur={() => setArmed(null)}>
              {armed === `x${d.id}` ? 'Click again' : 'Not the same'}
            </Button>
            <Button
              size="sm"
              icon={<GitMerge />}
              disabled={busy !== null}
              loading={busy === `m${d.id}`}
              onBlur={() => setArmed(null)}
              onClick={() => void act(`m${d.id}`, () => mergeDuplicate(d.id, leadId), `Merged — ${d.other.name}'s history is now on this lead.`)}
              title="Keep this lead; move the other lead's texts, calls, meetings and sources here"
            >
              {armed === `m${d.id}` ? 'Click again to merge' : 'Merge into this lead'}
            </Button>
          </div>
        </div>
      ))}

      {subs.length > 0 && (
        <div className={box}>
          <div className="flex items-center gap-1.5 text-xs text-slate-400 mb-2">
            <Inbox className="w-4 h-4 text-emerald-400" />
            <span>
              Sources{original ? ` — first came from ${sourceName(original)}` : ''}
              {subs.length > 1 ? ` · ${subs.length} submissions` : ''}
            </span>
          </div>
          <ol className="space-y-1.5">
            {subs.map((s) => (
              <li key={s.id} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                <span className="text-slate-100 font-medium">{sourceName(s)}</span>
                {s.isOriginal && <span className="px-1.5 rounded bg-emerald-500/15 text-emerald-300 text-2xs font-semibold">Original</span>}
                {s.matchedBy && (
                  <span className="text-2xs text-slate-500" title="Already a lead when this arrived, so it was added here instead of making a new one">
                    matched by {s.matchedBy}
                  </span>
                )}
                <span className="text-2xs text-slate-500 ml-auto">{formatDateTime(s.submittedAt, { dateStyle: 'medium', timeStyle: 'short' })}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {merges.length > 0 && (
        <div className={box}>
          <div className="flex items-center gap-1.5 text-xs text-slate-400 mb-2">
            <History className="w-4 h-4 text-sky-400" />
            <span>Merged into this lead</span>
          </div>
          <ul className="space-y-2">
            {merges.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-2 text-xs">
                <div className="min-w-0 flex-1">
                  <span className={m.undoneAt ? 'text-slate-500 line-through' : 'text-slate-100'}>{m.mergedLead?.name ?? 'A lead'}</span>
                  <span className="text-2xs text-slate-500">
                    {' '}
                    · {formatDateTime(m.createdAt, { dateStyle: 'medium', timeStyle: 'short' })} · moved {m.moved.messages} texts, {m.moved.calls} calls
                    {m.undoneAt ? ` · undone ${formatDateTime(m.undoneAt, { dateStyle: 'medium' })}` : ''}
                  </span>
                </div>
                {m.canUndo && (
                  <Button
                    variant="outline"
                    size="sm"
                    icon={<Undo2 />}
                    disabled={busy !== null}
                    loading={busy === `u${m.id}`}
                    onBlur={() => setArmed(null)}
                    title="Split the two leads again. Texts and calls since the merge stay on this lead."
                    onClick={() => void act(`u${m.id}`, () => undoMerge(m.id), 'Merge undone — the two leads are separate again.')}
                  >
                    {armed === `u${m.id}` ? 'Click again to undo' : 'Undo merge'}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
};
